"use strict";

const path = require("path");
const Module = require("module");

// A managed pack may run outside the source checkout. Resolve dependencies
// from the installation root derived from this file first; only use cwd as a
// compatibility fallback for development. This avoids both a Linux-only path
// assumption and letting an attacker-controlled launch directory take
// precedence over the Sidekick installation.
const CANDIDATE_ROOTS = [
  path.resolve(__dirname, "..", "..", "..", "..", ".."),
  process.cwd(),
];

function requireFromSidekick(name) {
  let lastError;
  for (const root of CANDIDATE_ROOTS) {
    try {
      const resolver = Module.createRequire(path.join(root, "package.json"));
      return resolver(name);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Cannot resolve Sidekick dependency: ${name}`);
}

function requireSidekickSrc(relPath) {
  let lastError;
  for (const root of CANDIDATE_ROOTS) {
    try {
      return require(path.join(root, relPath));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Cannot resolve Sidekick source module: ${relPath}`);
}

module.exports = { requireFromSidekick, requireSidekickSrc };
