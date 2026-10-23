#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, runSuites } = require("../test/run-all");
const { createProgressReporter } = require("../test/suite-runner");

function testResultPath(baseDir, { runId = process.env.GITHUB_RUN_ID || "local", attempt = process.env.GITHUB_RUN_ATTEMPT || "1", pid = process.pid, timestamp = Date.now() } = {}) {
  const segment = (value, maxLength) => String(value).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, maxLength) || "unknown";
  const runKey = `${segment(runId, 24)}-${segment(attempt, 5)}-${segment(pid, 8)}-${segment(timestamp, 14)}`;
  return path.join(baseDir, "artifacts", "test-runs", runKey, "test-results.json");
}

function writeTestResult(baseDir, result, options) {
  const outputPath = testResultPath(baseDir, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return outputPath;
}

function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const result = { passed: 0, failed: 1, skipped: 0, exitCode: 2, failures: [], results: [], error: error.message };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
    return;
  }
  const { requested, options } = parsed;
  const json = options.json === true;
  runSuites({ requested, ...options, output: { log: (...args) => { if (!json) console.log(...args); }, error: (...args) => console.error(...args) }, onProgress: createProgressReporter({ output: process.stderr, json }) }).then(result => {
    writeTestResult(path.resolve(__dirname, ".."), result);
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  });
}

if (require.main === module) main();

module.exports = { main, testResultPath, writeTestResult };
