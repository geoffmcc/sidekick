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

module.exports = { normalizeDescriptor, isZodSchema, z };
