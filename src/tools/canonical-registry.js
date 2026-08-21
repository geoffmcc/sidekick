"use strict";

const { buildBuiltinRegistry } = require("./registry");
const { descriptors: familyDescriptors } = require("./families");
const compute = require("./families/compute");
const { CANONICAL_TOOL_ORDER } = require("./canonical-order");

const descriptors = Object.freeze([...familyDescriptors, ...compute.descriptors]);

function getCanonicalRegistry({ includeActiveModules = false } = {}) {
  return buildBuiltinRegistry({
    descriptors,
    definitionOrder: CANONICAL_TOOL_ORDER,
    includeActiveModules,
  });
}

module.exports = { descriptors, getCanonicalRegistry };
