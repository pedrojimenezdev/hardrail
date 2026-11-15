import type { LLM, ChatMessage, LLMReply } from "../llm.ts";
import type { Tool } from "../tools.ts";
import type { Budget } from "../budget.ts";
import type { RepeatedToolCall } from "./loop-guard.ts";
import type { ToolApproval, ToolApprovalRequest } from "./approval.ts";

// The public shapes of the agent loop: what goes in (`AgentOptions`) and what
// `agentRun()` hands back (`AgentRun` and its parts).

export interface AgentOptions {
  llm: LLM;
  tools?: Tool<any, unknown>[];
  /** Max model→tool→model iterations (default 8). A runaway agent is a bill. */
  maxSteps?: number;
  system: string;
  /** The conversation so far, sent after the system prompt. Never mutated. If it
   *  ends with tool calls nothing answered — a run paused for approval, or
   *  stopped by `onStep` — those calls are settled first, before the model is
   *  called: see `AgentRun.resumedToolCalls`. */
  messages?: ChatMessage[];
  /** Stop the loop when the model requests the same tool call (same name, same
   *  arguments, ignoring key order and whitespace) more than this many times in
   *  one run. Off when omitted. Must be an integer >= 1. */
  maxIdenticalToolCalls?: number;
  /**
   * Callback per step — hook for logging/metrics. Return true to stop early.
   * `messages` is the loop's live history, system prompt first: changing it
   * changes what the model is sent next and what `AgentRun.messages` reports.
   */
  onStep?: (step: { step: number; messages: ChatMessage[]; reply: LLMReply }) => boolean | void;
  /** Budget guardrail — when exhausted, the loop stops before another call. */
  budget?: Budget;
  /**
   * Asked before each call to a tool with `needsApproval` — return (or resolve
   * to) the decision. A denied call is not run; the model is told so and the
   * loop goes on. Without this, such a call pauses the run with
   * `stopReason: "approval_required"`.
   */
  approveToolCall?: (request: ToolApprovalRequest) => ToolApproval | Promise<ToolApproval>;
  /**
   * Decisions made ahead of time, keyed by tool call id — how a run paused with
   * `"approval_required"` is resumed: pass its `messages` back with a decision
   * for each of its `pendingApprovals`. Takes priority over `approveToolCall`.
   */
  approvals?: Record<string, ToolApproval>;
  /** Forwarded to every model call, and checked before each step. */
  signal?: AbortSignal;
}

export interface ToolCallReport {
  name: string;
  /** False when the tool was unknown, the arguments failed parsing or schema
   *  validation, `run()` threw, or the call was denied or skipped. */
  ok: boolean;
  /** Wall-clock time spent executing the call. */
  ms: number;
  /** The model's id for the call, so it can be matched to the message history. */
  id: string;
  /** Set when the loop guard stopped the run before this call ran. Such a call
   *  has `ok: false` and `ms: 0` and is not counted in `toolErrors`. */
  skipped?: true;
  /** Set when the call needed an approval and was denied. Such a call has
   *  `ok: false` and `ms: 0` and is not counted in `toolErrors`. */
  denied?: true;
}

export interface RunStep {
  /** 0-based model call index — same numbering as `onStep`'s `step`. */
  index: number;
  /** Wall-clock time spent in the model call. */
  ms: number;
  /** The call's usage as the provider reported it (absent when it reported none). */
  usage?: { input: number; output: number; cost?: number };
  /** The model call's cost: provider-billed when reported, else the per-token
   *  estimate. Spend that tools add to the same `Budget` is not included. */
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
  /** The signal was aborted: either before a step began, so that step's model
   *  call was never made, or during a model call, whose reply is then lost. The
   *  steps completed before the abort are still reported. */
  | "aborted"
  /** The budget was at its ceiling when a step was about to begin — exhausted
   *  before the run, or spent past by the previous step. That step's model call
   *  was never made; see `budgetExceeded`. */
  | "budget_exceeded"
  /** A tool call was requested more than `maxIdenticalToolCalls` times; see
   *  `repeatedToolCall`. Checked after the model replies and before any of that
   *  step's calls run, so it takes priority over the budget and the step limit
   *  for that step: `budgetExceeded` stays unset and `text` is empty. */
  | "loop_detected"
  /** A tool with `needsApproval` was called and nothing decided the call — no
   *  entry in `approvals`, no `approveToolCall`. The step's other calls ran; the
   *  waiting ones are in `pendingApprovals`, unanswered in `messages`. Takes
   *  priority over the step limit. Resume by passing `messages` back with
   *  `approvals`. */
  | "approval_required";

export interface AgentRun {
  /** The final answer. Empty unless `stopReason` is `"final"` or `"step_limit"`. */
  text: string;
  steps: RunStep[];
  /** Tokens and cost summed over every model call the loop made. */
  usage: { input: number; output: number; cost: number };
  /** Billed or estimated cost in USD, summed over every model call the loop
   *  made — always equal to `usage.cost`. */
  costUsd: number;
  stopReason: StopReason;
  /** Number of tool calls that failed — unknown tool, bad arguments, schema
   *  mismatch, or the tool's own `run()` throwing. The model sees each failure
   *  in the message history as `{ ok: false }` and can correct on the next turn.
   *  Calls the loop guard skipped and calls that were denied are not counted. */
  toolErrors: number;
  /** The `Budget` error's message, set whenever `stopReason` is `"budget_exceeded"`. */
  budgetExceeded?: string;
  /** The history without the system prompt: `opts.messages` plus everything this
   *  run added, in a new array (the message objects themselves are shared with
   *  `opts.messages`). To continue, append a user message and pass it back as
   *  `messages`. After `"approval_required"` or `"stopped_by_callback"` the
   *  last assistant message may have tool calls with no results; the next run
   *  settles them before it calls the model. */
  messages: ChatMessage[];
  /** Set when `stopReason` is `"loop_detected"`: the call that crossed the limit,
   *  with `count` = how many times it was requested, including that last time. */
  repeatedToolCall?: RepeatedToolCall;
  /** Set when `stopReason` is `"approval_required"`: the calls waiting for a
   *  decision. Answer each by its `id` in the next run's `approvals`. */
  pendingApprovals?: ToolApprovalRequest[];
  /** Set when `opts.messages` ended with unanswered tool calls: what happened to
   *  each one this run settled before its first model call. They belong to no
   *  step, and their failures count in `toolErrors`. */
  resumedToolCalls?: ToolCallReport[];
}
