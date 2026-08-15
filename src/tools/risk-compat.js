"use strict";

const { stripSidekickPrefix } = require("../core/tool-name");

const RISK_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

function createRiskCompat({ dbStore, TOOL_RISK, TOOL_ACTION_RISK, RISK_LEVELS }) {
const RISK_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

// Tool categories - maps tool names to their category
function getToolRisk(name, args = undefined) {
  // Module tools first: the registry wins dispatch for these names, so the
  // enforced risk must be the risk of what actually executes. Lazy require —
  // the loader has no top-level dependency back into this module. Per-action
  // overrides deliberately do NOT apply here: the descriptor's risk is the
  // risk of foreign code, and a caller-supplied action must not lower it.
  const moduleDescriptor = require("../modules/loader").resolveActiveDescriptor(name);
  if (moduleDescriptor) return RISK_LEVELS.includes(moduleDescriptor.risk) ? moduleDescriptor.risk : "critical";
  const generated = dbStore.getGeneratedCapabilityByName(name);
  if (generated) return RISK_LEVELS.includes(generated.risk) ? generated.risk : "critical";
  const canonical = stripSidekickPrefix(name);
  // Own-property lookup only: a prototype-chain name like "__proto__" or
  // "constructor" must fall through to the critical default, never to a
  // truthy inherited value that would make strict/restricted modes fail open.
  const risk = Object.prototype.hasOwnProperty.call(TOOL_RISK, canonical) ? TOOL_RISK[canonical] : null;
  const toolRisk = RISK_LEVELS.includes(risk) ? risk : "critical";
  return resolveActionRisk(canonical, args, toolRisk);
}

/**
 * Applies a per-action risk override, if one is declared for this tool and this
 * exact action. Every unlisted, missing, or malformed case keeps the tool-level
 * risk, so the only reachable outcome of an unrecognised action is the stricter
 * one. Own-property lookups throughout: an inherited `__proto__` value must not
 * be able to lower the risk of a mutating call.
 */
function resolveActionRisk(canonical, args, toolRisk) {
  if (!args || typeof args !== "object") return toolRisk;
  if (!Object.prototype.hasOwnProperty.call(TOOL_ACTION_RISK, canonical)) return toolRisk;
  const action = Object.prototype.hasOwnProperty.call(args, "action") ? args.action : undefined;
  if (typeof action !== "string" || !action) return toolRisk;
  const actionMap = TOOL_ACTION_RISK[canonical];
  if (!Object.prototype.hasOwnProperty.call(actionMap, action)) return toolRisk;
  const actionRisk = actionMap[action];
  return RISK_LEVELS.includes(actionRisk) ? actionRisk : toolRisk;
}


  return { getToolRisk, resolveActionRisk, RISK_ORDER };
}

module.exports = { createRiskCompat };
