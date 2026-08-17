"use strict";

/**
 * Workflow DEFINITION contract (docs/capability-packs.md).
 *
 * A definition is pure, serializable data: identity, inputs, an ordered list of
 * steps that each name ONE Sidekick tool, and a result projection. It contains
 * no code, no expressions to evaluate, and no way to reach anything except the
 * tool dispatcher — which is what lets a capability pack ship runnable
 * workflows without shipping a second execution engine.
 *
 * Values are threaded between steps with a deliberately small reference syntax:
 *
 *   ${inputs.<key>}                 a validated workflow input
 *   ${steps.<step>.json[.a.b[0]]}   a prior step's parsed JSON result
 *   ${steps.<step>.text}            a prior step's textual result
 *   ${steps.<step>.ok}              whether a prior step succeeded
 *
 * References are RESOLVED, never evaluated: there is no arithmetic, no
 * function call, and no way to express anything the resolver does not
 * explicitly implement. A reference to a step that has not run yet is a
 * validation error, so a definition cannot depend on execution order by
 * accident.
 */

const crypto = require("crypto");
const { z } = require("zod");

const DEFINITION_SCHEMA_VERSION = 1;
const WORKFLOW_NAME_RE = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/;
const STEP_NAME_RE = /^[a-z][a-z0-9_]*$/;
const MAX_STEPS = 40;

const INPUT_SCHEMA = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]).default("string"),
  description: z.string().optional(),
  required: z.boolean().default(false),
  default: z.any().optional(),
  enum: z.array(z.any()).optional(),
});

const STEP_SCHEMA = z.object({
  name: z.string().regex(STEP_NAME_RE),
  title: z.string().optional(),
  description: z.string().optional(),
  tool: z.string().regex(/^[a-z][a-z0-9_]*$/),
  args: z.record(z.any()).default({}),
  // How the step's result is projected for later references.
  expect: z.enum(["json", "text"]).default("text"),
  // `continue` keeps the workflow running and records the failure as evidence;
  // `fail` stops the workflow. Optional steps are the common case for
  // enrichment that may legitimately be unavailable (e.g. no GitHub token).
  on_error: z.enum(["fail", "continue"]).default("fail"),
  // Cleanup/compensation steps still run after a failure or cancellation. They
  // must be side-effect-safe and should normally use on_error=continue so a
  // cleanup failure cannot hide the original failure.
  always: z.boolean().default(false),
  when: z.string().optional(),
  timeout_ms: z.number().int().positive().max(600000).optional(),
});

const definitionSchema = z.object({
  schema_version: z.literal(DEFINITION_SCHEMA_VERSION).default(DEFINITION_SCHEMA_VERSION),
  name: z.string().regex(WORKFLOW_NAME_RE),
  version: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  // Declarative honesty about what running this does. `read_only` workflows
  // may only reference tools the pack declared as read-only intent; the runner
  // does NOT rely on this for enforcement (the dispatcher's policy and
  // approval path does that) — it is operator-facing intent.
  mode: z.enum(["read_only", "mutating"]).default("read_only"),
  inputs: z.record(INPUT_SCHEMA).default({}),
  steps: z.array(STEP_SCHEMA).min(1).max(MAX_STEPS),
  result: z.record(z.any()).default({}),
  tags: z.array(z.string()).default([]),
});

const REFERENCE_RE = /\$\{([a-zA-Z0-9_.\[\]/-]+)\}/g;
const WHOLE_REFERENCE_RE = /^\$\{([a-zA-Z0-9_.\[\]/-]+)\}$/;

function normalizeDefinition(input) {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join(".") || "definition"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid workflow definition${details ? ": " + details : ""}`);
  }
  const definition = parsed.data;

  const seen = new Set();
  for (const step of definition.steps) {
    if (seen.has(step.name)) throw new Error(`Workflow "${definition.name}" has duplicate step name "${step.name}"`);
    seen.add(step.name);
  }

  // Every reference must resolve against inputs, or against a step that has
  // ALREADY run. This is what makes the definition statically checkable.
  const available = new Set();
  for (const step of definition.steps) {
    for (const reference of collectReferences([step.args, step.when])) {
      assertReferenceResolvable(definition, reference, available, `step "${step.name}"`);
    }
    available.add(step.name);
  }
  for (const reference of collectReferences([definition.result])) {
    assertReferenceResolvable(definition, reference, available, "result projection");
  }

  return Object.freeze(definition);
}

function collectReferences(values) {
  const found = [];
  const walk = value => {
    if (typeof value === "string") {
      for (const match of value.matchAll(REFERENCE_RE)) found.push(match[1]);
      return;
    }
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object") return Object.values(value).forEach(walk);
  };
  values.forEach(walk);
  return found;
}

function assertReferenceResolvable(definition, reference, availableSteps, where) {
  const parts = reference.split(".");
  if (parts[0] === "inputs") {
    if (parts.length < 2) throw new Error(`Workflow "${definition.name}" ${where}: "${reference}" names no input`);
    if (!Object.prototype.hasOwnProperty.call(definition.inputs, parts[1])) {
      throw new Error(`Workflow "${definition.name}" ${where} references undeclared input "${parts[1]}"`);
    }
    return;
  }
  if (parts[0] === "steps") {
    if (parts.length < 3) throw new Error(`Workflow "${definition.name}" ${where}: "${reference}" must name a step and a projection`);
    if (!availableSteps.has(parts[1])) {
      throw new Error(`Workflow "${definition.name}" ${where} references step "${parts[1]}" before it runs`);
    }
    if (!["json", "text", "ok"].includes(parts[2])) {
      throw new Error(`Workflow "${definition.name}" ${where}: unknown step projection "${parts[2]}"`);
    }
    return;
  }
  throw new Error(`Workflow "${definition.name}" ${where}: unknown reference root "${parts[0]}"`);
}

/** Read one value out of the resolution scope. Returns undefined when absent. */
function lookup(scope, reference) {
  const parts = reference.split(".");
  let current = scope;
  for (const rawPart of parts) {
    if (current == null) return undefined;
    // Support a[0] style indexing inside a single dotted segment.
    const segments = rawPart.split(/[\[\]]/).filter(Boolean);
    for (const segment of segments) {
      if (current == null) return undefined;
      const key = /^\d+$/.test(segment) ? Number(segment) : segment;
      current = Array.isArray(current) && typeof key === "number" ? current[key] : current[key];
    }
  }
  return current;
}

/**
 * Substitute references in arbitrary plain data.
 *
 * A string that is EXACTLY one reference yields the referenced value with its
 * type intact (so an object stays an object); a string with a reference among
 * other text yields interpolated text.
 */
function resolveValue(value, scope) {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_REFERENCE_RE);
    if (whole) return lookup(scope, whole[1]);
    return value.replace(REFERENCE_RE, (_match, reference) => {
      const resolved = lookup(scope, reference);
      if (resolved === undefined || resolved === null) return "";
      return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map(item => resolveValue(item, scope));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const resolved = resolveValue(child, scope);
      // Drop keys whose only content was an unresolved reference, so an
      // optional value does not become a literal "undefined" argument.
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  return value;
}

function isTruthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim() !== "" && value !== "false";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value !== 0;
  return true;
}

/** Validate and coerce workflow inputs against the declared input contract. */
function validateInputs(definition, provided = {}) {
  const values = {};
  const errors = [];
  for (const [key, spec] of Object.entries(definition.inputs)) {
    let value = Object.prototype.hasOwnProperty.call(provided, key) ? provided[key] : undefined;
    if (value === undefined && spec.default !== undefined) value = spec.default;
    if (value === undefined || value === null || value === "") {
      if (spec.required) errors.push(`input "${key}" is required`);
      continue;
    }
    if (spec.type === "number" && typeof value !== "number") {
      const coerced = Number(value);
      if (Number.isNaN(coerced)) errors.push(`input "${key}" must be a number`);
      else value = coerced;
    } else if (spec.type === "boolean" && typeof value !== "boolean") {
      value = value === "true" || value === true;
    } else if (spec.type === "string" && typeof value !== "string") {
      errors.push(`input "${key}" must be a string`);
    } else if (spec.type === "array" && !Array.isArray(value)) {
      errors.push(`input "${key}" must be an array`);
    } else if (spec.type === "object" && (typeof value !== "object" || Array.isArray(value))) {
      errors.push(`input "${key}" must be an object`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      errors.push(`input "${key}" must be one of: ${spec.enum.join(", ")}`);
    }
    values[key] = value;
  }
  const unknown = Object.keys(provided).filter(key => !Object.prototype.hasOwnProperty.call(definition.inputs, key));
  if (unknown.length) errors.push(`unknown input(s): ${unknown.join(", ")}`);
  return { ok: errors.length === 0, values, errors };
}

function definitionChecksum(definition) {
  return crypto.createHash("sha256").update(JSON.stringify(definition), "utf8").digest("hex");
}

module.exports = {
  DEFINITION_SCHEMA_VERSION,
  WORKFLOW_NAME_RE,
  MAX_STEPS,
  definitionSchema,
  normalizeDefinition,
  validateInputs,
  resolveValue,
  isTruthy,
  lookup,
  definitionChecksum,
  collectReferences,
};
