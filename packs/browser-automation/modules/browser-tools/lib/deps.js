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

function requireFromSidekick(name) {
  try {
    return require(name);
  } catch (error) {
    const roots = [process.cwd(), path.resolve(__dirname, "..", "..", "..", "..", "..")];
    for (const root of roots) {
      try {
        const resolver = Module.createRequire(path.join(root, "package.json"));
        return resolver(name);
      } catch {}
    }
    throw error;
  }
}

module.exports = { requireFromSidekick };
