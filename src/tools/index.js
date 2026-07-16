const legacy = require("../tools-legacy");
const { buildBuiltinRegistry, createRegistry } = require("./registry");
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

function getBuiltinRegistry() {
  return buildBuiltinRegistry({
    toolDefs: legacy.TOOL_DEFS,
    handlers: legacy.TOOLS,
    categoryForTool: metadata.getStaticToolCategory,
    schemas: schemas.TOOL_SCHEMAS,
  });
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
  callTool: dispatcher.callTool,
  dispatchTool: dispatcher.dispatchTool,
  getBuiltinRegistry,
  buildBuiltinRegistry,
  createRegistry,
  ...descriptor,
  ...metadata,
  ...schemas,
  context,
  result,
  dispatcher,
  policy,
  approvals,
  logging,
  registrySync,
};
