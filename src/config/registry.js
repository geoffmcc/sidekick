"use strict";

// Canonical metadata for environment values exposed to operators. Secret
// values are deliberately represented by references only, never by defaults.
const CONFIG = Object.freeze([
  { name: "SIDEKICK_PORT", type: "integer", default: 4097, range: [1, 65535], owner: "mcp", restart: true, expose: true },
  { name: "SIDEKICK_DASHBOARD_PORT", type: "integer", default: 4098, range: [1, 65535], owner: "dashboard", restart: true, expose: true },
  { name: "SIDEKICK_AGENT_PORT", type: "integer", default: 4099, range: [1, 65535], owner: "agent", restart: true, expose: true },
  { name: "SIDEKICK_DATA_DIR", type: "path", default: "data", owner: "platform", restart: true, expose: true },
  { name: "SIDEKICK_TOOL_POLICY", type: "enum", default: "restricted", values: ["open", "restricted"], owner: "security", restart: true, expose: true },
  { name: "SIDEKICK_APPROVAL_MODE", type: "enum", default: "strict", values: ["off", "risky", "strict"], owner: "security", restart: true, expose: true },
  { name: "SIDEKICK_DASHBOARD_USER", type: "string", default: "", owner: "dashboard", restart: true, expose: true, deprecated: false },
  { name: "SIDEKICK_API_KEY", type: "secret_reference", default: null, required: true, owner: "security", restart: true, expose: false },
  { name: "SIDEKICK_SECRET_KEY", type: "secret_reference", default: null, owner: "security", restart: true, expose: false },
  { name: "SIDEKICK_INFLUX_TOKEN", type: "secret_reference", default: null, owner: "metrics", restart: true, expose: false },
]);

const BY_NAME = new Map(CONFIG.map(entry => [entry.name, entry]));
function getConfigDefinition(name) { return BY_NAME.get(String(name)) || null; }
function listConfigDefinitions({ safeOnly = false } = {}) { return CONFIG.filter(entry => !safeOnly || entry.expose).map(entry => ({ ...entry, secret: entry.type === "secret_reference" })); }
function validateConfig(values = {}) {
  const errors = [];
  for (const [name, value] of Object.entries(values)) {
    const definition = getConfigDefinition(name);
    if (!definition) continue;
    if (definition.type === "integer" && (!/^\d+$/.test(String(value)) || Number(value) < definition.range[0] || Number(value) > definition.range[1])) errors.push({ name, code: "invalid_range" });
    if (definition.values && !definition.values.includes(String(value))) errors.push({ name, code: "invalid_value" });
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { CONFIG, getConfigDefinition, listConfigDefinitions, validateConfig };
