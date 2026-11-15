import type { AgentRun, RunStep } from "./types.ts";

/** The run-level totals of a report, derived from its steps. */
export function runTotals(steps: RunStep[]): Pick<AgentRun, "usage" | "costUsd" | "toolErrors"> {
  const usage = { input: 0, output: 0, cost: 0 };
  let toolErrors = 0;
  for (const step of steps) {
    usage.input += step.usage?.input ?? 0;
    usage.output += step.usage?.output ?? 0;
    usage.cost += step.costUsd;
    // A call the loop guard skipped never ran, so it did not fail.
    toolErrors += step.toolCalls.filter((call) => !call.ok && !call.skipped).length;
  }
  return { usage, costUsd: usage.cost, toolErrors };
}
