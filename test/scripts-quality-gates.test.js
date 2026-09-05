"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { applyMutation, buildReport, getSpecs, loadPolicy, shouldFail } = require("../scripts/test-mutation");
const { evaluatePolicy, loadPolicy: loadCoveragePolicy } = require("../scripts/test-coverage");
const { importSpecifiers, selectChangedTests } = require("../scripts/test-changed");
const { buildFlakeReport, classifyHistory } = require("../scripts/test-flake");

test("full mutation mode has a larger inventory and security tags", () => {
  const targeted = getSpecs("targeted").flatMap(spec => spec.pattern);
  const full = getSpecs("full").flatMap(spec => spec.pattern);
  assert.ok(full.length > targeted.length);
  assert.ok(full.some(mutant => mutant.security));
  assert.ok(targeted.some(mutant => mutant.security));
});

test("mutation gate fails closed when no security mutant was attempted", () => {
  const report = buildReport([{ status: "killed", security: false }], "targeted");
  assert.equal(report.security_attempted, 0);
  assert.equal(report.security_score, 0);
  assert.equal(shouldFail(report), true);
});

test("mutation inventory uses structured AST regions and covers policy categories", () => {
  const policy = loadPolicy();
  const mutations = getSpecs("full").flatMap(spec => spec.pattern);
  assert.ok(mutations.every(mutation => mutation.kind && mutation.expression && mutation.replacement));
  for (const category of policy.required_categories) assert.ok(mutations.some(mutation => mutation.category === category), `missing category ${category}`);
  assert.equal(applyMutation("const value = left && right;", { kind: "operator", expression: "left && right", operator: "&&", replacement: "||" }).status, "applied");
});

test("false-positive mutation outcomes are not assertion kills", () => {
  const report = buildReport([
    { status: "syntax_error", security: true, group: "x", mutation: "syntax" },
    { status: "infrastructure_error", security: true, group: "x", mutation: "infra" },
    { status: "invalid_baseline", security: true, group: "x", mutation: "baseline" },
    { status: "missing_target", security: true, group: "x", mutation: "missing" }
  ], "targeted");
  assert.equal(report.killed, 0);
  assert.equal(report.syntax_errors, 1);
  assert.equal(report.infrastructure_errors, 1);
  assert.equal(report.invalid_baselines, 1);
  assert.equal(report.missing_targets, 1);
  assert.equal(shouldFail(report), true);
});

test("coverage policy inventories every security boundary with stronger branch gates", () => {
  const policy = loadCoveragePolicy();
  assert.ok(policy.version >= 3);
  assert.ok(policy.baseline);
  assert.ok(policy.required_files.length >= 20);
  assert.ok(policy.required_fragments.length >= 8);
  assert.deepStrictEqual(policy.security_domains.map(domain => domain.name), policy.critical_domains);
  assert.ok(policy.security_domains.every(domain => domain.production_files.length && domain.file_minimums));
  assert.ok(policy.security_domains.every(domain => domain.minimums.branches > policy.minimums.branches));
});

test("coverage policy evaluates domains and files independently", () => {
  const policy = loadCoveragePolicy();
  const summary = { total: { lines: { pct: 100 }, statements: { pct: 100 }, functions: { pct: 100 }, branches: { pct: 100 } } };
  for (const file of policy.security_domains.flatMap(domain => domain.production_files)) summary[`/repo/${file}`] = { lines: { total: 10, covered: 10, pct: 100 }, statements: { total: 10, covered: 10, pct: 100 }, functions: { total: 10, covered: 10, pct: 100 }, branches: { total: 10, covered: 10, pct: 100 } };
  for (const file of ["src/tools/result.js", "src/tools/policy.js", "src/packs/maturity.js"]) summary[`/repo/${file}`] = { lines: { total: 10, covered: 10, pct: 100 }, branches: { total: 10, covered: 10, pct: 100 } };
  const report = evaluatePolicy(summary, loadCoveragePolicy());
  assert.equal(report.security.authorization.lines, 100);
  assert.equal(report.security["path-policy"].branches, 100);
  assert.equal(report.missing_required_files.length, 0);
  assert.equal(report.security_failures.length, 0);
});

test("coverage policy fails closed when a required production file is absent", () => {
  const policy = loadCoveragePolicy();
  const summary = { total: { lines: { pct: 100 }, statements: { pct: 100 }, functions: { pct: 100 }, branches: { pct: 100 } }, "/repo/src/core/authorization.js": { lines: { total: 1, covered: 1, pct: 100 }, branches: { total: 1, covered: 1, pct: 100 } } };
  const report = evaluatePolicy(summary, policy, { minimums: { lines: 0, statements: 0, functions: 0, branches: 0 }, files: {} });
  assert.ok(report.missing_required_files.length > 0);
  assert.ok(report.security_failures.some(failure => failure.metric === "files"));
});

test("coverage policy ratchets against the checked-in baseline", () => {
  const policy = loadCoveragePolicy();
  const report = evaluatePolicy({ total: { lines: { pct: 1 }, statements: { pct: 1 }, functions: { pct: 1 }, branches: { pct: 1 } } }, policy, { minimums: { lines: 50, statements: 50, functions: 50, branches: 50 }, files: {} });
  assert.equal(report.baseline_failures.length, 4);
});

test("changed-test selection follows transitive imports and manifest ownership", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "sidekick-changed-tests-"));
  mkdirSync(path.join(fixture, "src"), { recursive: true });
  mkdirSync(path.join(fixture, "test"), { recursive: true });
  writeFileSync(path.join(fixture, "src", "leaf.js"), "module.exports = 1;\n");
  writeFileSync(path.join(fixture, "src", "middle.js"), "module.exports = require('./leaf');\n");
  writeFileSync(path.join(fixture, "test", "owned.test.js"), "require('../src/middle');\n");
  writeFileSync(path.join(fixture, "test", "unrelated.test.js"), "require('../src/other');\n");
  const suites = [
    { file: "test/owned.test.js", domain: "core", owner: "core" },
    { file: "test/unrelated.test.js", domain: "security", owner: "security" },
  ];
  const selection = selectChangedTests([{ status: "M", file: "src/leaf.js", oldFile: null }], suites, fixture);
  assert.deepStrictEqual(selection.selected, ["test/owned.test.js"]);
  assert.deepStrictEqual(selection.reasons["test/owned.test.js"].imported_changes, ["src/leaf.js"]);
  assert.deepStrictEqual(importSpecifiers("// require('bad')\nrequire('./real');"), ["./real"]);
});

test("changed-test selection selects a directly changed suite without broad domain fallback", () => {
  const suites = [{ file: "test/security.test.js", domain: "security", owner: "security" }, { file: "test/core.test.js", domain: "core", owner: "core" }];
  const selection = selectChangedTests([{ status: "M", file: "test/security.test.js", oldFile: null }], suites, process.cwd());
  assert.deepStrictEqual(selection.selected, ["test/security.test.js"]);
  assert.equal(selection.reasons["test/security.test.js"].direct_change, true);
});

test("flake classification requires sufficient valid historical evidence", () => {
  assert.equal(classifyHistory(["failed", "passed", "inconclusive", "failed"]).state, "insufficient_evidence");
  assert.equal(classifyHistory(["failed", "passed", "failed", "passed", "passed"]).state, "quarantined");
  assert.equal(classifyHistory(["failed", "timeout", "failed", "cancelled", "failed"]).state, "insufficient_evidence");
  assert.equal(classifyHistory(["failed", "failed", "failed", "failed", "failed"]).state, "reproducible_failure");
});

test("flake reports quarantine only from attributable history, not one current transition", () => {
  const report = buildFlakeReport(["test/example.test.js"], [
    { suites: { "test/example.test.js": "failed" } },
    { suites: { "test/example.test.js": "passed" } },
    { suites: { "test/example.test.js": "inconclusive" } },
  ]);
  assert.deepStrictEqual(report.quarantined, []);
  assert.deepStrictEqual(report.reproducible_failures, []);
  assert.deepStrictEqual(buildFlakeReport(["test/example.test.js"], [], [{ suite: "test/example.test.js", observations: ["failed", "passed", "failed", "passed", "passed"] }]).quarantined, ["test/example.test.js"]);
});
