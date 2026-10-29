/**
 * A minimal JSON Schema validator — just enough of the spec to catch what a
 * model actually gets wrong in tool arguments (wrong type, missing required
 * field, value outside an enum/range), with zero dependencies. Not a general
 * JSON Schema implementation: no $ref, no oneOf/allOf/anyOf, no tuple-form
 * `items`. That subset covers every tool schema this library's own API
 * produces, and keeping it small keeps it auditable.
 */
export type JSONSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JSONSchema {
  /** One type, or a list of allowed types (e.g. `["integer", "null"]`). */
  type?: JSONSchemaType | JSONSchemaType[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  [key: string]: unknown;
}

export type SchemaValidation = { ok: true } | { ok: false; errors: string[] };

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Whether `schema.type` allows `type` (a missing `type` allows anything). */
function allows(schema: JSONSchema, type: JSONSchemaType): boolean {
  if (schema.type === undefined) return true;
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function check(schema: JSONSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (schema.type !== undefined) {
    const actual = typeOf(value) as JSONSchemaType;
    const matches =
      allows(schema, actual) ||
      (actual === "number" && allows(schema, "integer") && Number.isInteger(value as number));
    if (!matches) {
      const expected = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
      errors.push(`${path}: expected ${expected}, got ${actual}`);
      return;
    }
  }

  if (typeOf(value) === "object" && (allows(schema, "object") || schema.properties)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required property missing`);
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj) check(propSchema, obj[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
  }

  if (Array.isArray(value) && allows(schema, "array")) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: must have at most ${schema.maxItems} items`);
    }
    if (schema.items) value.forEach((v, i) => check(schema.items!, v, `${path}[${i}]`, errors));
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: must be at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: must match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }
}

/** Validate a value against a JSON Schema, collecting every violation rather
 *  than stopping at the first — a model correcting a bad call benefits from
 *  seeing all of what's wrong in one round trip. */
export function validateSchema(schema: JSONSchema, value: unknown, rootPath = "arguments"): SchemaValidation {
  const errors: string[] = [];
  check(schema, value, rootPath, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
