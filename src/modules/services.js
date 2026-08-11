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
 *
 * The v1 facade is a stable, versioned surface so future versions can be added
 * without breaking existing modules.
 */

const NARROW_SERVICE_KEYS = Object.freeze(["moduleName", "config", "dispatch"]);

function createModuleServices(moduleName, config = {}) {
  const frozenConfig = Object.freeze({ ...(config || {}) });

  function dispatch(name, args, options) {
    const dispatcher = require("../tools/dispatcher");
    return dispatcher.callTool(String(name), args || {}, options || {});
  }

  const v1 = Object.freeze({
    moduleName,
    config: frozenConfig,
    dispatch,
  });

  return Object.freeze({
    moduleName,
    v1,
  });
}

module.exports = { createModuleServices, NARROW_SERVICE_KEYS };
