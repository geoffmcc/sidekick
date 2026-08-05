"use strict";

const utility = require("./utility");
const dataUtilities = require("./data-utilities");
const hashing = require("./hashing");
const databaseInspection = require("./database-inspection");
const storage = require("./storage");
const memorySync = require("./memory-sync");

const families = Object.freeze([utility, dataUtilities, hashing, databaseInspection, storage, memorySync]);

// Descriptors owned by extracted families. The registry substitutes these at
// their legacy TOOL_DEFS order position, so ordering here is not significant.
const descriptors = Object.freeze(families.flatMap(family => family.descriptors));

module.exports = { families, descriptors };
