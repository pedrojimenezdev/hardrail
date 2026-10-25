import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSchema } from "../src/schema.ts";

test("validateSchema accepts a matching object", () => {
  const result = validateSchema(
    { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    { n: 21 },
  );
  assert.deepEqual(result, { ok: true });
});

test("validateSchema reports a wrong type", () => {
  const result = validateSchema({ type: "object", properties: { n: { type: "number" } } }, { n: "21" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors[0], /arguments\.n: expected number, got string/);
});

test("validateSchema reports a missing required property", () => {
  const result = validateSchema({ type: "object", properties: { n: { type: "number" } }, required: ["n"] }, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors[0], /arguments\.n: required property missing/);
});

test("validateSchema collects every violation, not just the first", () => {
  const result = validateSchema(
    {
      type: "object",
      properties: { n: { type: "number" }, label: { type: "string" } },
      required: ["n", "label"],
    },
    {},
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors.length, 2);
});

test("validateSchema enforces enum", () => {
  const result = validateSchema({ type: "string", enum: ["low", "high"] }, "medium");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors[0], /must be one of/);
});

test("validateSchema enforces additionalProperties: false", () => {
  const result = validateSchema(
    { type: "object", properties: { n: { type: "number" } }, additionalProperties: false },
    { n: 1, extra: true },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors[0], /arguments\.extra: additional property not allowed/);
});

test("validateSchema allows unknown properties by default", () => {
  const result = validateSchema({ type: "object", properties: { n: { type: "number" } } }, { n: 1, extra: true });
  assert.deepEqual(result, { ok: true });
});

test("validateSchema accepts an integer for a declared integer", () => {
  assert.deepEqual(validateSchema({ type: "integer" }, 5), { ok: true });
  const result = validateSchema({ type: "integer" }, 5.5);
  assert.equal(result.ok, false);
});

test("validateSchema validates array items and bounds", () => {
  const schema = { type: "array" as const, items: { type: "string" as const }, minItems: 1, maxItems: 2 };
  assert.deepEqual(validateSchema(schema, ["a"]), { ok: true });
  const tooFew = validateSchema(schema, []);
  assert.equal(tooFew.ok, false);
  const wrongItem = validateSchema(schema, [1]);
  assert.equal(wrongItem.ok, false);
  if (!wrongItem.ok) assert.match(wrongItem.errors[0], /arguments\[0\]: expected string, got number/);
});

test("validateSchema enforces numeric and string bounds", () => {
  const num = validateSchema({ type: "number", minimum: 0, maximum: 10 }, 20);
  assert.equal(num.ok, false);
  const str = validateSchema({ type: "string", minLength: 3, pattern: "^[a-z]+$" }, "AB");
  assert.equal(str.ok, false);
  if (!str.ok) assert.equal(str.errors.length, 2);
});

test("validateSchema is a no-op against an empty schema", () => {
  assert.deepEqual(validateSchema({}, { anything: "goes" }), { ok: true });
});
