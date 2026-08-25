const { z } = require("zod");
const { RISK_LEVELS } = require("./metadata");
const { getToolAnnotations } = require("./annotations");

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

function normalizeContextProvider(value) {
  if (!value || typeof value !== "object") return null;
  const tool = String(value.tool || "").trim();
  if (!/^[a-z][a-z0-9_]*$/.test(tool)) return null;
  const action = String(value.action || "query").trim().slice(0, 64);
  const source = String(value.source || "derived").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || "derived";
  const maxChars = Math.max(1000, Math.min(12000, Number(value.max_chars) || 6000));
  const rawScope = value.scope && typeof value.scope === "object" ? value.scope : null;
  const scopeArgument = rawScope && /^[a-z][a-z0-9_]*$/.test(String(rawScope.argument || ""))
    ? String(rawScope.argument)
    : null;
  const scopeSource = rawScope && ["request_path", "request_path_or_context"].includes(String(rawScope.source))
    ? String(rawScope.source)
    : null;
  const scope = scopeArgument && scopeSource
    ? Object.freeze({ argument: scopeArgument, source: scopeSource })
    : null;
  return Object.freeze({ tool, action, source, max_chars: maxChars, ...(scope ? { scope } : {}) });
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
  const annotations = { ...getToolAnnotations(name) };
  for (const key of Object.keys(annotations)) {
    if (input.annotations && typeof input.annotations[key] === "boolean") {
      annotations[key] = input.annotations[key];
    }
  }
  const normalizedProvider = input.risk === "low" ? normalizeContextProvider(input.contextProvider) : null;
  const placement = normalizePlacement(input.placement || inferredPlacement(input));
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
    placement,
    // Context providers are automatically invoked during Agent/Brain
    // assembly, so only low-risk descriptors may advertise one. The actual
    // call still goes through the canonical dispatcher and policy path.
    // Automatic providers are self-describing only.  This prevents a benign
    // descriptor from nominating an unrelated tool whose real registry risk,
    // lifecycle, or policy may be unsafe for automatic invocation.
    contextProvider: normalizedProvider?.tool === name
      ? normalizedProvider
      : null,
    annotations: Object.freeze(annotations),
    handler: input.handler,
  });
}

const EXECUTION_LOCATIONS = Object.freeze(["server", "node"]);
const NODE_OPERATING_SYSTEMS = Object.freeze(["linux", "windows", "darwin"]);

function normalizePlacement(value) {
  const input = value && typeof value === "object" ? value : {};
  const locations = Array.isArray(input.locations)
    ? input.locations.filter(item => EXECUTION_LOCATIONS.includes(item)).slice(0, 2)
    : ["server"];
  const requirements = input.requirements && typeof input.requirements === "object" ? input.requirements : {};
  const os = Array.isArray(requirements.os)
    ? requirements.os.filter(item => NODE_OPERATING_SYSTEMS.includes(item)).slice(0, 3)
    : [];
  const binaries = Array.isArray(requirements.binaries)
    ? requirements.binaries.filter(item => typeof item === "string" && /^[A-Za-z0-9_.+-]{1,64}$/.test(item)).slice(0, 32)
    : [];
  const packs = Array.isArray(requirements.packs)
    ? requirements.packs.filter(item => typeof item === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(item)).slice(0, 16)
    : [];
  const workspaces = Array.isArray(requirements.workspaces)
    ? requirements.workspaces.filter(item => typeof item === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(item)).slice(0, 16)
    : [];
  return Object.freeze({
    locations: Object.freeze(locations.length ? locations : ["server"]),
    serverBound: input.serverBound === true || locations.includes("server") && input.nodeSafe !== true,
    nodeSafe: input.nodeSafe === true && locations.includes("node"),
    requirements: Object.freeze({
      os: Object.freeze(os),
      binaries: Object.freeze(binaries),
      packs: Object.freeze(packs),
      workspaces: Object.freeze(workspaces),
      networkScopes: Object.freeze(Array.isArray(requirements.networkScopes) ? requirements.networkScopes.slice(0, 16) : []),
      browser: requirements.browser === true,
      privilege: requirements.privilege === true,
    }),
    version: typeof input.version === "string" ? input.version.slice(0, 64) : "1",
  });
}

function inferredPlacement(input) {
  const name = String(input.name || "");
  const family = String(input.family || "");
  const nodeFamilies = new Set(["filesystem"]);
  const nodeNames = new Set([
    "semantic_repo", "dev_repo_profile", "dev_change_summary", "dev_verify",
    "git", "changelog",
    "security_scan", "hash", "diff_files", "parse", "validate", "transform",
    "extract", "summarize", "filter", "find", "anonymize",
  ]);
  if (!nodeFamilies.has(family) && !nodeNames.has(name)) return null;
  return {
    locations: ["node"],
    nodeSafe: true,
    serverBound: false,
    requirements: {
      os: ["linux", "windows", "darwin"],
      workspaces: ["security-research"],
      ...(name === "semantic_repo" || name.startsWith("dev_") ? { packs: ["developer"] } : {}),
    },
  };
}

module.exports = { normalizeDescriptor, isZodSchema, describeSchemaArgs, z };
