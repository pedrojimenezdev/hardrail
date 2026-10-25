import { validateSchema, type JSONSchema } from "./schema.ts";

/**
 * Typed tool registry. Tools are the agent's hands — but the model hands them
 * *strings*, so the library never trusts the shape: it coerce-parses arguments,
 * validates them against the declared schema, and lets a tool refuse cleanly.
 */
export interface Tool<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  /** The JSON Schema for the arguments — sent to the LLM as the tool's
   *  signature, and enforced against every call before `run` sees the args. */
  parameters: JSONSchema;
  /** Runs the tool; thrown errors are surfaced to the agent as a failed call. */
  run: (args: TArgs) => Promise<TResult> | TResult;
}

export function defineTool<TArgs, TResult = unknown>(tool: Tool<TArgs, TResult>): Tool<TArgs, TResult> {
  return tool;
}

export function toolSchema(tool: Tool): { name: string; description: string; parameters: unknown } {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

export type ToolArgumentsParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Parse the model's JSON-encoded arguments, reporting *why* a string failed.
 *  The agent feeds that reason back to the model so it can correct the call
 *  instead of silently re-running the tool against an empty object. */
export function parseToolArgumentsResult(raw: string | undefined): ToolArgumentsParse {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `arguments are not valid JSON (${(err as Error).message})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    return { ok: false, error: `arguments must be a JSON object, got ${got}` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Coerce the model's JSON-encoded arguments into an object. Never throws on a
 *  misshapen string — returns {} so the tool can decide. */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  const parsed = parseToolArgumentsResult(raw);
  return parsed.ok ? parsed.value : {};
}

/** Execute a tool by name; wraps errors so the agent sees a readable failure. */
export async function executeTool(
  tools: Tool<any, unknown>[],
  name: string,
  rawArguments: string,
): Promise<{ ok: boolean; result: unknown }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, result: `Unknown tool: ${name}` };
  const parsed = parseToolArgumentsResult(rawArguments);
  if (!parsed.ok) {
    return { ok: false, result: `Tool ${name} received bad arguments: ${parsed.error}` };
  }
  // Catches what JSON.parse can't: a wrong type, a missing required field, a
  // value outside an enum — the gap between "valid JSON" and "what the tool
  // actually declared it needs".
  const validation = validateSchema(tool.parameters, parsed.value);
  if (!validation.ok) {
    return { ok: false, result: `Tool ${name} received invalid arguments: ${validation.errors.join("; ")}` };
  }
  try {
    return { ok: true, result: await tool.run(parsed.value as never) };
  } catch (err) {
    return { ok: false, result: `Tool ${name} failed: ${(err as Error).message}` };
  }
}
