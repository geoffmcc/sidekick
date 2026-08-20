const { z } = require("zod");
const { RISK_LEVELS } = require("./metadata");

const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY_LENGTH = 120;

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const labels = [];
  const seen = new Set();
  for (const raw of value.slice(0, MAX_CAPABILITIES * 2)) {
    const label = String(raw == null ? "" : raw)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CAPABILITY_LENGTH);
    // Capability labels are identifiers/short tags, not free-form prompt
    // content. Drop instruction-shaped labels rather than rendering them in
    // a system prompt where even bounded text could become misleading.
    if (!label || !/^[A-Za-z0-9][A-Za-z0-9 _./-]*$/.test(label) ||
        /\b(?:ignore|override|bypass|reveal|execute|call)\b/i.test(label) ||
        /^(?:system|assistant|user)\s*$/i.test(label) || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= MAX_CAPABILITIES) break;
  }
  return Object.freeze(labels);
}

function isZodSchema(schema) {
  return !!schema && typeof schema === "object" && typeof schema.safeParse === "function";
}

const MAX_ARGUMENTS = 48;
const MAX_ENUM_VALUES = 32;
const MAX_ARGUMENT_DESCRIPTION_LENGTH = 240;

function schemaShape(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.shape && typeof schema.shape === "object") return schema.shape;
  const shape = schema._def && schema._def.shape;
  return typeof shape === "function" ? shape() : (shape && typeof shape === "object" ? shape : null);
}

function schemaTypeDescription(schema) {
  if (!schema || typeof schema !== "object") return null;
  const def = schema.def || schema._def || {};
  const type = String(def.type || def.typeName || schema.type || "").toLowerCase();
  if (type === "optional" || type === "nullable" || type === "default") {
    return schemaTypeDescription(def.innerType || schema.unwrap?.());
  }
  if (type === "enum") {
    const values = Array.isArray(schema.options)
      ? schema.options
      : Object.values(def.entries || {});
    const bounded = values.map(value => String(value).slice(0, 80)).slice(0, MAX_ENUM_VALUES);
    return bounded.length ? `string (${bounded.join("|")})` : "string";
  }
  if (type === "string") return "string";
  if (type === "number" || type === "bigint") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array" || type === "set") return "array";
  if (type === "object" || type === "record") return "object";
  if (type === "date") return "string (date-time)";
  return null;
}

/**
 * Produce a bounded, model-facing argument signature from the same schema
 * that the dispatcher validates. This is declarative data only: it contains
 * no handlers, defaults, credentials, or authority. Legacy `args` remain the
 * fallback for fields whose schema cannot be described safely.
 */
function describeSchemaArgs(schema, legacyArgs = {}) {
  const shape = schemaShape(schema);
  const output = { ...(legacyArgs && typeof legacyArgs === "object" ? legacyArgs : {}) };
  if (!shape) return Object.freeze(output);
  for (const [name, field] of Object.entries(shape).slice(0, MAX_ARGUMENTS)) {
    const type = schemaTypeDescription(field);
    if (!type) continue;
    output[name] = type.slice(0, MAX_ARGUMENT_DESCRIPTION_LENGTH);
  }
  return Object.freeze(output);
}

function normalizeDescriptor(input) {
  if (!input || typeof input !== "object") throw new Error("Tool descriptor must be an object");
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Tool descriptor is missing name");
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid tool name: ${name}`);
  const description = String(input.description || "").trim();
  if (!description) throw new Error(`Tool descriptor ${name} is missing description`);
  if (typeof input.handler !== "function") throw new Error(`Tool descriptor ${name} is missing handler`);
  if (!isZodSchema(input.schema)) throw new Error(`Tool descriptor ${name} is missing Zod schema`);
  const risk = input.risk;
  if (!risk) throw new Error(`Tool descriptor ${name} is missing risk`);
  if (!RISK_LEVELS.includes(risk)) throw new Error(`Tool descriptor ${name} has invalid risk: ${risk}`);
  const category = String(input.category || "Uncategorized").trim() || "Uncategorized";
  return Object.freeze({
    name,
    description,
    schema: input.schema,
    args: input.args || {},
    argumentDescriptions: describeSchemaArgs(input.schema, input.args),
    risk,
    category,
    source: input.source || "builtin",
    family: input.family || null,
    aliases: Object.freeze([...(input.aliases || [])]),
    version: input.version || null,
    provenance: input.provenance || null,
    authorizationPermission: input.authorizationPermission || null,
    approval: input.approval || null,
    // Capability labels are declarative prompt metadata. Bound and sanitize
    // them at the canonical descriptor boundary so an untrusted module
    // manifest cannot inject control characters, duplicate labels, or an
    // unbounded prompt fragment into any consumer of the registry.
    capabilities: normalizeCapabilities(input.capabilities),
    visibility: input.visibility || "public",
    result: input.result || null,
    handler: input.handler,
  });
}

module.exports = { normalizeDescriptor, isZodSchema, describeSchemaArgs, z };
