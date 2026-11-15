# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-03

### Added

- **Tool approval — human-in-the-loop for the agent loop.** A tool with
  `needsApproval` (`true`, or a function of its validated arguments) is not run
  until someone approves the call. Pass `approveToolCall` to be asked inline, or
  leave it out and `agentRun()` pauses with `stopReason: "approval_required"`
  and the waiting calls in `pendingApprovals`; pass `run.messages` back with
  `approvals` (keyed by call id) to resume. A denied call is answered for the
  model without running, reported with `denied: true`, and not counted in
  `toolErrors`. `agent()` throws `Approval required` when it has nobody to ask.
- **Unanswered tool calls at the end of `messages` are settled first.** A history
  from a run that paused for approval or was stopped by `onStep` can be passed
  back: those calls run (or wait for approval) before the model is called, and
  are reported in `AgentRun.resumedToolCalls`.

- **`maxIdenticalToolCalls` — an opt-in loop guard.** When the model requests the
  same tool call (same name, same arguments, ignoring key order and whitespace)
  more than the allowed number of times in one run, the loop stops before
  running it: `agentRun()` returns `stopReason: "loop_detected"` with the call in
  `repeatedToolCall` (`{ name, arguments, count }`), and `agent()` throws. Off
  when the option is omitted. The calls the guard skipped appear in the step's
  `toolCalls` with `skipped: true`.

- **`agentRun()` — a run report for the agent loop.** The loop now returns what it
  cost, not just the answer: per-step timing (`ms`), tokens, cost in USD and each
  tool call's outcome (`{ id, name, ok, ms }`), plus totals (`usage`, `costUsd`),
  a `toolErrors` count, and a `stopReason`
  (`final`, `step_limit`, `stopped_by_callback`, `aborted`, `budget_exceeded`,
  `loop_detected`, `approval_required`). A step's cost is what its model call added to
  `budget.spent.cost`, so provider-billed costs are attributed to the step that
  incurred them; without a `Budget`, it falls back to the provider's billed
  `usage.cost` when reported. An abort during a model call ends the run with
  `"aborted"` and the report of the steps before it; any other model error is
  rethrown. `agent()` keeps its signature and returns the same text.

- **Conversations across runs — `messages` on the options and on the run report.**
  `AgentOptions.messages` (sent after the system prompt, never mutated) lets a
  caller pass the conversation so far; `AgentRun.messages` returns the history
  without the system prompt, so appending a user message and passing it back
  continues the conversation in the next run.

### Changed

- **An exhausted `Budget` no longer throws out of `agentRun()`.** A run whose
  budget is at its ceiling when a step is about to begin stops with
  `stopReason: "budget_exceeded"`, the `Budget` error's message in
  `budgetExceeded` and an empty `text`, so a request handler can log the reason
  instead of catching an exception. `agent()` still throws the `Budget` error
  itself, at the same point it always has.
- **`agent()` checks the signal before every step.** A signal that is already
  aborted, or is aborted while tools run, now throws an `AbortError` before the
  next model call. Before, the signal was only forwarded to the provider, so an
  `LLM` that ignored it kept running.
- **The loop moved to `src/agent/`** (`types`, `loop`, `loop-guard`, `report`).
  The package's exports are the same, plus the `RepeatedToolCall`,
  `ToolApproval` and `ToolApprovalRequest` types.

## [0.4.0] - 2026-10-29

### Added

- **Billed cost in `Budget`.** `Budget.record()` takes an optional `cost` (USD).
  When the provider reports what it actually billed, that number is used
  instead of the estimate from `inputCostPerM` / `outputCostPerM`, which can't
  see cached or reasoning tokens or time-of-day pricing.
- **`createOpenAICompatible` passes the cost on.** When the response's `usage`
  has a `cost` (OpenRouter adds one), `LLMReply.usage.cost` carries it, so
  `agent()` budgets on real spend with no extra code.

## [0.3.0] - 2026-10-29

### Changed

- **Renamed to `hardrail`.** The `railguard` name on npm belongs to an unrelated
  package, so this library was never installable under it. Import from
  `"hardrail"` and install with `npm i hardrail`.

### Added

- **CommonJS build.** The package now ships `dist/cjs` beside the ES module
  build, chosen through `exports` (`import` / `require`). CommonJS apps can
  `require("hardrail")` on any Node 20, not only on releases that can
  `require()` an ES module.
- **Install from GitHub.** A `prepare` script builds the package, so
  `github:pedrojimenezdev/hardrail#<tag>` installs a working copy.

### Fixed

- **Type lists in JSON Schema.** `validateSchema` accepts `type` as a list
  (e.g. `["integer", "null"]`). Before, such a schema rejected every value.

## [0.2.0] - 2026-10-25

### Added

- **Tool argument schema validation.** `executeTool` now validates a tool call's
  parsed arguments against the tool's own `parameters` JSON Schema before `run()`
  is invoked, not just that the string was valid JSON. A wrong type, a missing
  required field, or a value outside an `enum` now surfaces as a readable error
  the model can self-correct from, the same way a malformed JSON string already
  did. Exposed standalone as `validateSchema` / `JSONSchema` for use outside the
  agent loop. Zero dependencies — the validator covers `type`, `properties`,
  `required`, `items`, `enum`, `additionalProperties`, `minimum`/`maximum`,
  `minLength`/`maxLength`, `pattern`, and `minItems`/`maxItems`.

## [0.1.0] - 2026-08-31

First release under the `railguard` name.

### Added

- **Streaming.** Optional `stream()` on the `LLM` interface, implemented for both
  providers over `fetch` + `ReadableStream` with no external dependencies. SSE
  parsing is exposed as `sseData`, `openAIDeltas`, and `anthropicDeltas` — plain
  async generators over any async iterable, so streaming is testable without a
  network. Payloads are buffered across chunk boundaries, since a network chunk
  can split a frame mid-JSON.
- **`streamToString(stream)`** for collecting a stream into the single string it
  would have produced.
- **Zod-compatible `structured()`.** `StructuredOptions.schema` accepts anything
  with Zod's `safeParse` signature, typed structurally so no validation library
  becomes a dependency. `schema` takes precedence over `validate` when both are
  passed, and the schema's own error message is quoted back to the model on the
  self-correction turn.
- **`parseToolArgumentsResult`** — the reporting counterpart to
  `parseToolArguments`, returning why a malformed argument string failed.
- **CI.** GitHub Actions workflow running install, typecheck, test, and build
  across Node 20 and 22 on pushes to `main` and every pull request.
- **`npm run test:compiled`** — the full suite compiled to JavaScript before it
  runs, via a new `tsconfig.test.json`. `npm test` relies on Node's
  `--experimental-strip-types`, which does not exist before Node 22.6, so the
  suite could not run at all on the Node 20 the package claims to support. CI
  runs the compiled suite on every matrix version and the native one only where
  it is available.
- **Tests** covering Anthropic message serialization, streaming, chunk overlap,
  tool-argument error surfacing, and the schema path through `structured()` —
  11 tests before this release, 34 after.

### Fixed

- **Agent loop:** `onStep` fired twice per step, double-counting any metric the
  callback recorded and running its side effects a second time.
- **Anthropic tool calling:** `createAnthropic` dropped `tool_use` blocks from
  responses and filtered tool messages out of requests, so tool calling never
  worked against the Messages API. Assistant tool calls now serialize as
  `tool_use` blocks and results as `tool_result` blocks grouped onto a single
  user turn, as the API requires.
- **Chunk overlap:** `chunk()` applied overlap only to the final chunk, leaving
  every other boundary unoverlapped, and truncated a sentence longer than `size`
  instead of splitting it — silently losing content.
- **Tool argument errors:** a malformed argument string silently became `{}`, so
  the tool ran against empty input and the model never learned its call was
  wrong. `executeTool` now returns a readable failure the model can correct from.

### Changed

- **Renamed from `agentkit` to `railguard`**, with `repository`, `homepage`, and
  `bugs` fields added to `package.json`.
- **`LLMCallOptions`** extracted as a named exported type, shared by `complete()`
  and `stream()`.
- **`structured()`** now takes an exported `StructuredOptions<T>` type; `validate`
  is optional, and calling with neither `schema` nor `validate` throws a clear
  error instead of failing on an undefined call.
- **README** rewritten around the problem railguard solves, with a copy-pasteable
  quickstart and honest positioning against LangChain and the raw provider SDKs.

[0.5.0]: https://github.com/pedrojimenezdev/hardrail/releases/tag/v0.5.0
[0.4.0]: https://github.com/pedrojimenezdev/hardrail/releases/tag/v0.4.0
[0.3.0]: https://github.com/pedrojimenezdev/hardrail/releases/tag/v0.3.0
[0.2.0]: https://github.com/pedrojimenezdev/hardrail/releases/tag/v0.2.0
[0.1.0]: https://github.com/pedrojimenezdev/railguard/releases/tag/v0.1.0
