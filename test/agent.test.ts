import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, agentRun } from "../src/agent.ts";
import { Budget } from "../src/budget.ts";
import type { LLM, LLMReply, ToolCallResult } from "../src/llm.ts";
import { defineTool, parseToolArguments, executeTool } from "../src/tools.ts";

// A scripted LLM that returns tool calls on step 0 and a final answer on step 1.
function scriptedLLM(steps: (LLMReply)[]): LLM {
  let i = 0;
  return {
    async complete() {
      const r = steps[Math.min(i, steps.length - 1)];
      i++;
      return r;
    },
  };
}

test("parseToolArguments tolerates garbage", () => {
  assert.deepEqual(parseToolArguments("not json"), {});
  assert.deepEqual(parseToolArguments('[1,2]'), {});
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments(""), {});
});

test("executeTool returns a clean outcome", async () => {
  const double = defineTool<{ n: number }>({
    name: "double",
    description: "double a number",
    parameters: { type: "object", properties: { n: { type: "number" } } },
    run: ({ n }) => n * 2,
  });
  const ok = await executeTool([double], "double", '{"n":21}');
  assert.equal(ok.ok, true);
  assert.equal(ok.result, 42);
  const missing = await executeTool([double], "nope", "");
  assert.equal(missing.ok, false);
});

test("agent runs loop until the model stops calling tools", async () => {
  const search = defineTool<{ q: string }>({
    name: "search",
    description: "search",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    run: ({ q }) => `result for ${q}`,
  });
  const llm = scriptedLLM([
    { text: "", toolCalls: [{ id: "1", name: "search", arguments: '{"q":"dogs"}' }] as ToolCallResult[], usage: { input: 1, output: 1 } },
    { text: "dogs are great", usage: { input: 1, output: 1 } },
  ]);
  const out = await agent({
    llm,
    tools: [search],
    system: "You answer questions.",
  });
  assert.equal(out, "dogs are great");
});

test("budget stops a runaway agent", async () => {
  let calls = 0;
  const llm: LLM = {
    async complete() {
      calls++;
      return {
        text: "",
        toolCalls: [{ id: String(calls), name: "x", arguments: "{}" }] as ToolCallResult[],
        usage: { input: 100, output: 100 },
      };
    },
  };
  const budget = new Budget({ maxTokens: 150 });
  const run = await agentRun({ llm, tools: [], system: "s", maxSteps: 4, budget });
  assert.equal(run.stopReason, "budget_exceeded");
  assert.match(String(run.budgetExceeded), /Budget exceeded: 200 tokens >= 150/);
  assert.equal(run.text, "", "the error goes to budgetExceeded, not to the answer");
  assert.equal(calls, 1, "the next model call is never made once the budget is crossed");
  // `agent()` keeps its contract: a budget stop throws, as it always has. A fresh
  // budget spends the first step past the ceiling and throws instead of making
  // the second call.
  calls = 0;
  await assert.rejects(
    () => agent({ llm, tools: [], system: "s", maxSteps: 4, budget: new Budget({ maxTokens: 150 }) }),
    /Budget exceeded: 200 tokens >= 150/,
  );
  assert.equal(calls, 1, "agent() stops before the next model call too");
});

test("agent throws when the budget is already exhausted before the first call", async () => {
  const budget = new Budget({ maxCostUsd: 0.01 });
  budget.record({ input: 0, output: 0, cost: 0.02 });
  await assert.rejects(
    () =>
      agent({
        llm: { async complete() { throw new Error("must not be called"); } },
        system: "s",
        budget,
      }),
    /Budget exceeded: \$0\.0200 >= \$0\.01/,
  );
});

test("agent throws on an abort between steps, like an abort during a model call", async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assert.rejects(
    () =>
      agent({
        llm: { async complete() { calls++; return { text: "x" }; } },
        system: "s",
        signal: ac.signal,
      }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(calls, 0);

  // Aborted during a step: the next step's pre-check throws too.
  const between = new AbortController();
  const llm = scriptedLLM([{ text: "", toolCalls: [{ id: "1", name: "noop", arguments: "{}" }] as ToolCallResult[] }]);
  await assert.rejects(
    () =>
      agent({
        llm,
        tools: [noopTool],
        system: "s",
        signal: between.signal,
        onStep: () => {
          between.abort();
        },
      }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("onStep fires exactly once per step", async () => {
  const llm = scriptedLLM([
    { text: "", toolCalls: [{ id: "1", name: "noop", arguments: "{}" }] as ToolCallResult[], usage: { input: 1, output: 1 } },
    { text: "done", usage: { input: 1, output: 1 } },
  ]);
  const seen: number[] = [];
  await agent({
    llm,
    tools: [],
    system: "s",
    maxSteps: 4,
    onStep: ({ step }) => {
      seen.push(step);
    },
  });
  assert.deepEqual(seen, [0, 1]);
});

test("onStep returning true stops the loop", async () => {
  const llm = scriptedLLM([
    { text: "", toolCalls: [{ id: "1", name: "noop", arguments: "{}" }] as ToolCallResult[], usage: { input: 1, output: 1 } },
  ]);
  let calls = 0;
  const out = await agent({
    llm,
    tools: [],
    system: "s",
    maxSteps: 5,
    onStep: () => {
      calls++;
      return true;
    },
  });
  assert.equal(calls, 1);
  assert.equal(out, "");
});

test("malformed tool arguments surface as a readable failure", async () => {
  const double = defineTool<{ n: number }>({
    name: "double",
    description: "double a number",
    parameters: { type: "object", properties: { n: { type: "number" } } },
    run: ({ n }) => n * 2,
  });

  const broken = await executeTool([double], "double", "{n: 21");
  assert.equal(broken.ok, false);
  assert.match(String(broken.result), /bad arguments/);
  assert.match(String(broken.result), /not valid JSON/);

  const wrongShape = await executeTool([double], "double", "[1,2]");
  assert.equal(wrongShape.ok, false);
  assert.match(String(wrongShape.result), /must be a JSON object, got an array/);

  // An absent argument string is still a legitimate no-arg call.
  const noArgs = await executeTool([double], "double", "");
  assert.equal(noArgs.ok, true);
});

test("executeTool rejects valid JSON that doesn't match the tool's schema", async () => {
  const double = defineTool<{ n: number }>({
    name: "double",
    description: "double a number",
    parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    run: ({ n }) => n * 2,
  });

  const wrongType = await executeTool([double], "double", '{"n":"21"}');
  assert.equal(wrongType.ok, false);
  assert.match(String(wrongType.result), /invalid arguments/);
  assert.match(String(wrongType.result), /expected number, got string/);

  const missingField = await executeTool([double], "double", "{}");
  assert.equal(missingField.ok, false);
  assert.match(String(missingField.result), /required property missing/);
});

test("budget records cost and retry backs off", async () => {
  const b = new Budget({ inputCostPerM: 1, outputCostPerM: 2 });
  b.record({ input: 1_000_000, output: 500_000 });
  assert.equal(b.spent.cost, 2);
  b.check();
});

test("budget uses the billed cost when given, and check() throws once it is reached", () => {
  const b = new Budget({ maxCostUsd: 0.05, inputCostPerM: 1, outputCostPerM: 2 });
  b.record({ input: 1_000_000, output: 0, cost: 0.03 });
  assert.equal(b.spent.cost, 0.03);
  b.check();
  b.record({ input: 10, output: 10, cost: 0.02 });
  assert.throws(() => b.check(), /Budget exceeded: \$0\.0500 >= \$0\.05/);
  const zero = new Budget({ inputCostPerM: 1, outputCostPerM: 2 });
  zero.record({ input: 1_000_000, output: 0, cost: 0 });
  assert.equal(zero.spent.cost, 0, "a reported cost of 0 is used, not replaced by the estimate");
});

// --- agentRun(): the run report -------------------------------------------

const noopTool = defineTool({
  name: "noop",
  description: "does nothing",
  parameters: { type: "object", properties: {} },
  run: () => "ok",
});

test("agentRun reports each step's usage, cost, timing and tool calls", async () => {
  const llm = scriptedLLM([
    { text: "", toolCalls: [{ id: "1", name: "noop", arguments: "{}" }] as ToolCallResult[], usage: { input: 1000, output: 500 } },
    { text: "all done", usage: { input: 800, output: 200 } },
  ]);
  const budget = new Budget({ inputCostPerM: 1, outputCostPerM: 2 });
  const run = await agentRun({ llm, tools: [noopTool], system: "s", budget });

  assert.equal(run.text, "all done");
  assert.equal(run.stopReason, "final");
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[0].index, 0);
  assert.equal(run.steps[0].usage?.input, 1000);
  assert.equal(run.steps[0].costUsd, 0.002, "1000 in × $1/M + 500 out × $2/M");
  assert.deepEqual(
    run.steps[0].toolCalls.map(({ name, ok, id }) => ({ name, ok, id })),
    [{ name: "noop", ok: true, id: "1" }],
  );
  assert.ok(run.steps[0].toolCalls[0].ms >= 0);
  assert.ok(run.steps[0].ms >= 0);
  assert.deepEqual(run.usage, { input: 1800, output: 700, cost: run.costUsd });
  assert.ok(Math.abs(run.costUsd - (0.002 + 0.0012)) < 1e-12, "sums each step's cost");
  assert.equal(run.toolErrors, 0);
  // The report's totals agree with what the Budget actually spent.
  assert.ok(Math.abs(run.costUsd - budget.spent.cost) < 1e-12);
});

test("agentRun uses the provider's billed cost when reported", async () => {
  const llm = scriptedLLM([{ text: "hi", usage: { input: 1000, output: 1000, cost: 0.0009 } }]);
  const run = await agentRun({ llm, system: "s", budget: new Budget({ inputCostPerM: 1, outputCostPerM: 2 }) });
  assert.equal(run.costUsd, 0.0009);
  assert.equal(run.usage.cost, 0.0009);
});

test("agentRun reports the provider's billed cost without a Budget", async () => {
  const llm = scriptedLLM([{ text: "hi", usage: { input: 1000, output: 1000, cost: 0.0009 } }]);
  const run = await agentRun({ llm, system: "s" });
  assert.equal(run.costUsd, 0.0009, "falls back to usage.cost when there is no Budget");
  assert.equal(run.usage.cost, 0.0009);
  assert.equal(run.steps[0].costUsd, 0.0009);

  // No Budget and no reported cost: nothing to measure from, so 0.
  const unpriced = await agentRun({ llm: scriptedLLM([{ text: "hi", usage: { input: 1000, output: 1000 } }]), system: "s" });
  assert.equal(unpriced.costUsd, 0);
});

test("agentRun counts failed tool calls and still finishes", async () => {
  const llm = scriptedLLM([
    {
      text: "",
      toolCalls: [
        { id: "1", name: "noop", arguments: "{}" },
        { id: "2", name: "missing", arguments: "{}" },
      ] as ToolCallResult[],
      usage: { input: 1, output: 1 },
    },
    { text: "recovered", usage: { input: 1, output: 1 } },
  ]);
  const run = await agentRun({ llm, tools: [noopTool], system: "s" });
  assert.equal(run.toolErrors, 1);
  assert.deepEqual(
    run.steps[0].toolCalls.map(({ name, ok }) => ({ name, ok })),
    [
      { name: "noop", ok: true },
      { name: "missing", ok: false },
    ],
  );
  assert.equal(run.text, "recovered");
});

test("agentRun reports why it stopped", async () => {
  const looping = scriptedLLM([{ text: "", toolCalls: [{ id: "1", name: "noop", arguments: "{}" }] as ToolCallResult[], usage: { input: 1, output: 1 } }]);
  const capped = await agentRun({ llm: looping, tools: [noopTool], system: "s", maxSteps: 3 });
  assert.equal(capped.stopReason, "step_limit");
  assert.equal(capped.steps.length, 3);

  const callback = await agentRun({ llm: looping, tools: [noopTool], system: "s", onStep: () => true });
  assert.equal(callback.stopReason, "stopped_by_callback");
  assert.equal(callback.steps.length, 1);

  const ac = new AbortController();
  ac.abort();
  let called = false;
  const aborted = await agentRun({
    llm: { async complete() { called = true; return { text: "x" }; } },
    system: "s",
    signal: ac.signal,
  });
  assert.equal(aborted.stopReason, "aborted");
  assert.equal(called, false, "an aborted run never calls the model");
  assert.equal(aborted.steps.length, 0);
});

test("agentRun reports a budget already exhausted before the loop starts", async () => {
  const budget = new Budget({ maxCostUsd: 0.01 });
  budget.record({ input: 0, output: 0, cost: 0.02 });
  const run = await agentRun({
    llm: { async complete() { throw new Error("must not be called"); } },
    system: "s",
    budget,
  });
  assert.equal(run.stopReason, "budget_exceeded");
  assert.equal(run.steps.length, 0);
  assert.equal(run.text, "");
  // The reason lives in budgetExceeded whether the run starts or ends over budget.
  assert.match(String(run.budgetExceeded), /Budget exceeded: \$0\.0200 >= \$0\.01/);
});

test("agentRun with maxSteps 0 never calls the model", async () => {
  const run = await agentRun({
    llm: { async complete() { throw new Error("must not be called"); } },
    system: "s",
    maxSteps: 0,
  });
  assert.equal(run.stopReason, "step_limit");
  assert.equal(run.text, "");
  assert.deepEqual(run.steps, []);
  assert.deepEqual(run.usage, { input: 0, output: 0, cost: 0 });
});
