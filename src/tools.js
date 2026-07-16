// Compatibility facade for the built-in tool layer.
// New code should prefer `src/tools/index.js`; this file intentionally preserves
// the historical CommonJS export set used by the MCP server, dashboard, agent,
// and tests.
module.exports = require("./tools-legacy");
