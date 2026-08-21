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
const github = require("./github");
const secret = require("./secret");
const resume = require("./resume");
const teach = require("./teach");
const flowControl = require("./flow-control");
const scheduling = require("./scheduling");
const runbook = require("./runbook");
const evolve = require("./evolve");
const toolCatalog = require("./tool-catalog");
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
const projectRegistry = require("./project-registry");
const capabilityPacks = require("./capability-packs");
const workflowDefinitions = require("./workflow-definitions");
const connectors = require("./connectors");
const workspace = require("./workspace");
const browser = require("./browser");

const families = Object.freeze([utility, hashing, databaseInspection, databaseAdmin, inference, networking, comms, processMgmt, netFetch, observability, shell, development, media, security, meta, knowledge, operations, blackBox, github, secret, resume, teach, flowControl, scheduling, runbook, evolve, toolCatalog, storage, memorySync, memoryPortability, memoryLifecycle, memorySession, memoryHandoff, memoryCore, context, filesystem, monitoring, moduleManagement, projectRegistry, capabilityPacks, workflowDefinitions, connectors, workspace, browser]);

// Descriptors owned by extracted families. The canonical registry places them
// according to canonical-order.js; family declaration order is not a public
// compatibility contract.
const descriptors = Object.freeze(families.flatMap(family => family.descriptors));

module.exports = { families, descriptors };
