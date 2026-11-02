import type { LLM, ChatMessage, LLMReply } from "./llm.ts";
import { executeTool, toolSchema, type Tool } from "./tools.ts";
import type { Budget } from "./budget.ts";

export interface AgentOptions {
  llm: LLM;
  tools?: Tool<any, unknown>[];
  /** Max model→tool→model iterations (default 8). A runaway agent is a bill. */
  maxSteps?: number;
  system: string;
  /**
   * Callback per step — hook for logging/metrics. Return true to stop early.
   */
  onStep?: (step: { step: number; messages: ChatMessage[]; reply: LLMReply }) => boolean | void;
  /** Budget guardrail — when exhausted, the loop stops before another call. */
  budget?: Budget;
  signal?: AbortSignal;
}

export interface ToolCallReport {
  name: string;
  /** False when the tool was unknown, the arguments failed parsing or schema
   *  validation, or `run()` threw. */
  ok: boolean;
  /** Wall-clock time spent executing the call. */
  ms: number;
  /** The model's id for the call, so it can be matched to the message history. */
  id: string;
}

export interface RunStep {
  /** 0-based model call index — same numbering as `onStep`'s `step`. */
  index: number;
  /** Wall-clock time spent in the model call. */
  ms: number;
  /** The call's usage as the provider reported it (absent when it reported none). */
  usage?: { input: number; output: number; cost?: number };
  /** The call's cost: provider-billed when reported, else the per-token estimate. */
  costUsd: number;
  toolCalls: ToolCallReport[];
  /** The model's text for this step. Empty when it answered with tool calls only. */
  text: string;
}

/** Why the loop ended. */
export type StopReason =
  /** The model answered without tool calls. */
  | "final"
  /** The last allowed step still had tool calls; the reply's text was returned as-is.
   *  With `maxSteps: 0` the model is never called and the text is empty. */
  | "step_limit"
  /** `onStep` returned true. */
  | "stopped_by_callback"
  /** The signal was already aborted, so the first model call was never made. */
  | "aborted"
  /** The budget was already exhausted; see `budgetExceeded`. */
  | "budget_exceeded";

export interface AgentRun {
  /** The final answer — exactly what `agent()` returns. */
  text: string;
  steps: RunStep[];
  /** Tokens summed over every model call the loop made. */
  usage: { input: number; output: number; cost: number };
  /** Billed or estimated cost in USD, summed over every model call. */
  costUsd: number;
  stopReason: StopReason;
  /** Number of tool calls that failed — unknown tool, bad arguments, schema
   *  mismatch, or the tool's own `run()` throwing. The model sees each failure
   *  in the message history as `{ ok: false }` and can correct on the next turn. */
  toolErrors: number;
  /** Set when the budget crossed its ceiling during this run; the loop stops
   *  before the next model call. */
  budgetExceeded?: string;
}

/**
 * Run the loop and return what it cost. Same contract as `agent()` — system →
 * model → execute tool calls → append → repeat — but the run's text comes back
 * inside a report: per-step timing, usage and tool calls, plus why it stopped.
 *
 * A budget that is already exhausted when the loop starts returns
 * `stopReason: "budget_exceeded"` with the `Budget` error in `text`, rather than
 * throwing: nothing was spent by this run, and the caller now gets the reason
 * in a form it can log. A budget crossed mid-loop ends the run the same way
 * after the step's tool calls — no further model call is made.
 */
export async function agentRun(opts: AgentOptions): Promise<AgentRun> {
  const maxSteps = opts.maxSteps ?? 8;
  const messages: ChatMessage[] = [{ role: "system", content: opts.system }];
  const steps: RunStep[] = [];
  let toolErrors = 0;
  let budgetExceeded: string | undefined;

  const finish = (reason: StopReason, answer: string): AgentRun => ({
    text: answer,
    steps,
    usage: steps.reduce(
      (acc, s) => ({
        input: acc.input + (s.usage?.input ?? 0),
        output: acc.output + (s.usage?.output ?? 0),
        cost: acc.cost + s.costUsd,
      }),
      { input: 0, output: 0, cost: 0 },
    ),
    costUsd: steps.reduce((acc, s) => acc + s.costUsd, 0),
    stopReason: reason,
    toolErrors,
    ...(budgetExceeded ? { budgetExceeded } : {}),
  });

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) return finish("aborted", "");
    try {
      opts.budget?.check();
    } catch (err) {
      return finish("budget_exceeded", (err as Error).message);
    }

    const started = performance.now();
    const reply = await opts.llm.complete(messages, {
      tools: opts.tools?.length ? opts.tools.map(toolSchema) : undefined,
      signal: opts.signal,
    });
    const ms = Math.round(performance.now() - started);

    const before = opts.budget?.spent.cost ?? 0;
    const usage = reply.usage;
    opts.budget?.record(usage ?? { input: 0, output: 0 });
    const costUsd = (opts.budget?.spent.cost ?? 0) - before;
    const record: RunStep = { index: step, ms, usage, costUsd, toolCalls: [], text: reply.text };

    messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
    if (opts.onStep?.({ step, messages, reply }) === true) {
      steps.push(record);
      return finish("stopped_by_callback", "");
    }

    if (!reply.toolCalls?.length) {
      steps.push(record);
      return finish("final", reply.text);
    }

    const toolList = opts.tools ?? ([] as Tool<any, unknown>[]);
    for (const tc of reply.toolCalls) {
      const toolStarted = performance.now();
      const outcome = await executeTool(toolList, tc.name, tc.arguments);
      const tool = toolList.find((t) => t.name === tc.name);
      const ran = outcome.ok && tool !== undefined;
      if (!ran) toolErrors++;
      record.toolCalls.push({ name: tc.name, ok: ran, ms: Math.round(performance.now() - toolStarted), id: tc.id });
      messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: JSON.stringify({ ok: outcome.ok, result: outcome.result }),
      });
    }

    // A budget crossed during this step ends the run here — no next model call.
    try {
      opts.budget?.check();
    } catch (err) {
      budgetExceeded = (err as Error).message;
      steps.push(record);
      return finish("budget_exceeded", reply.text);
    }
    // Nothing follows the last allowed step, so its text is the best answer we have.
    if (step === maxSteps - 1) {
      steps.push(record);
      return finish("step_limit", reply.text);
    }
    steps.push(record);
  }

  // Unreachable: every path through the loop returns. Kept for the type checker.
  return finish("step_limit", "");
}

/** The loop alone, for callers that only want the answer. */
export async function agent(opts: AgentOptions): Promise<string> {
  return (await agentRun(opts)).text;
}
