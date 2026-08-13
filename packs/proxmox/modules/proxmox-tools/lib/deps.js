"use strict";

/**
 * Dependency resolution for a pack module.
 *
 * A pack module runs from the managed store, which may sit outside the Sidekick
 * repository, so a bare `require("zod")` is not guaranteed to resolve. Resolve
 * against the running Sidekick installation as a fallback rather than vendoring
 * a second copy of a dependency Sidekick already loads.
 */

const path = require("path");
const Module = require("module");

// Prefer the install root derived from THIS file's location over the process
// cwd. Loading Sidekick source (e.g. the secret resolver) from a cwd-relative
// path would let a process mistakenly launched from an attacker-writable
// directory shadow the real module; the install-root path cannot be chosen by
// the launch directory. cwd remains only as a last-resort fallback.
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

/**
 * Resolve a module inside Sidekick's own source tree (e.g.
 * "src/connectors/resolve.js"). The managed pack store is not the repository,
 * so a relative require cannot reach Sidekick source from here; the running
 * installation's root can. Resolving Sidekick source this way returns the SAME
 * module instance the server itself loaded — it is reuse, not a copy.
 */
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
