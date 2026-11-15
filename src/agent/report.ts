import type { AgentRun, RunStep, ToolCallReport } from "./types.ts";

/** The run-level totals of a report, derived from its steps and the calls it resumed. */
export function runTotals(
  steps: RunStep[],
  resumedToolCalls: ToolCallReport[],
): Pick<AgentRun, "usage" | "costUsd" | "toolErrors"> {
  const usage = { input: 0, output: 0, cost: 0 };
  let toolErrors = failures(resumedToolCalls);
  for (const step of steps) {
    usage.input += step.usage?.input ?? 0;
    usage.output += step.usage?.output ?? 0;
    usage.cost += step.costUsd;
    toolErrors += failures(step.toolCalls);
  }
  return { usage, costUsd: usage.cost, toolErrors };
}

/** Calls that ran and failed. A skipped or denied call never ran, so it did not fail. */
function failures(calls: ToolCallReport[]): number {
  return calls.filter((call) => !call.ok && !call.skipped && !call.denied).length;
}
