"use strict";
const path = require("path");
const Module = require("module");
function requireFromSidekick(name) {
  try { return require(name); } catch (error) {
    for (const root of [process.cwd(), path.resolve(__dirname, "..", "..", "..", "..", "..")]) {
      try { return Module.createRequire(path.join(root, "package.json"))(name); } catch {}
    }
    throw error;
  }
}
module.exports = { requireFromSidekick };
