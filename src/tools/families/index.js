"use strict";

const utility = require("./utility");
const dataUtilities = require("./data-utilities");

const families = Object.freeze([utility, dataUtilities]);

// Descriptors owned by extracted families. The registry substitutes these at
// their legacy TOOL_DEFS order position, so ordering here is not significant.
const descriptors = Object.freeze(families.flatMap(family => family.descriptors));

module.exports = { families, descriptors };
