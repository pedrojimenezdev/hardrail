import { runLoop } from "./agent/loop.ts";
import type { AgentOptions, AgentRun } from "./agent/types.ts";

export type { AgentOptions, AgentRun, RunStep, StopReason, ToolCallReport } from "./agent/types.ts";
export type { RepeatedToolCall } from "./agent/loop-guard.ts";

/**
 * Run the agent loop and return what it cost: the answer inside a report with
 * per-step timing, usage and tool calls, plus why the loop stopped.
 *
 * A stop is returned, not thrown. An exhausted budget gives
 * `stopReason: "budget_exceeded"` with the `Budget` error's message in
 * `budgetExceeded`; an aborted signal gives `"aborted"`, whether it was aborted
 * between steps or during a model call. Either way the steps already paid for
 * are in the report. Any other error from the model call is rethrown as is.
 */
export async function agentRun(opts: AgentOptions): Promise<AgentRun> {
  return (await runLoop(opts)).run;
}

/**
 * The same loop, for callers that only want the answer. Where `agentRun()`
 * reports a stop, this throws: the `Budget` error itself on a budget stop, an
 * `AbortError` on an aborted signal (the provider's own when the abort landed
 * during a model call), and a `Loop detected` error on a repeated tool call.
 */
export async function agent(opts: AgentOptions): Promise<string> {
  const { run, cause } = await runLoop(opts);
  switch (run.stopReason) {
    case "budget_exceeded":
      throw cause;
    case "aborted":
      throw cause ?? new DOMException("The operation was aborted.", "AbortError");
    case "loop_detected": {
      const { name, count } = run.repeatedToolCall!;
      throw new Error(`Loop detected: tool ${name} was requested ${count} times with the same arguments`);
    }
    default:
      return run.text;
  }
}
