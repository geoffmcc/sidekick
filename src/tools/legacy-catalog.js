"use strict";

// Compatibility projection retained for older consumers. Canonical
// descriptors and the explicit canonical order own the metadata and ordering.
const { getCanonicalRegistry } = require("./canonical-registry");

const TOOL_DEFS = getCanonicalRegistry().toolDefs();

module.exports = { TOOL_DEFS };
