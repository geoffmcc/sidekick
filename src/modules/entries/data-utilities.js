"use strict";

/**
 * data-utilities platform module (docs/module-system-design.md, First Proof).
 *
 * The first real module entry: the already-extracted data-utilities family
 * registered through the module system instead of the builtin family list.
 * The implementation stays in src/tools/families/data-utilities.js — this
 * entry only declares the manifest and adapts the family's descriptors for
 * the loader, which registers them into the single builtin registry path.
 *
 * The handlers are self-contained (no dispatch fan-out), so the manifest
 * declares no permissions: under deny-by-default the module cannot dispatch
 * anything through its service facade.
 */

const family = require("../../tools/families/data-utilities");

const MANIFEST = Object.freeze({
  name: "data-utilities",
  version: "1.0.0",
  description: "Structured data tools: parse, extract, transform, diff, validate, and template",
  type: "builtin",
  tools: {
    parse: { risk: "low", category: "Data Pipeline" },
    extract: { risk: "medium", category: "Data Pipeline" },
    transform: { risk: "low", category: "Data Pipeline" },
    diff: { risk: "low", category: "Data Pipeline" },
    validate: { risk: "low", category: "Data Pipeline" },
    template: { risk: "low", category: "Data Pipeline" },
  },
  permissions: [],
});

const entry = {
  buildDescriptors() {
    return family.descriptors.map(descriptor => ({ ...descriptor }));
  },
};

module.exports = { MANIFEST, entry };
