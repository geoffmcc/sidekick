"use strict";

const repository = require("./repository");
const loader = require("./loader");

/** Run and persist a module entry's bounded health contract. */
function checkModuleHealth(name, entry) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (record.state !== "enabled" && record.state !== "healthy") {
    throw new Error(`Module "${name}" must be enabled before health checks (state: ${record.state})`);
  }
  if (!loader.isModuleActive(name)) {
    throw new Error(`Module "${name}" is not active in this process`);
  }
  if (!entry || typeof entry.healthCheck !== "function") {
    throw new Error(`Module "${name}" entry must expose healthCheck()`);
  }

  let result = entry.healthCheck({ moduleName: name, config: Object.freeze({ ...record.config }) });
  if (result && typeof result.then === "function") {
    throw new Error(`Module "${name}" healthCheck() must be synchronous`);
  }
  if (typeof result === "boolean") result = { ok: result };
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new Error(`Module "${name}" healthCheck() must return { ok: boolean, details?: object }`);
  }

  const health = repository.recordHealth(name, result);
  if (result.ok) {
    const module = record.state === "enabled" ? repository.transitionModule(name, "healthy") : health;
    return { ok: true, module, health: result };
  }

  const module = repository.transitionModule(name, "error", {
    error: result.error || "Module health check failed",
  });
  return { ok: false, module, health: result };
}

module.exports = { checkModuleHealth };
