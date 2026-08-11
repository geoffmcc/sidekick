"use strict";

// The guard delegates persistence and event custody to the platform kernel so
// domain modules cannot create a private scope or execution ledger.
const kernel = require("../platform/kernel");

function evaluate(input) {
  return kernel.evaluateScope(input.snapshot_id, input);
}

function bindExecution(executionId, decision) {
  return kernel.bindExecutionScope(executionId, decision);
}

module.exports = Object.freeze({ evaluate, bindExecution });
