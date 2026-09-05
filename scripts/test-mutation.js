#!/usr/bin/env node
"use strict";

// Small, deterministic mutation runner. Mutants are always applied to a
// disposable source copy; the authoritative checkout is never modified.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const reportDir = path.join(root, "artifacts");
const targetedSpecs = [
  { file: "src/core/project-identity.js", tests: ["test/project-identity.test.js", "test/identity-authorization.test.js"], pattern: [
    { name: "canonical-case-change", from: ".toLowerCase()", to: ".toUpperCase()", security: true },
    { name: "separator-validation-removal", from: ".replace(/[^a-z0-9_]+/g, \"_\")", to: ".replace(/[^a-z0-9_]+/g, \"\")", security: true },
  ] },
  { file: "src/tools/path-policy.js", tests: ["test/tools.test.js"], pattern: [
    { name: "allowlist-gate-removal", from: "if (allowedEntries.length > 0) {", to: "if (false && allowedEntries.length > 0) {", security: true },
  ] },
  { file: "src/tools/result.js", tests: ["test/tool-result-structure.test.js", "test/sensitive-result-boundary.test.js"], pattern: [
    { name: "partial-status-removal", from: "status === \"succeeded\" || status === \"partial\"", to: "status === \"succeeded\" && status === \"partial\"", security: true },
    { name: "result-bound-change", from: "warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 50)", to: "warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 51)", security: true },
  ] },
  { file: "src/packs/maturity.js", tests: ["test/pack-maturity.test.js"], pattern: [
    { name: "freshness-negation", from: "now - observed >= 0 && now - observed <= MAX_EVIDENCE_AGE_MS", to: "now - observed >= 0 && now - observed > MAX_EVIDENCE_AGE_MS" },
    { name: "health-gate-removal", from: "record.state === \"enabled\" && health.ok === true && health.status === \"healthy\"", to: "record.state === \"enabled\" || health.ok === true || health.status === \"healthy\"" },
  ] },
];

// The full inventory deliberately adds boundary mutations rather than merely
// changing the label or rerunning the targeted inventory.
const fullSpecs = [
  { file: "src/core/authorization.js", tests: ["test/identity-authorization.test.js", "test/security-phase-03-auth-authorization.test.js"], pattern: [
    { name: "disabled-principal-gate-removal", from: "if (!principal.enabled) return { ok: false, code: \"principal-disabled\", permissions: new Set() };", to: "if (false) return { ok: false, code: \"principal-disabled\", permissions: new Set() };", security: true },
  ] },
  { file: "src/tools/result.js", tests: ["test/tool-result-structure.test.js", "test/sensitive-result-boundary.test.js"], pattern: [
    { name: "result-bound-shrink", from: "warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 50)", to: "warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 49)", security: true },
  ] },
];

function getSpecs(mode = process.env.SIDEKICK_MUTATION_FULL === "1" ? "full" : "targeted") {
  return mode === "full" ? [...targetedSpecs, ...fullSpecs] : targetedSpecs;
}

function copySource(destination) {
  fs.cpSync(root, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      return relative !== ".git" && relative !== "node_modules" && !relative.startsWith("artifacts") && !relative.startsWith("data") && !relative.startsWith("test/test-");
    },
  });
}

function runMutant(spec, mutation, destination) {
  const file = path.join(destination, spec.file);
  const original = fs.readFileSync(file, "utf8");
  if (!original.includes(mutation.from)) return { status: "uncovered", reason: "mutation pattern not present" };
  const line = original.slice(0, original.indexOf(mutation.from)).split("\n").length;
  fs.writeFileSync(file, original.replace(mutation.from, mutation.to));
  const result = spawnSync(process.execPath, ["test/run-all.js", ...spec.tests], {
    cwd: destination,
    env: { ...process.env, NODE_PATH: path.join(root, "node_modules"), NODE_ENV: "test", SIDEKICK_TEST_OVERALL_TIMEOUT_MS: "120000" },
    encoding: "utf8",
    timeout: 150000,
  });
  return { status: result.status === 0 ? "survived" : result.signal ? "timeout" : "killed", line, exit_code: result.status, signal: result.signal };
}

function buildReport(results, mode) {
  const attempted = results.filter(item => item.status !== "uncovered").length;
  const killed = results.filter(item => item.status === "killed").length;
  const securityResults = results.filter(item => item.security);
  const securityAttempted = securityResults.filter(item => item.status !== "uncovered").length;
  const securityKilled = securityResults.filter(item => item.status === "killed").length;
  const securityScore = securityAttempted ? Number((securityKilled / securityAttempted * 100).toFixed(2)) : 0;
  return {
    version: 3,
    mode,
    inventory: { targeted: targetedSpecs.length, full: targetedSpecs.length + fullSpecs.length },
    attempted,
    killed,
    survived: results.filter(item => item.status === "survived").length,
    timed_out: results.filter(item => item.status === "timeout").length,
    uncovered: results.filter(item => item.status === "uncovered").length,
    mutation_score: attempted ? Number((killed / attempted * 100).toFixed(2)) : 0,
    threshold: 60,
    security_attempted: securityAttempted,
    security_killed: securityKilled,
    security_survived: securityResults.filter(item => item.status === "survived").length,
    security_timed_out: securityResults.filter(item => item.status === "timeout").length,
    security_uncovered: securityResults.filter(item => item.status === "uncovered").length,
    security_score: securityScore,
    security_threshold: 60,
    surviving_mutations: results.filter(item => item.status === "survived"),
    results,
    reproduction: "SIDEKICK_MUTATION_FULL=1 npm run test:mutation",
  };
}

function shouldFail(report) {
  return !report.attempted || report.mutation_score < report.threshold || report.timed_out
    || !report.security_attempted || report.security_score < report.security_threshold || report.security_timed_out;
}

function main() {
  const mode = process.env.SIDEKICK_MUTATION_FULL === "1" ? "full" : "targeted";
  const results = [];
  for (const spec of getSpecs(mode)) {
    if (!fs.existsSync(path.join(root, spec.file))) continue;
    for (const mutation of spec.pattern) {
      const destination = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-mutant-"));
      try { copySource(destination); results.push({ file: spec.file, tests: spec.tests, mutation: mutation.name, security: Boolean(mutation.security), ...runMutant(spec, mutation, destination) }); }
      finally { fs.rmSync(destination, { recursive: true, force: true }); }
    }
  }
  const report = buildReport(results, mode);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "mutation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Mutation testing: ${report.killed}/${report.attempted} killed (${report.mutation_score}%), ${report.survived} survived, ${report.uncovered} uncovered`);
  console.log(`Security mutants: ${report.security_killed}/${report.security_attempted} killed (${report.security_score}%), ${report.security_survived} survived`);
  if (shouldFail(report)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { buildReport, getSpecs, shouldFail };
