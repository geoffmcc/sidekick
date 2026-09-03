#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { discoverSuites, runSuites } = require("../test/suite-runner");

const root = path.resolve(__dirname, "..");
const requestedDomain = process.env.SIDEKICK_COVERAGE_DOMAIN;
const suites = discoverSuites(root).filter(suite => !requestedDomain || suite.domain === requestedDomain);
const policy = { lines: 40, statements: 40, functions: 40, branches: 20 };
const allFileCoverage = /# all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/;

runSuites({ requested: suites.map(suite => suite.file), coverage: true, concurrency: 1, output: { log() {}, error() {} } }).then(result => {
  const metrics = result.results.map(item => {
    const match = item.stdout.match(allFileCoverage);
    return match ? { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]), statements: Number(match[1]) } : null;
  }).filter(Boolean);
  const coverage = metrics.length ? Object.fromEntries(Object.keys(policy).map(key => [key, Number((metrics.reduce((sum, item) => sum + item[key], 0) / metrics.length).toFixed(2))])) : null;
  const report = { version: 2, mode: "node-built-in-test-coverage-per-suite", scope: requestedDomain || "all", suites: suites.length, instrumented_suites: metrics.length, coverage, policy, passed: Boolean(coverage && result.exitCode === 0 && Object.entries(policy).every(([key, minimum]) => coverage[key] >= minimum)), test_failures: result.failures.map(item => ({ suite: item.suite, status: item.status })), unexpected_skips: result.unexpected_skips };
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts", "coverage-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(coverage ? `Coverage: lines ${coverage.lines}%, branches ${coverage.branches}%, functions ${coverage.functions}%` : "Coverage report was unavailable");
  if (!report.passed) process.exitCode = 1;
}).catch(error => { console.error(`Coverage runner failed: ${error.message}`); process.exitCode = 1; });
