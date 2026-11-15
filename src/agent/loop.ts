import type { ChatMessage, LLMReply } from "../llm.ts";
import { toolSchema } from "../tools.ts";
import type { Budget } from "../budget.ts";
import type { ToolApprovalRequest } from "./approval.ts";
import { LoopGuard, type RepeatedToolCall } from "./loop-guard.ts";
import { runTotals } from "./report.ts";
import { settleToolCalls, skipToolCalls, unansweredToolCalls, type ToolCallContext } from "./tool-calls.ts";
import type { AgentOptions, AgentRun, RunStep, StopReason, ToolCallReport } from "./types.ts";

const DEFAULT_MAX_STEPS = 8;

/** A finished loop: the report, plus the error behind the stop when there was one. */
export interface LoopOutcome {
  run: AgentRun;
  /** What was thrown to cause a `"budget_exceeded"` or `"aborted"` stop, exactly
   *  as thrown, so `agent()` can rethrow it. Unset when the signal was found
   *  aborted between steps: nothing threw. */
  cause?: unknown;
}

/**
 * The agent loop: system → model → execute tool calls → append → repeat, until
 * the model answers without tool calls or something stops it. Each step runs
 * in this order:
 *
 *   1. stop if the signal is aborted or the budget is at its ceiling
 *   2. call the model and record what it spent
 *   3. `onStep` — may stop the run
 *   4. no tool calls → that is the final answer
 *   5. loop guard — may stop the run before any of the step's calls run
 *   6. run the tool calls — one that needs an approval nobody gave pauses the run
 *
 * Running out of steps ends the loop with the last reply's text. Before the
 * first step, tool calls left unanswered at the end of `opts.messages` are
 * settled the same way as in (6), so a paused run picks up where it stopped.
 */
export async function runLoop(opts: AgentOptions): Promise<LoopOutcome> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const guard = opts.maxIdenticalToolCalls === undefined ? undefined : new LoopGuard(opts.maxIdenticalToolCalls);
  const system: ChatMessage = { role: "system", content: opts.system };
  const messages: ChatMessage[] = [system, ...(opts.messages ?? [])];
  const steps: RunStep[] = [];
  const resumedToolCalls: ToolCallReport[] = [];
  const toolCalls = (reports: ToolCallReport[]): ToolCallContext => ({
    tools: opts.tools ?? [],
    messages,
    reports,
    approvals: opts.approvals,
    approveToolCall: opts.approveToolCall,
  });

  const stop = (
    stopReason: StopReason,
    text: string,
    detail: {
      cause?: unknown;
      budgetExceeded?: string;
      repeatedToolCall?: RepeatedToolCall;
      pendingApprovals?: ToolApprovalRequest[];
    } = {},
  ): LoopOutcome => ({
    run: {
      text,
      steps,
      ...runTotals(steps, resumedToolCalls),
      stopReason,
      ...(detail.budgetExceeded !== undefined ? { budgetExceeded: detail.budgetExceeded } : {}),
      // Dropped by identity, not position: `onStep` is handed the live array.
      messages: messages.filter((message) => message !== system),
      ...(detail.repeatedToolCall ? { repeatedToolCall: detail.repeatedToolCall } : {}),
      ...(detail.pendingApprovals ? { pendingApprovals: detail.pendingApprovals } : {}),
      ...(resumedToolCalls.length ? { resumedToolCalls } : {}),
    },
    ...(detail.cause !== undefined ? { cause: detail.cause } : {}),
  });

  const unanswered = unansweredToolCalls(messages);
  if (unanswered.length) {
    if (opts.signal?.aborted) return stop("aborted", "");
    const pendingApprovals = await settleToolCalls(unanswered, toolCalls(resumedToolCalls));
    if (pendingApprovals.length) return stop("approval_required", "", { pendingApprovals });
  }

  let lastText = "";
  for (let index = 0; index < maxSteps; index++) {
    if (opts.signal?.aborted) return stop("aborted", "");
    const exhausted = budgetFailure(opts.budget);
    if (exhausted) return stop("budget_exceeded", "", { cause: exhausted.error, budgetExceeded: errorMessage(exhausted.error) });

    const started = performance.now();
    let reply: LLMReply;
    try {
      reply = await opts.llm.complete(messages, {
        tools: opts.tools?.length ? opts.tools.map(toolSchema) : undefined,
        signal: opts.signal,
      });
    } catch (err) {
      // An abort during the call ends the run; any other failure is the caller's to handle.
      if (opts.signal?.aborted) return stop("aborted", "", { cause: err });
      throw err;
    }

    const step: RunStep = {
      index,
      ms: elapsedMs(started),
      usage: reply.usage,
      costUsd: recordSpend(opts.budget, reply.usage),
      toolCalls: [],
      text: reply.text,
    };
    steps.push(step);
    lastText = reply.text;

    messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
    if (opts.onStep?.({ step: index, messages, reply }) === true) return stop("stopped_by_callback", "");

    if (!reply.toolCalls?.length) return stop("final", reply.text);

    const repeatedToolCall = guard?.observe(reply.toolCalls);
    if (repeatedToolCall) {
      skipToolCalls(reply.toolCalls, { messages, reports: step.toolCalls });
      return stop("loop_detected", "", { repeatedToolCall });
    }

    const pendingApprovals = await settleToolCalls(reply.toolCalls, toolCalls(step.toolCalls));
    if (pendingApprovals.length) return stop("approval_required", "", { pendingApprovals });
  }

  // Nothing follows the last allowed step, so its text is the best answer we have.
  return stop("step_limit", lastText);
}

/** The error `budget.check()` throws when the budget is at its ceiling, if it is. */
function budgetFailure(budget: Budget | undefined): { error: unknown } | undefined {
  try {
    budget?.check();
    return undefined;
  } catch (error) {
    return { error };
  }
}

/**
 * Record a model call on the budget and return what the call cost. With a
 * budget, that is the change in `spent.cost` across the record — the billed
 * cost when the provider reported one, else the budget's per-token estimate.
 * Without one there are no prices to estimate from, so only a billed cost counts.
 */
function recordSpend(budget: Budget | undefined, usage: LLMReply["usage"]): number {
  if (!budget) return usage?.cost ?? 0;
  const before = budget.spent.cost;
  budget.record(usage ?? { input: 0, output: 0 });
  return budget.spent.cost - before;
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
