"use strict";

const dbStore = require("../db");
const { createContextEngine, DEFAULT_BUDGET } = require("./engine");
const { createConsolidator } = require("./consolidation");

const engine = createContextEngine({ dbStore });
const consolidator = createConsolidator({ dbStore });

module.exports = Object.freeze({
  DEFAULT_BUDGET,
  createContextEngine,
  createConsolidator,
  engine,
  consolidator,
  assembleContext: engine.assemble,
  consolidateMemory: consolidator.consolidate,
  getConsolidationCandidate: consolidator.getCandidate,
  promoteConsolidationCandidate: consolidator.promote,
});
