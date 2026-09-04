#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const reportsDir = path.join(root, "artifacts", "coverage");
const c8 = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "c8.cmd" : "c8");
const requestedDomain = process.env.SIDEKICK_COVERAGE_DOMAIN;
const args = ["--all", "--include=src/**/*.js", "--include=packs/**/*.js", "--exclude=dist/**", "--exclude=test/**", "--exclude=artifacts/**", "--reporter=text", "--reporter=json-summary", "--reports-dir", reportsDir, "--check-coverage", "--lines", "40", "--statements", "40", "--functions", "40", "--branches", "20", "node", "test/run-all.js"];
if (requestedDomain) args.push(`--domain=${requestedDomain}`);

fs.rmSync(reportsDir, { recursive: true, force: true });
fs.mkdirSync(reportsDir, { recursive: true });
const result = spawnSync(c8, args, { cwd: root, encoding: "utf8", timeout: 45 * 60 * 1000, env: { ...process.env, NODE_ENV: "test" } });
const summaryPath = path.join(reportsDir, "coverage-summary.json");
let summary = null;
try { summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")); } catch {}
const total = summary?.total || {};
const coverage = summary ? { lines: total.lines?.pct, statements: total.statements?.pct, functions: total.functions?.pct, branches: total.branches?.pct } : null;
const report = { version: 3, mode: "c8-subprocess-merged", scope: requestedDomain || "standard", coverage, policy: { lines: 40, statements: 40, functions: 40, branches: 20 }, passed: result.status === 0 && Boolean(summary), exit_code: result.status, signal: result.signal };
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(root, "artifacts", "coverage-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
if (coverage) console.log(`Coverage: lines ${coverage.lines}%, branches ${coverage.branches}%, functions ${coverage.functions}%`);
else console.error("Coverage report was unavailable");
if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr.slice(-4000));
if (!report.passed) process.exitCode = 1;
