"use strict";

const repository = require("./repository");
const loader = require("./loader");

/**
 * Activate only a configured module through the shared loader boundary.
 * Loading, ownership checks, policy wiring, and the enabled transition remain
 * owned by the loader; this wrapper prevents an unconfigured module from
 * skipping the explicit configuration lifecycle step.
 */
function activateConfiguredModule(name, entry) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (record.state !== "configured") {
    throw new Error(`Module "${name}" must be configured before activation (state: ${record.state})`);
  }
  return loader.enableModule(name, entry);
}

module.exports = { activateConfiguredModule };
