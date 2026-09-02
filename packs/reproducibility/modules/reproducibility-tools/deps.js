"use strict";
const path = require("path");
const Module = require("module");
function requireFromSidekick(name) {
  try { return require(name); } catch (error) {
    try { return Module.createRequire(path.join(process.cwd(), "package.json"))(name); } catch {}
    throw error;
  }
}
module.exports = { requireFromSidekick };
