"use strict";

const repository = require("./repository");

/**
 * Validate and persist configuration for an installed module.
 *
 * Configuration is an explicit lifecycle boundary: it may not enable or load
 * a module, and it only accepts the installed -> configured transition.
 */
function configureInstalledModule(name, config) {
  const record = repository.getModule(name);
  if (!record) throw new Error(`Module "${name}" is not registered`);
  if (record.state !== "installed") {
    throw new Error(`Module "${name}" must be installed before configuration (state: ${record.state})`);
  }
  return repository.transitionModule(name, "configured", { config });
}

module.exports = { configureInstalledModule };
