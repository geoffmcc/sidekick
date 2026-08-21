"use strict";

// Compatibility projection retained for old callers. It contains no handler
// ownership; the canonical descriptor registry supplies the implementations.
const { getCanonicalRegistry } = require("./canonical-registry");
const registry = getCanonicalRegistry();
const computeNames = new Set(registry.listInDefinitionOrder()
  .filter(descriptor => descriptor.family === "compute")
  .map(descriptor => descriptor.name));
const TOOLS = Object.freeze(Object.fromEntries(
  Object.entries(registry.toolsMap()).filter(([name]) => computeNames.has(name))
));

module.exports = { TOOLS };
