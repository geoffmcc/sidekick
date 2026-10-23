#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const policyPath = path.join(root, "docs", "coverage-policy.json");
const requestedDomain = process.env.SIDEKICK_COVERAGE_DOMAIN;
const metrics = ["lines", "statements", "functions", "branches"];

function loadPolicy() {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  if (!Number.isInteger(policy.version) || !policy.minimums || !Array.isArray(policy.security_domains) || !policy.baseline) throw new Error("coverage policy is incomplete");
  return policy;
}

function loadBaseline(policy) {
  const baseline = JSON.parse(fs.readFileSync(path.resolve(root, policy.baseline), "utf8"));
  if (!baseline || !baseline.minimums || !baseline.files) throw new Error("coverage baseline is incomplete");
  return baseline;
}

function relativeFile(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function matchesFile(file, pattern) {
  return relativeFile(file).endsWith(pattern) || String(file).replaceAll(path.sep, "/").endsWith(pattern);
}

function metricValue(value, metric) {
  return value?.[metric]?.pct;
}

function aggregateDomain(summary, domain) {
  const productionFiles = domain.production_files || domain.files || [];
  const files = Object.entries(summary || {}).filter(([file]) => productionFiles.some(pattern => matchesFile(file, pattern)));
  if (!files.length) return null;
  const aggregate = {};
  for (const metric of metrics) {
    const total = files.reduce((sum, [, value]) => sum + (value[metric]?.total || 0), 0);
    const covered = files.reduce((sum, [, value]) => sum + (value[metric]?.covered || 0), 0);
    aggregate[metric] = total ? Number((covered / total * 100).toFixed(2)) : 100;
  }
  return { ...aggregate, files: files.map(([file]) => relativeFile(file)) };
}

function evaluatePolicy(summary, policy, baseline = null) {
  const total = summary?.total || {};
  const coverage = summary ? Object.fromEntries(metrics.map(metric => [metric, total[metric]?.pct])) : null;
  const criticalPatterns = ["src/tools/dispatcher.js", "src/tools/result.js", "src/tools/path-policy.js", "src/tools/policy.js", "src/packs/maturity.js"];
  const critical = {};
  for (const [file, value] of Object.entries(summary || {})) {
    const pattern = criticalPatterns.find(item => matchesFile(file, item));
    if (pattern) critical[pattern] = Object.fromEntries(metrics.map(metric => [metric, metricValue(value, metric)]));
  }
  const criticalMissing = criticalPatterns.filter(pattern => !critical[pattern]);
  const criticalFailures = Object.entries(critical).filter(([, value]) => value.lines < 80 || value.branches < 60).map(([file, value]) => ({ file, ...value }));
  const reportedFiles = Object.keys(summary || {});
  const requiredFiles = (policy.required_files || []).filter(required => !reportedFiles.some(file => matchesFile(file, required)));
  const requiredFragments = (policy.required_fragments || []).filter(fragment => !reportedFiles.some(file => matchesFile(file, fragment) || relativeFile(file).includes(fragment)));
  const security = Object.fromEntries(policy.security_domains.map(domain => {
    const result = aggregateDomain(summary, domain);
    const productionFiles = domain.production_files || domain.files || [];
    const missingFiles = productionFiles.filter(required => !reportedFiles.some(file => matchesFile(file, required)));
    const failures = result ? Object.entries(domain.minimums || {}).filter(([metric, threshold]) => result[metric] < threshold).map(([metric, threshold]) => ({ metric, actual: result[metric], threshold })) : [];
    if (missingFiles.length) failures.push({ metric: "files", actual: missingFiles.length, threshold: 0, missing: missingFiles });
    const fileResults = Object.fromEntries(productionFiles.map(file => {
      const entry = reportedFiles.find(reported => matchesFile(reported, file));
      const value = entry ? summary[entry] : null;
      const minimums = domain.file_minimums?.[file] || {};
      const fileFailures = value ? Object.entries(minimums).filter(([metric, threshold]) => metricValue(value, metric) < threshold).map(([metric, threshold]) => ({ metric, actual: metricValue(value, metric), threshold })) : [{ metric: "coverage", actual: null, threshold: 0 }];
      return [file, { coverage: value ? Object.fromEntries(metrics.map(metric => [metric, metricValue(value, metric)])) : null, minimums, failures: fileFailures }];
    }));
    for (const [file, value] of Object.entries(fileResults)) for (const failure of value.failures) failures.push({ file, ...failure });
    return [domain.name, { ...result, production_files: productionFiles, missing_files: missingFiles, minimums: domain.minimums, files: fileResults, failures }];
  }));
  const baselineFailures = baseline ? Object.entries(baseline.minimums).filter(([metric, threshold]) => coverage?.[metric] < threshold).map(([metric, threshold]) => ({ metric, actual: coverage?.[metric], threshold })) : [{ metric: "baseline", actual: null, threshold: "checked-in baseline" }];
  if (baseline) for (const [file, thresholds] of Object.entries(baseline.files)) {
    const current = Object.values(security).flatMap(domain => Object.entries(domain.files || {})).find(([name]) => name === file)?.[1]?.coverage;
    if (!current) baselineFailures.push({ file, metric: "coverage", actual: null, threshold: "baseline" });
    else for (const [metric, threshold] of Object.entries(thresholds)) if (current[metric] < threshold) baselineFailures.push({ file, metric, actual: current[metric], threshold });
  }
  return { coverage, critical, critical_missing: criticalMissing, critical_failures: criticalFailures, security, policy: { version: policy.version, minimums: policy.minimums, security_domains: policy.security_domains }, security_failures: Object.values(security).flatMap(value => value.failures), missing_required_files: requiredFiles, missing_required_fragments: requiredFragments, baseline_failures: baselineFailures, missing_policy: false };
}

function coverageInvocation(args) {
  return { command: process.execPath, args: [require.resolve("c8/bin/c8.js"), ...args] };
}

function coveragePaths(baseDir, { runId = process.env.GITHUB_RUN_ID || "local", attempt = process.env.GITHUB_RUN_ATTEMPT || "1", pid = process.pid, timestamp = Date.now() } = {}) {
  const segment = (value, maxLength) => String(value).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, maxLength) || "unknown";
  const runKey = `${segment(runId, 24)}-${segment(attempt, 5)}-${segment(pid, 8)}-${segment(timestamp, 14)}`;
  const runDir = path.join(baseDir, "artifacts", "coverage-runs", runKey);
  return { runDir, summaryPath: path.join(runDir, "coverage-summary.json"), tempPrefix: `sidekick-c8-${runKey}-` };
}

function main() {
  const policy = loadPolicy();
  const paths = coveragePaths(root);
  const { summaryPath } = paths;
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), paths.tempPrefix));
  const args = ["--all", "--include=src/**/*.js", "--include=packs/**/*.js", "--exclude=dist/**", "--exclude=test/**", "--exclude=artifacts/**", "--reporter=text", "--reporter=json-summary", "--reports-dir", reportsDir, "--check-coverage", "--lines", String(policy.minimums.lines), "--statements", String(policy.minimums.statements), "--functions", String(policy.minimums.functions), "--branches", String(policy.minimums.branches), "node", "test/run-all.js"];
  if (requestedDomain) args.push(`--domain=${requestedDomain}`);
  fs.mkdirSync(reportsDir, { recursive: true });
  // Keep the suite runner's heartbeat and per-suite progress visible while
  // coverage is running. Capturing c8 with spawnSync makes a multi-minute run
  // look idle and hides all progress until the process exits.
  const invocation = coverageInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, stdio: "inherit", timeout: 45 * 60 * 1000, env: { ...process.env, NODE_ENV: "test" } });
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(path.join(reportsDir, "coverage-summary.json"), "utf8")); } catch {}
  try { fs.rmSync(reportsDir, { recursive: true, force: true }); } catch (error) { console.error(`Could not remove this run's temporary coverage directory: ${error.message}`); }
  let baseline = null;
  try { baseline = loadBaseline(policy); } catch (error) { console.error(`Coverage baseline unavailable: ${error.message}`); }
  const evaluated = evaluatePolicy(summary, policy, baseline);
  const report = { version: 6, mode: "c8-subprocess-merged", scope: requestedDomain || "standard", ...evaluated, passed: result.status === 0 && Boolean(summary) && evaluated.critical_missing.length === 0 && evaluated.critical_failures.length === 0 && evaluated.security_failures.length === 0 && evaluated.missing_required_files.length === 0 && evaluated.missing_required_fragments.length === 0 && evaluated.baseline_failures.length === 0, exit_code: result.status, signal: result.signal };
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Coverage result: ${path.relative(root, summaryPath).replaceAll(path.sep, "/")}`);
  if (evaluated.coverage) console.log(`Coverage policy v${policy.version}: lines ${evaluated.coverage.lines}%, branches ${evaluated.coverage.branches}%, functions ${evaluated.coverage.functions}%`);
  else console.error("Coverage report was unavailable");
  if (result.error) console.error(`Coverage runner could not start: ${result.error.message}`);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { aggregateDomain, coverageInvocation, coveragePaths, evaluatePolicy, loadBaseline, loadPolicy };
