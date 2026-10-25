"use strict";

const CAPABILITY_PUBLIC_ACTIONS = new Set(["list", "available", "catalog"]);
const CAPABILITY_READ_ACTIONS = new Set(["show", "inspect", "validate", "health", "maturity", "doctor"]);

function capabilityPermission(action) {
  const effectiveAction = action || "list";
  if (CAPABILITY_PUBLIC_ACTIONS.has(effectiveAction)) return null;
  return CAPABILITY_READ_ACTIONS.has(effectiveAction) ? "packs.read" : "packs.manage";
}

module.exports = Object.freeze({ capabilityPermission });
