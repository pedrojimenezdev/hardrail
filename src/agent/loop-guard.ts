import type { ToolCallResult } from "../llm.ts";
import { parseToolArgumentsResult } from "../tools.ts";

/** A tool call the model requested more often than `maxIdenticalToolCalls` allows. */
export interface RepeatedToolCall {
  name: string;
  /** The arguments as the model sent them the time the limit was crossed. */
  arguments: string;
  /** How many times the call was requested, including that last time. */
  count: number;
}

/** What the model is told about a call the guard stopped the run before running. */
export const SKIPPED_RESULT = "Not run: the loop stopped after repeated identical tool calls.";

/**
 * Counts identical tool calls over one run. Two calls are identical when they
 * name the same tool with the same arguments, ignoring key order and
 * whitespace. Every request counts, whatever the call's outcome was.
 */
export class LoopGuard {
  private readonly limit: number;
  private readonly counts = new Map<string, number>();

  constructor(limit: number) {
    if (!(Number.isInteger(limit) && limit >= 1)) {
      throw new RangeError("maxIdenticalToolCalls must be an integer >= 1");
    }
    this.limit = limit;
  }

  /** Count one reply's calls. Returns the first one that crossed the limit, if any. */
  observe(calls: ToolCallResult[]): RepeatedToolCall | undefined {
    let repeated: RepeatedToolCall | undefined;
    for (const call of calls) {
      const key = `${call.name}\u0000${canonicalArguments(call.arguments)}`;
      const count = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, count);
      if (count > this.limit) repeated ??= { name: call.name, arguments: call.arguments, count };
    }
    return repeated;
  }
}

/** Arguments in a form where key order and whitespace don't matter. */
function canonicalArguments(raw: string): string {
  const parsed = parseToolArgumentsResult(raw);
  return parsed.ok ? JSON.stringify(sortKeys(parsed.value)) : raw.trim();
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeys(obj[k])]));
  }
  return value;
}
