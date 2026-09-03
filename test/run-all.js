#!/usr/bin/env node
"use strict";

const { runSuites } = require("./suite-runner");

function parseArgs(args) {
  const requested = [];
  const options = {};
  for (const arg of args) {
    if (arg === "--stream") options.stream = true;
    else if (arg === "--fail-fast") options.failFast = true;
    else if (arg.startsWith("--domain=")) options.domain = arg.slice(9);
    else if (arg.startsWith("--tier=")) options.tier = [...(options.tier || []), ...arg.slice(7).split(",")];
    else if (arg.startsWith("--concurrency=")) options.concurrency = Number(arg.slice(14));
    else if (arg.startsWith("--test-name-pattern=")) options.testNamePattern = arg.slice(20);
    else if (arg === "--json") options.json = true;
    else requested.push(arg);
  }
  return { requested, options };
}

if (require.main === module) {
  const { requested, options } = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  runSuites({ requested, ...options, signal: controller.signal, output: options.json ? { log() {}, error: console.error } : console })
    .then(result => { if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.exitCode; });
}

module.exports = { parseArgs, runSuites };
