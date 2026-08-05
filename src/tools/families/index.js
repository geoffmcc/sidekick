"use strict";

const utility = require("./utility");
const dataUtilities = require("./data-utilities");
const hashing = require("./hashing");
const databaseInspection = require("./database-inspection");
const storage = require("./storage");
const memorySync = require("./memory-sync");
const memoryPortability = require("./memory-portability");
const memoryLifecycle = require("./memory-lifecycle");
const memorySession = require("./memory-session");
const memoryHandoff = require("./memory-handoff");
const memoryCore = require("./memory-core");
const context = require("./context");
const filesystem = require("./filesystem");
const monitoring = require("./monitoring");

const families = Object.freeze([utility, dataUtilities, hashing, databaseInspection, storage, memorySync, memoryPortability, memoryLifecycle, memorySession, memoryHandoff, memoryCore, context, filesystem, monitoring]);

// Descriptors owned by extracted families. The registry substitutes these at
// their legacy TOOL_DEFS order position, so ordering here is not significant.
const descriptors = Object.freeze(families.flatMap(family => family.descriptors));

module.exports = { families, descriptors };
