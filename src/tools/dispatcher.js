const legacy = require("../tools-legacy");

function getHandlerMap() {
  return legacy.TOOLS;
}

module.exports = { callTool: legacy.callTool, getHandlerMap };
