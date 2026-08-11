"use strict";

// This is an integration boundary, not a Workbench client. The repository has
// no verified security-research API surface, so network behavior is injected
// by a future adapter and never guessed here.

const ADAPTER_VERSION = 1;

function validateSecretRef(value) {
  if (value === undefined || value === null || value === "") return null;
  const ref = String(value);
  if (!/^secret:[A-Za-z0-9_.:/-]{1,190}$/.test(ref)) throw new Error("secret_ref must be an opaque secret:name reference");
  return ref;
}

function validateEndpoint(value) {
  if (value === undefined || value === null || value === "") return null;
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new Error("endpoint must be a valid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("endpoint must be http(s) without embedded credentials");
  }
  return parsed.toString();
}

function createSecurityResearchAdapter({ endpoint, secret_ref, capabilities = [], transport = null } = {}) {
  const normalizedEndpoint = validateEndpoint(endpoint);
  const secretRef = validateSecretRef(secret_ref);
  if (!Array.isArray(capabilities) || capabilities.some(capability => typeof capability !== "string")) {
    throw new Error("capabilities must be an array of strings");
  }
  const available = Boolean(transport && typeof transport.request === "function");
  return Object.freeze({
    name: "security-research",
    adapter_version: ADAPTER_VERSION,
    state: available ? "ready" : "unavailable",
    reason: available ? null : "no verified security-research API transport is configured",
    endpoint: normalizedEndpoint,
    secret_ref_present: Boolean(secretRef),
    capabilities: [...capabilities],
    transport,
  });
}

function requiredCapability(operation) {
  const family = operation.split(/[._]/, 1)[0];
  if (family === "findings") return "findings.read";
  if (family === "reports") return operation.includes("create") || operation.includes("submit") ? "reports.write" : "reports.read";
  if (family === "evidence") return operation.includes("register") || operation.includes("write") ? "evidence.write" : "evidence.read";
  return `${family}.read`;
}

async function request(adapter, operation, payload = {}) {
  if (!adapter || adapter.name !== "security-research") throw new Error("security-research adapter is required");
  if (adapter.state !== "ready" || !adapter.transport) throw new Error("security-research surface is unavailable; no request was sent");
  if (typeof operation !== "string" || !/^[a-z][a-z0-9_.-]{0,80}$/.test(operation)) throw new Error("operation must be a bounded name");
  const capability = requiredCapability(operation);
  if (!adapter.capabilities.includes(capability)) throw new Error(`security-research capability is not granted: ${capability}`);
  const result = await adapter.transport.request({ operation, payload, endpoint: adapter.endpoint });
  if (!result || typeof result !== "object") throw new Error("security-research adapter returned an invalid result");
  return { ...result, adapter: adapter.name, adapter_version: adapter.adapter_version };
}

module.exports = { ADAPTER_VERSION, createSecurityResearchAdapter, requiredCapability, request };
