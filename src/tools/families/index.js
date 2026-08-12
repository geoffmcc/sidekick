"use strict";

const utility = require("./utility");
// data-utilities moved to the module system: src/modules/entries/data-utilities.js
// owns its registration now (docs/module-system-design.md, First Proof). The
// implementation file stays under families/ and is consumed by the module entry.
const hashing = require("./hashing");
const databaseInspection = require("./database-inspection");
const databaseAdmin = require("./database-admin");
const inference = require("./inference");
const networking = require("./networking");
const comms = require("./comms");
const processMgmt = require("./process-mgmt");
const netFetch = require("./net-fetch");
const observability = require("./observability");
const shell = require("./shell");
const development = require("./development");
const media = require("./media");
const security = require("./security");
const meta = require("./meta");
const knowledge = require("./knowledge");
const operations = require("./operations");
const blackBox = require("./black-box");
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
const moduleManagement = require("./module-management");

const families = Object.freeze([utility, hashing, databaseInspection, databaseAdmin, inference, networking, comms, processMgmt, netFetch, observability, shell, development, media, security, meta, knowledge, operations, blackBox, storage, memorySync, memoryPortability, memoryLifecycle, memorySession, memoryHandoff, memoryCore, context, filesystem, monitoring, moduleManagement]);

// Descriptors owned by extracted families. The registry substitutes these at
// their legacy TOOL_DEFS order position, so ordering here is not significant.
const descriptors = Object.freeze(families.flatMap(family => family.descriptors));

module.exports = { families, descriptors };
