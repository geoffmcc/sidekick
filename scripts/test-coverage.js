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
const criticalPatterns = ["src/tools/dispatcher.js", "src/tools/result.js", "src/tools/path-policy.js", "src/tools/policy.js", "src/packs/maturity.js"];
const critical = {};
for (const [file, value] of Object.entries(summary || {})) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  const pattern = criticalPatterns.find(item => item === relative);
  if (pattern) critical[pattern] = { lines: value.lines?.pct, branches: value.branches?.pct, functions: value.functions?.pct, statements: value.statements?.pct };
}
const criticalMissing = criticalPatterns.filter(pattern => !critical[pattern]);
const criticalFailures = Object.entries(critical).filter(([, value]) => value.lines < 80 || value.branches < 60).map(([file, value]) => ({ file, ...value }));
const report = { version: 4, mode: "c8-subprocess-merged", scope: requestedDomain || "standard", coverage, critical, critical_missing: criticalMissing, critical_failures: criticalFailures, policy: { lines: 40, statements: 40, functions: 40, branches: 20, critical_lines: 80, critical_branches: 60 }, passed: result.status === 0 && Boolean(summary) && criticalMissing.length === 0 && criticalFailures.length === 0, exit_code: result.status, signal: result.signal };
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(root, "artifacts", "coverage-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
if (coverage) console.log(`Coverage: lines ${coverage.lines}%, branches ${coverage.branches}%, functions ${coverage.functions}%`);
else console.error("Coverage report was unavailable");
if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr.slice(-4000));
if (!report.passed) process.exitCode = 1;
