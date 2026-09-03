#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { discoverSuites } = require("../test/suite-runner");

const root = path.resolve(__dirname, "..");
const requestedDomain = process.env.SIDEKICK_COVERAGE_DOMAIN;
const files = discoverSuites(root).filter(suite => !requestedDomain || suite.domain === requestedDomain).map(suite => path.resolve(root, suite.file));
const result = spawnSync(process.execPath, ["--experimental-test-coverage", "--test", "--test-concurrency=1", ...files], { cwd: root, encoding: "utf8", timeout: 900000 });
const output = `${result.stdout || ""}${result.stderr || ""}`;
const match = output.match(/# all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/);
const coverage = match ? { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]), statements: Number(match[1]) } : null;
const policy = { lines: 40, statements: 40, functions: 40, branches: 20 };
const report = { version: 1, mode: "node-built-in-test-coverage", scope: requestedDomain || "all", suites: files.length, coverage, policy, passed: Boolean(coverage && Object.entries(policy).every(([key, minimum]) => coverage[key] >= minimum)), exit_code: result.status, output_tail: output.slice(-4000) };
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(root, "artifacts", "coverage-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(coverage ? `Coverage: lines ${coverage.lines}%, branches ${coverage.branches}%, functions ${coverage.functions}%` : "Coverage report was unavailable");
if (result.status !== 0 || !report.passed) process.exitCode = 1;
