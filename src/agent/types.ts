import type { LLM, ChatMessage, LLMReply } from "../llm.ts";
import type { Tool } from "../tools.ts";
import type { Budget } from "../budget.ts";
import type { RepeatedToolCall } from "./loop-guard.ts";

// The public shapes of the agent loop: what goes in (`AgentOptions`) and what
// `agentRun()` hands back (`AgentRun` and its parts).

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
   * `messages` is the loop's live history, system prompt first: changing it
   * changes what the model is sent next and what `AgentRun.messages` reports.
   */
  onStep?: (step: { step: number; messages: ChatMessage[]; reply: LLMReply }) => boolean | void;
  /** Budget guardrail — when exhausted, the loop stops before another call. */
  budget?: Budget;
  /** Forwarded to every model call, and checked before each step. */
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
  | "loop_detected";

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
   *  Calls the loop guard skipped are not counted. */
  toolErrors: number;
  /** The `Budget` error's message, set whenever `stopReason` is `"budget_exceeded"`. */
  budgetExceeded?: string;
  /** The history without the system prompt: `opts.messages` plus everything this
   *  run added, in a new array (the message objects themselves are shared with
   *  `opts.messages`). To continue, append a user message and pass it back as
   *  `messages`. After `"stopped_by_callback"` the last assistant message may
   *  have tool calls with no results, so do not continue from that history. */
  messages: ChatMessage[];
  /** Set when `stopReason` is `"loop_detected"`: the call that crossed the limit,
   *  with `count` = how many times it was requested, including that last time. */
  repeatedToolCall?: RepeatedToolCall;
}
