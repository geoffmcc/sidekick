const legacy = require("../tools-legacy");
const { buildBuiltinRegistry, createRegistry } = require("./registry");
const { getCanonicalRegistry } = require("./canonical-registry");
const descriptor = require("./descriptor");
const metadata = require("./metadata");
const schemas = require("./schemas");
const context = require("./context");
const result = require("./result");
const dispatcher = require("./dispatcher");
const policy = require("./policy");
const approvals = require("./approvals");
const logging = require("./logging");
const registrySync = require("./registry-sync");
const observability = require("./families/observability");

function getBuiltinRegistry() {
  return getCanonicalRegistry({ includeActiveModules: true });
}

function getCompatibilityToolMap() {
  return getBuiltinRegistry().toolsMap();
}

function getCompatibilityToolDefs() {
  return getBuiltinRegistry().toolDefs();
}

module.exports = {
  ...legacy,
  TOOLS: getCompatibilityToolMap(),
  TOOL_DEFS: getCompatibilityToolDefs(),
  // Compatibility export: checkNetwork moved to the observability family
  // (B-4) but stays on this surface for test/health.test.js and the
  // registry contract's compatibility-export list.
  checkNetwork: observability.checkNetwork,
  callTool: dispatcher.callTool,
  callMcpTool: dispatcher.callMcpTool,
  callAgentTool: dispatcher.callAgentTool,
  callDashboardTool: dispatcher.callDashboardTool,
  callInternalTool: dispatcher.callInternalTool,
  dispatchTool: dispatcher.dispatchTool,
  dispatchTestTool: dispatcher.dispatchTestTool,
  getBuiltinRegistry,
  buildBuiltinRegistry,
  createRegistry,
  ...descriptor,
  ...metadata,
  ...schemas,
  context,
  result,
  // The dispatcher is re-exported for transports and tests, but WITHOUT the
  // internal runner seam. `executeAuthorizedTaskStep` carries the
  // approved-execution capability, and re-exporting the raw module put it on
  // the public surface as `require("./tools").dispatcher.executeAuthorizedTaskStep`.
  // It verifies its own authorization, so reachability is not a bypass — but a
  // privileged seam should not be reachable from the general tool facade at
  // all. `src/brain/resume.js` requires `./tools/dispatcher` directly.
  dispatcher: (() => {
    const { executeAuthorizedTaskStep, ...publicDispatcher } = dispatcher;
    return publicDispatcher;
  })(),
  policy,
  approvals,
  logging,
  registrySync,
};
