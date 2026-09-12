#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, runSuites } = require("../test/run-all");
const { createProgressReporter } = require("../test/suite-runner");

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  const result = { passed: 0, failed: 1, skipped: 0, exitCode: 2, failures: [], results: [], error: error.message };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
  return;
}
const { requested, options } = parsed;
const json = options.json === true;
runSuites({ requested, ...options, output: { log: (...args) => { if (!json) console.log(...args); }, error: (...args) => console.error(...args) }, onProgress: createProgressReporter({ output: process.stderr, json }) }).then(result => {
  const dir = path.resolve(__dirname, "..", "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
});
