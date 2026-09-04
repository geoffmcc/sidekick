#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, runSuites } = require("../test/run-all");

const { requested, options } = parseArgs(process.argv.slice(2));
runSuites({ requested, ...options, output: { log: console.log, error: console.error } }).then(result => {
  const dir = path.resolve(__dirname, "..", "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exitCode;
});
