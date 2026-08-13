"use strict";

/**
 * Dependency resolution for the security-research pack module.
 *
 * A pack module runs from the managed store, which may sit outside the Sidekick
 * repository, so a bare `require("zod")` is not guaranteed to resolve, and a
 * relative require cannot reach Sidekick source. Resolve against the running
 * Sidekick installation instead of vendoring a second copy of anything Sidekick
 * already loads — resolving Sidekick source this way returns the SAME module
 * instance the server itself loaded (reuse, not a copy), which is what lets the
 * pack share the kernel's single database and event ledger.
 *
 * This mirrors the Proxmox pack's deps.js deliberately: the install-root path
 * derived from __dirname is preferred over process.cwd() so a process launched
 * from an attacker-writable directory cannot shadow the real Sidekick source.
 */

const path = require("path");
const Module = require("module");

const CANDIDATE_ROOTS = [path.resolve(__dirname, "..", "..", "..", "..", ".."), process.cwd()];

function requireFromSidekick(name) {
  try {
    return require(name);
  } catch (error) {
    for (const root of CANDIDATE_ROOTS) {
      try {
        const resolver = Module.createRequire(path.join(root, "package.json"));
        return resolver(name);
      } catch {}
    }
    throw error;
  }
}

function requireSidekickSrc(relPath) {
  let lastError = null;
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
