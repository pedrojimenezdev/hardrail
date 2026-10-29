# railguard

> **The agent loop that can't run away with your bill.**

[![npm](https://img.shields.io/npm/v/railguard.svg)](https://www.npmjs.com/package/railguard)
[![CI](https://github.com/pedrojimenezdev/railguard-agentkit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pedrojimenezdev/railguard-agentkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/railguard.svg)](LICENSE)

A small, dependency-free toolkit for building production AI agents in
TypeScript — budget guardrails, reliable structured output, typed tool calling
with schema validation, and tenant-safe retrieval. Extracted from real client
work and released for anyone building agents to use, break, and improve.

**Status:** actively maintained, and will keep growing. See
[CHANGELOG.md](CHANGELOG.md) for what's shipped, the [Modules](#modules) table
below for what exists today, and [Contributing](#contributing) if you'd like
to help shape what's next.

## The problem

Frameworks make the demo easy; production is where agents actually break.

- **Runaway cost.** A model that loops on a tool call turns into a four-figure
  invoice overnight, and a `maxSteps` cap alone won't catch it — cost is
  tokens, not iterations. `Budget` is a hard ceiling checked *before* every
  call, so the worst case is bounded by construction.
- **Unreliable structured output.** Ask for JSON and you'll get prose, a
  markdown fence, or a field of the wrong type. `structured()` strips the
  wrapping, validates against your schema, and re-asks with the exact error
  until it parses or gives up loudly.
- **Tool calls the model got wrong.** A tool declares `{ n: number }` and the
  model sends `{ n: "21" }` — a type `JSON.parse` can't catch. `executeTool`
  checks every call against the tool's own JSON Schema before `run()` ever
  sees it, and reports *what* was wrong so the model can correct the call.
- **Cross-tenant data leaks.** Isolation that's a `.filter()` someone forgot
  is isolation that eventually fails. `VectorStore.search(scope, …)` never
  sees another tenant's chunks in the first place.
- **Provider lock-in.** A rewrite you pay for later. One `LLM` interface
  covers Anthropic, DeepSeek, OpenAI, anything OpenAI-compatible, and your
  test mocks.

## Quickstart

```ts
import { createOpenAICompatible, agent, defineTool, Budget } from "railguard";

const llm = createOpenAICompatible({
  baseUrl: "https://api.deepseek.com", // or OpenRouter, vLLM, OpenAI…
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-chat",
});

const multiply = defineTool<{ a: number; b: number }>({
  name: "multiply",
  description: "Multiply two numbers and return the product.",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  run: ({ a, b }) => a * b,
});

const answer = await agent({
  llm,
  tools: [multiply],
  system: "Use the multiply tool for arithmetic. Answer in one short sentence.",
  maxSteps: 6,
  budget: new Budget({ maxTokens: 4000, maxCostUsd: 0.2 }),
});
console.log(answer); // → "6 times 7 is 42."
```

Structured output with any Zod-compatible schema (Zod itself stays out of your
dependency tree — `railguard` only needs `safeParse`):

```ts
import { structured } from "railguard";
import { z } from "zod";

const profile = await structured(llm, {
  system: "Extract the person's name and what they are building.",
  messages: (s) => [
    { role: "system", content: s },
    { role: "user", content: "I'm Ana and I'm building a booking site for villas." },
  ],
  schema: z.object({ name: z.string(), project: z.string() }),
});
```

Streaming, when you want tokens as they arrive:

```ts
for await (const delta of llm.stream!([{ role: "user", content: "Write a haiku." }])) {
  process.stdout.write(delta);
}
```

## Modules

| Module | What it does |
|---|---|
| `agent()` | The loop: system → model → execute tool calls → append → repeat, capped by `maxSteps` + `Budget` |
| `structured()` | JSON out of an LLM, validated, self-corrected on miss (strip fences, re-ask with the error) |
| `defineTool` / `executeTool` | Typed tool registry; the library never trusts model-supplied shapes — JSON validity *and* the declared JSON Schema are both enforced before `run()` sees a call |
| `validateSchema` | The zero-dependency JSON Schema validator behind tool argument checking — usable standalone |
| `rag` (`chunk`, `retrieve`, `inMemoryStore`, `groundPrompt`) | Pluggable vector store + deterministic chunker; search is scoped per tenant |
| `Budget` / `retry` | Token + cost ceilings, exponential backoff with jitter |
| `env` / `redact` | Type-safe env parsing with secret-stripping and redaction |
| `createOpenAICompatible` / `createAnthropic` | fetch-based providers — no SDK dependency |
| `stream()` / `streamToString` | SSE streaming for both providers, parsed with `fetch` + `ReadableStream` |

## How it compares

### vs LangChain

- **Less magic.** No chains, no runnables, no callback manager. `agent()` is a
  `for` loop you can read in one sitting — when it misbehaves you debug your
  own code, not a framework's abstraction stack.
- **Hard guarantees over breadth.** LangChain integrates with far more than
  this does. What it doesn't give you is a cost ceiling that throws *before*
  the call, or retrieval where tenant isolation is structural rather than a
  filter.
- **Nothing to install.** Zero runtime dependencies against a tree of
  hundreds — which matters most when you're the one auditing it for a client.

### vs the raw SDK

- **The SDK gives you one call; production needs the loop around it.** Tool
  dispatch, argument parsing that survives a malformed model response,
  retries, budget accounting — you will write all of it. This is that,
  already tested.
- **Provider-portable by default.** The same `agent()` and `structured()` run
  against Anthropic, DeepSeek, or a mock. Swapping is one line, not a
  migration.
- **Still just `fetch` underneath.** No SDK to pin, no version skew, no
  vendored transport. Drop to the raw API whenever you want — nothing here
  hides it.

## Design principles

- **Zero runtime deps** — `fetch` + `node:test`. TypeScript is the only dev dependency.
- **Strings in, validation out** — model-supplied JSON is never trusted; a malformed
  tool call surfaces as a readable error the model can correct.
- **Hard ceilings, not soft** — `Budget.check()` throws *before* the next call, so
  the worst case is bounded by construction.
- **Isolation by scope, not filter** — `VectorStore.search(scope, …)` never sees
  another tenant's chunks.

## Install

The `railguard` name on the npm registry belongs to an unrelated package, so
install from GitHub, pinned to a release tag:

```bash
npm i github:pedrojimenezdev/railguard-agentkit#v0.2.1
pnpm add github:pedrojimenezdev/railguard-agentkit#v0.2.1
```

The `prepare` script compiles the package on install. Under pnpm 10, allow it
with `"pnpm": { "onlyBuiltDependencies": ["railguard"] }`.

Requires Node.js 20 or newer. It ships both ES modules (`import`) and CommonJS
(`require`), so CommonJS apps work on every Node 20 release, including the ones
before `require()` of ES modules was supported.

## Contributing

This project is built in the open and maintained for the community — bug
reports, feature ideas, and pull requests are all welcome.

### Development

```bash
npm ci
npm test            # native TypeScript execution — needs Node 22.6+
npm run test:compiled   # same suite, compiled first — runs on Node 20
npm run typecheck
npm run build
```

`npm test` uses Node's `--experimental-strip-types`, which does not exist before
Node 22.6. On Node 20, use `npm run test:compiled`; CI runs it on every version
in the matrix so the suite is genuinely verified against the oldest supported Node.

### Branching & release

- **`main`** is the released state of the package — every commit on it is
  something that could be tagged and published to npm. Nothing is pushed to it
  directly; it only moves forward via a PR from `dev`.
- **`dev`** is the integration branch. Feature and fix branches open PRs against
  `dev`, not `main`.
- **The gate:** both branches require CI (`npm run typecheck`, the compiled test
  suite, and `npm run build`, across Node 20 and 22) to pass before a PR can
  merge — enforced as required status checks in each branch's ruleset, named
  `Node 20` and `Node 22`. A red check blocks the merge button.
- Cut a release by opening a PR from `dev` into `main`; once it merges, tag and
  publish from `main`.

### Guidelines

- Keep the zero-runtime-dependency rule. If a change needs a package at
  runtime, it likely belongs as a separate, opt-in integration rather than in
  the core.
- Add tests for new behavior — the suite is fast enough to run on every save,
  and should stay that way.
- Open small, focused PRs against `dev`. They're easier to review and easier
  to revert if something's wrong.

## License

MIT — see [LICENSE](LICENSE).
