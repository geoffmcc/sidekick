"use strict";

const path = require("path");
const Module = require("module");
const CANDIDATE_ROOTS = [path.resolve(__dirname, "..", "..", "..", "..", ".."), process.cwd()];

function requireFromSidekick(name) {
  try { return require(name); } catch (error) {
    for (const root of CANDIDATE_ROOTS) {
      try { return Module.createRequire(path.join(root, "package.json"))(name); } catch {}
    }
    throw error;
  }
}

function requireSidekickSrc(relative) {
  let lastError;
  for (const root of CANDIDATE_ROOTS) {
    try { return require(path.join(root, relative)); } catch (error) { lastError = error; }
  }
  throw lastError || new Error(`Cannot resolve Sidekick source module: ${relative}`);
}

module.exports = { requireSidekickSrc, requireFromSidekick };
