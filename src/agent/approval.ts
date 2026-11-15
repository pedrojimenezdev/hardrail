import type { Tool } from "../tools.ts";

/** A tool call waiting for a decision: what to show whoever approves it. */
export interface ToolApprovalRequest {
  /** The model's id for the call — the key to answer it by in `approvals`. */
  id: string;
  name: string;
  /** The call's arguments, parsed and already valid against the tool's schema. */
  args: Record<string, unknown>;
}

/** A decision on a tool call: `true`/`false`, or an object to give the model a reason. */
export type ToolApproval = boolean | { approved: boolean; reason?: string };

/** Where decisions come from: answers given up front, then a callback to ask. */
export interface ApprovalSource {
  approvals?: Record<string, ToolApproval>;
  approveToolCall?: (request: ToolApprovalRequest) => ToolApproval | Promise<ToolApproval>;
}

export type ApprovalVerdict =
  | { status: "approved" }
  | { status: "denied"; reason?: string }
  /** The tool needs an approval and nobody has given one yet. */
  | { status: "pending" };

/**
 * Decide whether a prepared call may run. A tool without `needsApproval` is
 * approved outright; otherwise the answer in `approvals` wins, then
 * `approveToolCall` is asked, and with neither the call stays pending.
 */
export async function decideApproval(
  tool: Tool<any, unknown>,
  request: ToolApprovalRequest,
  source: ApprovalSource,
): Promise<ApprovalVerdict> {
  const gate = tool.needsApproval;
  const gated = typeof gate === "function" ? await gate(request.args) : gate === true;
  if (!gated) return { status: "approved" };

  // Call ids come from the model, so only the object's own keys are answers.
  const given = source.approvals && Object.hasOwn(source.approvals, request.id) ? source.approvals[request.id] : undefined;
  const answer = given ?? (await source.approveToolCall?.(request));
  if (answer === undefined) return { status: "pending" };
  if (typeof answer === "boolean") return answer ? { status: "approved" } : { status: "denied" };
  return answer.approved === true ? { status: "approved" } : { status: "denied", reason: answer.reason };
}

/** What the model is told about a call that was denied. */
export function deniedResult(reason: string | undefined): string {
  return reason ? `Not run: the call was denied. Reason: ${reason}` : "Not run: the call was denied.";
}
