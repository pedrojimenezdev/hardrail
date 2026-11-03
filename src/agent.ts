// The loop lives in `run.ts`, where `agentRun()` reports what each step cost.
// `agent()` here stays the one-line answer for callers who only want the text.
export { agent, agentRun } from "./run.ts";
export type { AgentOptions, AgentRun, RunStep, StopReason, ToolCallReport } from "./run.ts";
