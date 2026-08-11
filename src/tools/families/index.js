"use strict";

const utility = require("./utility");
// data-utilities moved to the module system: src/modules/entries/data-utilities.js
// owns its registration now (docs/module-system-design.md, First Proof). The
// implementation file stays under families/ and is consumed by the module entry.
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

const families = Object.freeze([utility, hashing, databaseInspection, storage, memorySync, memoryPortability, memoryLifecycle, memorySession, memoryHandoff, memoryCore, context, filesystem, monitoring]);

// Descriptors owned by extracted families. The registry substitutes these at
// their legacy TOOL_DEFS order position, so ordering here is not significant.
const descriptors = Object.freeze(families.flatMap(family => family.descriptors));

module.exports = { families, descriptors };
