"use strict";

// Compatibility-only direct tool implementations that have not yet moved to
// descriptor-owned families. Keep this map separate from the legacy catalog so
// the dispatcher facade does not also own implementation wiring.
const computeTools = require("../compute/tools");

const TOOLS = Object.freeze({
  compute: computeTools.sidekick_compute,
  compute_nodes: computeTools.sidekick_compute_nodes,
  compute_providers: computeTools.sidekick_compute_providers,
  compute_models: computeTools.sidekick_compute_models,
  compute_jobs: computeTools.sidekick_compute_jobs,
  compute_route: computeTools.sidekick_compute_route,
});

module.exports = { TOOLS };
