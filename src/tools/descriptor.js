const { z } = require("zod");
const { RISK_LEVELS } = require("./metadata");

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
    approval: input.approval || null,
    capabilities: Object.freeze([...(input.capabilities || [])]),
    visibility: input.visibility || "public",
    result: input.result || null,
    handler: input.handler,
  });
}

module.exports = { normalizeDescriptor, isZodSchema, z };
