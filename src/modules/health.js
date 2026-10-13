"use strict";

const repository = require("./repository");
const loader = require("./loader");

// Three separate processes (index, dashboard, agent) run the same scheduled
// sweep against the same modules, so a steady-state module used to append an
// identical successful `module.health.check` row roughly three times per
// interval — about 120k rows/day across 28 modules. A successful check whose
// immediately preceding ledger entry for the same module is already a recent
// success adds no audit value, so it is coalesced. Failures (ok === false) and
// lifecycle transitions are never coalesced: failures are always recorded, and
// transitions are a different event type. Set the window to 0 to disable
// coalescing (record every check).
const HEALTH_EVENT_COALESCE_MS = (() => {
  const raw = Number(process.env.SIDEKICK_MODULE_HEALTH_COALESCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60000;
})();

function errorText(error, fallback = "Module health check failed") {
  return String(error && error.message ? error.message : error || fallback).replace(/\s+/g, " ").slice(0, 300);
}

/**
 * True when appending a successful check for `name` would duplicate the most
 * recent ledger entry for that module. Failures are never redundant, and a
 * disabled window (0) records every check.
 */
function isRedundantHealthyCheck(name, result) {
  if (!result || result.ok !== true || HEALTH_EVENT_COALESCE_MS === 0) return false;
  try {
    const latest = repository.listHealthHistory(name, 1)[0];
    if (!latest || latest.ok !== true) return false;
    const at = Date.parse(latest.timestamp);
    return Number.isFinite(at) && (Date.now() - at) < HEALTH_EVENT_COALESCE_MS;
  } catch {
    // Observability must never break a health check; on any read failure fall
    // back to appending the event.
    return false;
  }
}

function appendHealthEvent(name, result, module) {
  try {
    if (isRedundantHealthyCheck(name, result)) return;
    require("../platform/kernel").appendEvent({
      event_type: "module.health.check",
      source: "modules",
      subject_type: "module",
      subject_id: name,
      severity: result.ok ? "info" : "warning",
      redaction_state: "none",
      payload: {
        module: name,
        ok: result.ok,
        state: module.state,
        health: result,
        error: result.ok ? undefined : (result.error || "Module health check failed"),
      },
    });
  } catch {}
}

function persistFailedCheck(name, error) {
  const result = { ok: false, error: errorText(error) };
  repository.recordHealth(name, result);
  const module = repository.transitionModule(name, "error", { error: result.error });
  appendHealthEvent(name, result, module);
  return { ok: false, module, health: result };
}

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

  let result;
  try {
    result = entry.healthCheck({ moduleName: name, config: Object.freeze({ ...record.config }) });
  } catch (error) {
    return persistFailedCheck(name, error);
  }
  if (result && typeof result.then === "function") {
    return persistFailedCheck(name, `Module "${name}" healthCheck() must be synchronous`);
  }
  if (typeof result === "boolean") result = { ok: result };
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    return persistFailedCheck(name, `Module "${name}" healthCheck() must return { ok: boolean, details?: object }`);
  }

  const health = repository.recordHealth(name, result);
  let module;
  if (result.ok) {
    module = record.state === "enabled" ? repository.transitionModule(name, "healthy") : health;
  } else {
    module = repository.transitionModule(name, "error", {
      error: result.error || "Module health check failed",
    });
  }

  appendHealthEvent(name, result, module);
  return { ok: result.ok, module, health: result };
}

/** Recover an error-state module, then require a passing health check. */
function recoverModuleHealth(name, entry) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (record.state !== "error") {
    throw new Error(`Module "${name}" must be in error state before recovery (state: ${record.state})`);
  }
  // An error may be persisted after another process failed while this process
  // still holds stale descriptors. Remove those descriptors before the
  // error -> enabled recovery transition.
  loader.disableModule(name);
  loader.enableModule(name, entry);
  return checkModuleHealth(name, entry);
}

module.exports = { checkModuleHealth, recoverModuleHealth, appendHealthEvent, isRedundantHealthyCheck };
