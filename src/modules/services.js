"use strict";

/**
 * Narrow, versioned service facades for module handlers (docs/module-system-design.md).
 *
 * Module handlers never receive the database, transport objects, handler maps,
 * or kernel internals. They receive a frozen facade:
 *   - moduleName
 *   - config (the module's validated config)
 *   - dispatch(name, args, options)  -> routes through the existing dispatcher
 *     (full policy + approval path), never through handler maps.
 *   - paths.enforce/decide           -> the SAME canonical filesystem path
 *     boundary the builtin families use (src/tools/path-policy.js). A module
 *     that reads files must be able to honour path policy without either
 *     reimplementing it or round-tripping every file through the dispatcher;
 *     exposing the shared boundary is reuse, not a second policy.
 *
 * dispatch() enforces the module's declared manifest permissions as a
 * deny-by-default allowlist BEFORE the call reaches the dispatcher: a module
 * may only dispatch tools it declared, and only while the tool's resolved
 * risk does not exceed the declared cap. Permissions are declarative
 * requirements — a module cannot grant itself permission, and the shared
 * policy/approval path still applies on top. Every facade dispatch stamps the
 * module's name into the child execution context so module-originated calls
 * are attributable in the tool logs.
 *
 * The v1 facade is a stable, versioned surface so future versions can be added
 * without breaking existing modules.
 */

const { RISK_LEVELS } = require("../tools/metadata");
const { stripSidekickPrefix } = require("../core/tool-name");

const NARROW_SERVICE_KEYS = Object.freeze(["moduleName", "config", "dispatch", "paths"]);

function riskIndex(risk) {
  const index = RISK_LEVELS.indexOf(risk);
  // Unknown risk fails closed as the highest tier.
  return index === -1 ? RISK_LEVELS.length : index;
}

function buildPermissionMap(permissions) {
  // canonical tool name -> maximum permitted risk. Capability-style
  // permission entries are declarative requirements for platform capability
  // services, not tool grants, so they confer no dispatch rights here.
  const map = new Map();
  for (const entry of permissions || []) {
    if (!entry || typeof entry.tool !== "string") continue;
    const canonical = stripSidekickPrefix(entry.tool);
    const existing = map.get(canonical);
    // Conflicting duplicate declarations resolve to the MOST restrictive cap.
    if (existing === undefined || riskIndex(entry.risk) < riskIndex(existing)) {
      map.set(canonical, entry.risk);
    }
  }
  return map;
}

function permissionDenied(moduleName, message) {
  const { errorResult } = require("../tools/result");
  return errorResult(`Module "${moduleName}" ${message}`, "module_permission_denied");
}

function createModuleServices(moduleName, config = {}, { permissions = [], packName = null } = {}) {
  const frozenConfig = Object.freeze({ ...(config || {}) });
  const permissionMap = buildPermissionMap(permissions);

  async function dispatch(name, args, options) {
    // Resolve permission identity the same way the dispatcher resolves
    // dispatch identity: through the registry, aliases included, so a
    // permission declared for a canonical tool covers its aliases. Names the
    // registry does not know (generated tools) fall back to the raw
    // canonical form.
    const requested = stripSidekickPrefix(String(name || ""));
    const descriptor = require("../tools/dispatcher").getBuiltinRegistry().get(requested);
    const canonical = descriptor ? stripSidekickPrefix(descriptor.name) : requested;
    if (!permissionMap.has(canonical)) {
      return permissionDenied(moduleName, `has no declared permission for tool "${canonical}"`);
    }
    const maxRisk = permissionMap.get(canonical);
    const resolvedRisk = descriptor ? descriptor.risk : require("../tools-legacy").getToolRisk(canonical);
    if (riskIndex(resolvedRisk) > riskIndex(maxRisk)) {
      return permissionDenied(
        moduleName,
        `permission for tool "${canonical}" caps risk at ${maxRisk} but the tool resolves to ${resolvedRisk}`
      );
    }
    const dispatcher = require("../tools/dispatcher");
    // `module` is set last so a handler cannot spoof another module's identity
    // through options.
    return dispatcher.callTool(String(name), args || {}, { ...(options || {}), module: moduleName });
  }

  // The canonical filesystem boundary, not a copy of it. `enforce` returns
  // null when the path is permitted and a ready-to-return error result when it
  // is not, exactly as the builtin filesystem family consumes it, and it
  // resolves the execution source per call from the request-scoped context.
  const paths = Object.freeze({
    enforce(filePath, operation = "access") {
      return require("../tools/path-policy").enforcePathPolicy(filePath, operation);
    },
    decide(filePath, operation = "access") {
      return require("../tools/path-policy").getPathPolicyDecision(filePath, operation);
    },
  });

  const v1 = Object.freeze({
    moduleName,
    config: frozenConfig,
    dispatch,
    paths,
  });

  let v2 = null;
  if (packName) {
    v2 = require("./pack-services").createPackServices(packName, permissions, v1);
  }

  const facade = {
    moduleName,
    v1,
  };
  if (v2) facade.v2 = v2;
  return Object.freeze(facade);
}

module.exports = { createModuleServices, NARROW_SERVICE_KEYS };
