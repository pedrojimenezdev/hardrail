import type { ChatMessage, ToolCallResult } from "../llm.ts";
import { prepareToolCall, runPreparedToolCall, type Tool } from "../tools.ts";
import { decideApproval, deniedResult, type ApprovalSource, type ToolApprovalRequest } from "./approval.ts";
import { SKIPPED_RESULT } from "./loop-guard.ts";
import type { ToolCallReport } from "./types.ts";

// Everything the loop does with a reply's tool calls. Each call that is settled
// gets a report entry and a `tool` message answering it in the history.

/** Where tool calls are looked up, decided, reported and answered. */
export interface ToolCallContext extends ApprovalSource {
  tools: Tool<any, unknown>[];
  /** The history; each settled call is answered here. */
  messages: ChatMessage[];
  /** Each settled call is reported here. */
  reports: ToolCallReport[];
}

/**
 * Settle tool calls in order: run the ones allowed to run and answer the ones
 * that were denied. Returns the calls still waiting for an approval — those are
 * left unanswered in the history so a later run can pick them up.
 */
export async function settleToolCalls(calls: ToolCallResult[], ctx: ToolCallContext): Promise<ToolApprovalRequest[]> {
  const pending: ToolApprovalRequest[] = [];
  for (const call of calls) {
    const prepared = prepareToolCall(ctx.tools, call.name, call.arguments);
    if (!prepared.ok) {
      answer(ctx, call, { ok: false, ms: 0 }, prepared.result);
      continue;
    }

    const request: ToolApprovalRequest = { id: call.id, name: call.name, args: prepared.args };
    const verdict = await decideApproval(prepared.tool, request, ctx);
    if (verdict.status === "pending") {
      pending.push(request);
    } else if (verdict.status === "denied") {
      answer(ctx, call, { ok: false, ms: 0, denied: true }, deniedResult(verdict.reason));
    } else {
      const started = performance.now();
      const outcome = await runPreparedToolCall(prepared.tool, prepared.args);
      answer(ctx, call, { ok: outcome.ok, ms: Math.round(performance.now() - started) }, outcome.result);
    }
  }
  return pending;
}

/** Answer every call without running it, so the history stays valid to continue from. */
export function skipToolCalls(calls: ToolCallResult[], ctx: Pick<ToolCallContext, "messages" | "reports">): void {
  for (const call of calls) answer(ctx, call, { ok: false, ms: 0, skipped: true }, SKIPPED_RESULT);
}

/**
 * The tool calls at the end of a history that nothing answered yet: the last
 * assistant message's calls, minus those with a `tool` message after it. That is
 * how a run paused for approval (or stopped by `onStep`) leaves its history.
 */
export function unansweredToolCalls(messages: ChatMessage[]): ToolCallResult[] {
  const answered = new Set<string | undefined>();
  let i = messages.length - 1;
  for (; i >= 0 && messages[i].role === "tool"; i--) answered.add(messages[i].toolCallId);
  const last = messages[i];
  if (last?.role !== "assistant" || !last.toolCalls?.length) return [];
  return last.toolCalls.filter((call) => !answered.has(call.id));
}

function answer(
  ctx: Pick<ToolCallContext, "messages" | "reports">,
  call: ToolCallResult,
  report: Omit<ToolCallReport, "name" | "id">,
  result: unknown,
): void {
  const { ok, ms, ...flags } = report;
  ctx.reports.push({ name: call.name, ok, ms, id: call.id, ...flags });
  ctx.messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok, result }) });
}
