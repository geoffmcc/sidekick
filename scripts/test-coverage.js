#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const reportsDir = path.join(root, "artifacts", "coverage");
const c8 = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "c8.cmd" : "c8");
const policyPath = path.join(root, "docs", "coverage-policy.json");
const requestedDomain = process.env.SIDEKICK_COVERAGE_DOMAIN;

function loadPolicy() {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  if (!Number.isInteger(policy.version) || !policy.minimums || !policy.security_domains) throw new Error("coverage policy is incomplete");
  return policy;
}

function aggregateDomain(summary, domain) {
  const files = Object.entries(summary || {}).filter(([file]) => domain.files.some(pattern => file.replaceAll(path.sep, "/").endsWith(pattern)));
  if (!files.length) return null;
  const aggregate = {};
  for (const metric of ["lines", "statements", "functions", "branches"]) {
    const total = files.reduce((sum, [, value]) => sum + (value[metric]?.total || 0), 0);
    const covered = files.reduce((sum, [, value]) => sum + (value[metric]?.covered || 0), 0);
    aggregate[metric] = total ? Number((covered / total * 100).toFixed(2)) : 100;
  }
  return { ...aggregate, files: files.map(([file]) => path.relative(root, file).replaceAll(path.sep, "/")) };
}

function evaluatePolicy(summary, policy) {
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
  const security = Object.fromEntries(policy.security_domains.map(domain => {
    const result = aggregateDomain(summary, domain);
    const failures = result ? Object.entries(domain.minimums).filter(([metric, threshold]) => result[metric] < threshold).map(([metric, threshold]) => ({ metric, actual: result[metric], threshold })) : [{ metric: "files", actual: 0, threshold: 1 }];
    return [domain.name, { ...result, minimums: domain.minimums, failures }];
  }));
  return { coverage, critical, critical_missing: criticalMissing, critical_failures: criticalFailures, security, policy: { version: policy.version, minimums: policy.minimums, security_domains: policy.security_domains }, security_failures: Object.values(security).flatMap(value => value.failures), missing_policy: false };
}

function main() {
  const policy = loadPolicy();
  const args = ["--all", "--include=src/**/*.js", "--include=packs/**/*.js", "--exclude=dist/**", "--exclude=test/**", "--exclude=artifacts/**", "--reporter=text", "--reporter=json-summary", "--reports-dir", reportsDir, "--check-coverage", "--lines", String(policy.minimums.lines), "--statements", String(policy.minimums.statements), "--functions", String(policy.minimums.functions), "--branches", String(policy.minimums.branches), "node", "test/run-all.js"];
  if (requestedDomain) args.push(`--domain=${requestedDomain}`);
  fs.rmSync(reportsDir, { recursive: true, force: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  const result = spawnSync(c8, args, { cwd: root, encoding: "utf8", timeout: 45 * 60 * 1000, env: { ...process.env, NODE_ENV: "test" } });
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(path.join(reportsDir, "coverage-summary.json"), "utf8")); } catch {}
  const evaluated = evaluatePolicy(summary, policy);
  const report = { version: 5, mode: "c8-subprocess-merged", scope: requestedDomain || "standard", ...evaluated, passed: result.status === 0 && Boolean(summary) && evaluated.critical_missing.length === 0 && evaluated.critical_failures.length === 0 && evaluated.security_failures.length === 0, exit_code: result.status, signal: result.signal };
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts", "coverage-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (evaluated.coverage) console.log(`Coverage policy v${policy.version}: lines ${evaluated.coverage.lines}%, branches ${evaluated.coverage.branches}%, functions ${evaluated.coverage.functions}%`);
  else console.error("Coverage report was unavailable");
  if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr.slice(-4000));
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { aggregateDomain, evaluatePolicy, loadPolicy };
