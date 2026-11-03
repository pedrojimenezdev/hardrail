import type { LLM, ChatMessage, LLMReply } from "./llm.ts";
import { executeTool, parseToolArgumentsResult, toolSchema, type Tool } from "./tools.ts";
import type { Budget } from "./budget.ts";

export interface AgentOptions {
  llm: LLM;
  tools?: Tool<any, unknown>[];
  /** Max model→tool→model iterations (default 8). A runaway agent is a bill. */
  maxSteps?: number;
  system: string;
  /** The conversation so far, sent after the system prompt. Never mutated. */
  messages?: ChatMessage[];
  /** Stop the loop when the model requests the same tool call (same name, same
   *  arguments, ignoring key order and whitespace) more than this many times in
   *  one run. Off when omitted. Must be an integer >= 1. */
  maxIdenticalToolCalls?: number;
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
  /** Set when the loop guard stopped the run before this call ran. Such a call
   *  has `ok: false` and `ms: 0` and is not counted in `toolErrors`. */
  skipped?: true;
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
  /** The signal was already aborted when a step began, so that step's model call
   *  was never made. Checked before every step. */
  | "aborted"
  /** The budget was already exhausted when a step began; see `budgetExceeded`. */
  | "budget_exceeded"
  /** A tool call was requested more than `maxIdenticalToolCalls` times; see
   *  `repeatedToolCall`. Checked after the model replies and before any of that
   *  step's calls run, so it takes priority over the budget and the step limit
   *  for that step: `budgetExceeded` stays unset and `text` is empty. */
  | "loop_detected";

export interface AgentRun {
  /** The final answer. Empty when the loop stopped before a step produced text,
   *  or when the budget was already exhausted. */
  text: string;
  steps: RunStep[];
  /** Tokens summed over every model call the loop made. */
  usage: { input: number; output: number; cost: number };
  /** Billed or estimated cost in USD, summed over every model call. */
  costUsd: number;
  stopReason: StopReason;
  /** Number of tool calls that failed — unknown tool, bad arguments, schema
   *  mismatch, or the tool's own `run()` throwing. The model sees each failure
   *  in the message history as `{ ok: false }` and can correct on the next turn.
   *  Calls the loop guard skipped are not counted. */
  toolErrors: number;
  /** The `Budget` error, set whenever `stopReason` is `"budget_exceeded"` —
   *  whether the budget was already exhausted when a step began or a step spent
   *  past the ceiling. The loop stops before the next model call. */
  budgetExceeded?: string;
  /** The history without the system prompt: `opts.messages` plus everything this
   *  run added. To continue, append a user message and pass it back as `messages`.
   *  After `"stopped_by_callback"` the last assistant message may have tool calls
   *  with no results, so do not continue from that history. */
  messages: ChatMessage[];
  /** Set when `stopReason` is `"loop_detected"`: the call that crossed the limit,
   *  with `count` = how many times it was requested, including that last time. */
  repeatedToolCall?: { name: string; arguments: string; count: number };
}

/**
 * Run the loop and return what it cost. The same loop as `agent()` — system →
 * model → execute tool calls → append → repeat — but the answer comes back
 * inside a report: per-step timing, usage and tool calls, plus why it stopped.
 *
 * A budget that is exhausted — already when a step begins, or during a step —
 * returns `stopReason: "budget_exceeded"` with the `Budget` error in
 * `budgetExceeded` and no exception: the caller gets the reason in a form it can
 * log. A budget crossed mid-step ends the run after that step's tool calls — no
 * further model call is made.
 */
export async function agentRun(opts: AgentOptions): Promise<AgentRun> {
  const maxSteps = opts.maxSteps ?? 8;
  const maxIdentical = opts.maxIdenticalToolCalls;
  if (maxIdentical !== undefined && !(Number.isInteger(maxIdentical) && maxIdentical >= 1)) {
    throw new RangeError("maxIdenticalToolCalls must be an integer >= 1");
  }
  const messages: ChatMessage[] = [{ role: "system", content: opts.system }, ...(opts.messages ?? [])];
  const steps: RunStep[] = [];
  let toolErrors = 0;
  let budgetExceeded: string | undefined;
  const callCounts = new Map<string, number>();
  let repeatedToolCall: { name: string; arguments: string; count: number } | undefined;

  const finish = (reason: StopReason, answer: string): AgentRun => ({
    text: reason === "budget_exceeded" ? "" : answer,
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
    ...(repeatedToolCall ? { repeatedToolCall } : {}),
    messages: messages.slice(1),
  });

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) return finish("aborted", "");
    try {
      opts.budget?.check();
    } catch (err) {
      budgetExceeded = (err as Error).message;
      return finish("budget_exceeded", "");
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
    const costUsd = opts.budget ? opts.budget.spent.cost - before : (usage?.cost ?? 0);
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

    if (maxIdentical !== undefined) {
      for (const tc of reply.toolCalls) {
        const key = `${tc.name}\u0000${canonicalArguments(tc.arguments)}`;
        const count = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, count);
        if (count > maxIdentical && !repeatedToolCall) repeatedToolCall = { name: tc.name, arguments: tc.arguments, count };
      }
      if (repeatedToolCall) {
        // Answer every call of this step without running it, so the history stays valid to continue from.
        for (const tc of reply.toolCalls) {
          messages.push({ role: "tool", toolCallId: tc.id, content: JSON.stringify({ ok: false, result: SKIPPED }) });
          record.toolCalls.push({ name: tc.name, ok: false, ms: 0, id: tc.id, skipped: true });
        }
        steps.push(record);
        return finish("loop_detected", "");
      }
    }

    const toolList = opts.tools ?? ([] as Tool<any, unknown>[]);
    for (const tc of reply.toolCalls) {
      const toolStarted = performance.now();
      const outcome = await executeTool(toolList, tc.name, tc.arguments);
      if (!outcome.ok) toolErrors++;
      record.toolCalls.push({ name: tc.name, ok: outcome.ok, ms: Math.round(performance.now() - toolStarted), id: tc.id });
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
      return finish("budget_exceeded", "");
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

/**
 * The loop alone, for callers that only want the answer. Its contract is
 * unchanged: a budget stop, an aborted signal or a repeated tool call throws —
 * the `Budget` error itself, an `AbortError`, or a `Loop detected` error —
 * rather than being returned as text. Use
 * `agentRun()` when you want the stop reason instead of an exception.
 */
export async function agent(opts: AgentOptions): Promise<string> {
  const run = await agentRun(opts);
  if (run.stopReason === "budget_exceeded") throw new Error(run.budgetExceeded);
  if (run.stopReason === "loop_detected") {
    const r = run.repeatedToolCall!;
    throw new Error(`Loop detected: tool ${r.name} was requested ${r.count} times with the same arguments`);
  }
  if (run.stopReason === "aborted") throw new DOMException("The operation was aborted.", "AbortError");
  return run.text;
}

const SKIPPED = "Not run: the loop stopped after repeated identical tool calls.";

/** Arguments in a form where key order and whitespace don't matter. */
function canonicalArguments(raw: string): string {
  const parsed = parseToolArgumentsResult(raw);
  return parsed.ok ? JSON.stringify(sortKeys(parsed.value)) : raw.trim();
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeys(obj[k])]));
  }
  return value;
}
