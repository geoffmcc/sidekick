"use strict";
function requireFromSidekick(name) { try { return require(name); } catch { return require(require.resolve(name, { paths: [process.cwd()] })); } }
module.exports = { requireFromSidekick };
