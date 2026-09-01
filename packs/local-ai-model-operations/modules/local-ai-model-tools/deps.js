"use strict";
const path = require("path");
function requireFromSidekick(name) { return require(require.resolve(name, { paths: [path.resolve(__dirname, "../../../.."), process.cwd()] })); }
module.exports = { requireFromSidekick };
