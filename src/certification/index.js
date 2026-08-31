"use strict";

const { listScenarios } = require("./scenarios");
const { runCertification } = require("./runner");
const { formatCertificationText } = require("./reports");
const { collectReliabilityMetrics } = require("./metrics");
const { createLifecycleExecutor, createLifecycleExecutorFromEnv, runAgentLifecycle } = require("./lifecycle");

module.exports = {
  listScenarios,
  runCertification,
  formatCertificationText,
  collectReliabilityMetrics,
  createLifecycleExecutor,
  createLifecycleExecutorFromEnv,
  createLiveAgentExecutor: createLifecycleExecutor,
  createLiveAgentExecutorFromEnv: createLifecycleExecutorFromEnv,
  runAgentLifecycle,
};
