// Persistent worker configuration (Phase 3).
//
// Lets the compute worker read settings from a JSON config file in addition to
// CLI flags and environment variables, and derives a STABLE node identity that
// survives restarts. Resolution precedence is CLI > env > config file > defaults.
//
// The worker uses process.env as the merge substrate: applyCliArgs() writes CLI
// flags into env (highest priority), then applyFileConfig() fills any remaining
// gaps from the config file (so real env vars still win over the file), and the
// worker's consts read env with hard-coded defaults last. This module therefore
// only ever sets an env var that is not already set.
//
// Kept dependency-free (no ajv) so it can ship inside the minimal standalone
// worker package without pulling in server-only dependencies.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// JSON-schema-ish description of a valid config file. Also drives validation.
const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    serverUrl: { type: "string", format: "uri" },
    nodeId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{3,63}$" },
    displayName: { type: "string", maxLength: 120 },
    concurrency: { type: "integer", minimum: 1, maximum: 16 },
    heartbeatMs: { type: "integer", minimum: 5000, maximum: 300000 },
    pollMs: { type: "integer", minimum: 500, maximum: 60000 },
    openvino: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        pythonPath: { type: "string", maxLength: 1024 },
        modelsDir: { type: "string", maxLength: 1024 },
      },
    },
    ollama: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        url: { type: "string", format: "uri" },
      },
    },
  },
};

// Config key -> env var it seeds when the file supplies it (scalars only; the
// openvino/ollama nested objects and serverUrl are handled specially below).
const ENV_MAP = {
  nodeId: "SIDEKICK_NODE_ID",
  displayName: "SIDEKICK_NODE_NAME",
  concurrency: "SIDEKICK_WORKER_CONCURRENCY",
  heartbeatMs: "SIDEKICK_HEARTBEAT_MS",
  pollMs: "SIDEKICK_WORKER_POLL_MS",
};

function isValidUri(value) {
  try {
    const u = new URL(value);
    return !!u.protocol && !!u.host;
  } catch {
    return false;
  }
}

function validateNode(value, schema, p, errors) {
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) { errors.push(`${p} must be an object`); return; }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!schema.properties || !(key in schema.properties)) errors.push(`${p}.${key} is not a recognized option`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) validateNode(value[key], sub, `${p}.${key}`, errors);
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") { errors.push(`${p} must be a string`); return; }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${p} exceeds max length ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${p} does not match ${schema.pattern}`);
    if (schema.format === "uri" && !isValidUri(value)) errors.push(`${p} must be a valid URI`);
    return;
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) { errors.push(`${p} must be an integer`); return; }
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${p} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${p} must be <= ${schema.maximum}`);
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${p} must be a boolean`);
  }
}

// Validate a parsed config object against CONFIG_SCHEMA. Throws on any problem.
function validateConfig(config) {
  const errors = [];
  validateNode(config, CONFIG_SCHEMA, "config", errors);
  if (errors.length) {
    const err = new Error(`Invalid worker config: ${errors.join("; ")}`);
    err.code = "WORKER_CONFIG_INVALID";
    err.errors = errors;
    throw err;
  }
  return true;
}

// Deterministic node identity derived from hostname + non-internal MAC
// addresses. Stable across restarts without needing to persist anything, which
// fixes the previous random-per-restart NODE_ID. Format matches the schema's
// nodeId pattern.
function generateStableNodeId() {
  const nets = os.networkInterfaces();
  const macs = new Set();
  for (const name of Object.keys(nets).sort()) {
    for (const iface of nets[name] || []) {
      if (iface && iface.mac && iface.mac !== "00:00:00:00:00:00" && !iface.internal) macs.add(iface.mac);
    }
  }
  const seed = `${os.hostname()}|${Array.from(macs).sort().join(",")}`;
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `node_${hash}`;
}

// Default config file location by platform. This is the SETTINGS file and is
// separate from the credential file (worker-credential.json / Phase 4).
function defaultConfigPath() {
  if (process.platform === "win32") {
    const base = process.env.ProgramData || "C:\\ProgramData";
    return path.join(base, "Sidekick", "compute-worker", "config.json");
  }
  if (process.platform === "darwin") {
    return path.join("/Library", "Application Support", "Sidekick Compute Worker", "config.json");
  }
  return path.join("/etc", "sidekick-compute-worker", "config.json");
}

// Load and validate the config file. Returns { path, exists, config }. An absent
// file is not an error (returns exists:false, config:{}). A present-but-unreadable,
// non-JSON, or schema-invalid file throws with a clear code.
function loadConfigFile(pathOverride) {
  const configPath = pathOverride || process.env.SIDEKICK_WORKER_CONFIG_FILE || defaultConfigPath();
  if (!fs.existsSync(configPath)) return { path: configPath, exists: false, config: {} };
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    const err = new Error(`Cannot read worker config ${configPath}: ${e.message}`);
    err.code = "WORKER_CONFIG_READ";
    throw err;
  }
  // Strip a leading UTF-8 BOM — Windows editors and PowerShell's
  // `Set-Content -Encoding UTF8` prepend one, and JSON.parse rejects it.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`Worker config ${configPath} is not valid JSON: ${e.message}`);
    err.code = "WORKER_CONFIG_PARSE";
    throw err;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) delete parsed.$schema; // allow the JSON Schema pointer
  validateConfig(parsed);
  return { path: configPath, exists: true, config: parsed };
}

function setIfUnset(envName, value) {
  if (value === undefined || value === null) return;
  if (process.env[envName] === undefined || process.env[envName] === "") process.env[envName] = String(value);
}

// Seed env vars from a validated config object, only where not already set, so
// CLI (already in env) and real env vars keep priority over the file.
function applyConfigToEnv(fileConfig) {
  if (!fileConfig || typeof fileConfig !== "object") return;
  // serverUrl is read as SIDEKICK_URL || SIDEKICK_SERVER_URL — fill only if neither is set.
  if (fileConfig.serverUrl !== undefined && !process.env.SIDEKICK_URL && !process.env.SIDEKICK_SERVER_URL) {
    process.env.SIDEKICK_SERVER_URL = String(fileConfig.serverUrl);
  }
  for (const [key, envName] of Object.entries(ENV_MAP)) setIfUnset(envName, fileConfig[key]);
  if (fileConfig.openvino && typeof fileConfig.openvino === "object") {
    if (fileConfig.openvino.enabled !== undefined) setIfUnset("SIDEKICK_OPENVINO_ENABLED", fileConfig.openvino.enabled ? "true" : "false");
    setIfUnset("SIDEKICK_OPENVINO_PYTHON", fileConfig.openvino.pythonPath);
    setIfUnset("SIDEKICK_OPENVINO_MODELS_DIR", fileConfig.openvino.modelsDir);
  }
  if (fileConfig.ollama && typeof fileConfig.ollama === "object") {
    if (fileConfig.ollama.url !== undefined && fileConfig.ollama.enabled !== false) setIfUnset("OLLAMA_URL", fileConfig.ollama.url);
  }
}

// Convenience used at worker startup: load the config file (if any) and apply it
// to env. Returns the load result for logging.
function applyFileConfig(pathOverride) {
  const result = loadConfigFile(pathOverride);
  if (result.exists) applyConfigToEnv(result.config);
  return result;
}

module.exports = {
  CONFIG_SCHEMA,
  ENV_MAP,
  validateConfig,
  generateStableNodeId,
  defaultConfigPath,
  loadConfigFile,
  applyConfigToEnv,
  applyFileConfig,
};
