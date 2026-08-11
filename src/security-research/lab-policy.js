"use strict";

// Pure, fail-closed policy for disposable fixture environments. It never
// discovers hosts, opens routes, or executes actions.
const ALLOWED_NETWORK_MODES = new Set(["none", "fixture"]);

function evaluateLabPolicy(environment = {}, operation = {}) {
  const reasons = [];
  if (!environment || environment.kind !== "disposable") reasons.push("environment_not_disposable");
  if (environment.isolation !== "isolated") reasons.push("environment_not_isolated");
  if (!ALLOWED_NETWORK_MODES.has(environment.network_mode)) reasons.push("network_mode_not_allowed");
  if (environment.production_access !== false) reasons.push("production_access_not_explicitly_disabled");
  if (operation.destructive === true && operation.approved !== true) reasons.push("destructive_action_not_approved");
  if (operation.requires_snapshot === true && operation.snapshot_present !== true) reasons.push("snapshot_required");
  return Object.freeze({ ok: reasons.length === 0, reasons, policy: "lab-fixture-v1" });
}

function assertLabPolicy(environment, operation) {
  const decision = evaluateLabPolicy(environment, operation);
  if (!decision.ok) throw new Error(`lab policy denied: ${decision.reasons.join(",")}`);
  return decision;
}

module.exports = Object.freeze({ evaluateLabPolicy, assertLabPolicy });
