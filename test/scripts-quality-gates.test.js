"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { applyMutation, buildReport, getSpecs, loadPolicy, shouldFail } = require("../scripts/test-mutation");
const { evaluatePolicy, loadPolicy: loadCoveragePolicy } = require("../scripts/test-coverage");
const { classifyPath, importSpecifiers, runChangedTests, selectChangedTests } = require("../scripts/test-changed");
const {
  buildFlakeReport,
  classifyHistory,
  parseBatchResult,
  readHistory,
  readQuarantine,
  shouldFail: shouldFailFlake,
} = require("../scripts/test-flake");

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
  assert.ok(mutations.every(mutation => mutation.kind && mutation.expression && Object.hasOwn(mutation, "replacement")));
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

function impactFixture(name, files) {
  const fixture = mkdtempSync(path.join(tmpdir(), `sidekick-changed-${name}-`));
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(fixture, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return fixture;
}

function fallbackSuite(file = "test/fallback.test.js", domain = "core") {
  return { file, domain, owner: domain };
}

test("changed-test selection handles CJS, MJS re-exports, JSON, and runtime-loaded files", () => {
  const fixture = impactFixture("module-edges", {
    "src/leaf.mjs": "export const value = 1;\n",
    "src/reexport.cjs": "module.exports = require('./leaf.mjs');\n",
    "src/runtime.json": "{}\n",
    "test/edge.test.js": "import '../src/reexport.cjs'; const fs = require('node:fs'); fs.readFileSync('../src/runtime.json');\n",
  });
  const suites = [{ file: "test/edge.test.js", domain: "core", owner: "core" }];
  const selection = selectChangedTests([
    { status: "M", file: "src/leaf.mjs", oldFile: null },
    { status: "M", file: "src/runtime.json", oldFile: null },
  ], suites, fixture);
  assert.deepStrictEqual(selection.selected, ["test/edge.test.js"]);
  assert.deepStrictEqual(selection.reasons["test/edge.test.js"].imported_changes, ["src/leaf.mjs", "src/runtime.json"]);
});

test("renames and deletes retain reverse impact through unresolved import candidates", () => {
  const fixture = impactFixture("rename-delete", {
    "src/old.js": "module.exports = 1;\n",
    "test/edge.test.js": "require('../src/old');\n",
  });
  const suites = [{ file: "test/edge.test.js", domain: "core", owner: "core" }];
  const renamed = selectChangedTests([{ status: "R100", file: "src/old.js", oldFile: "src/new.js" }], suites, fixture);
  assert.deepStrictEqual(renamed.selected, ["test/edge.test.js"]);
  const deleted = selectChangedTests([{ status: "D", file: "src/old.js", oldFile: null }], suites, fixture);
  assert.deepStrictEqual(deleted.selected, ["test/edge.test.js"]);
});

test("dynamic registration routes otherwise unmatched files to a documented fallback", () => {
  const fixture = impactFixture("dynamic", {
    "test/loader.test.js": "const fs = require('node:fs'); fs.readdirSync('../plugins');\n",
    "plugins/new.js": "module.exports = true;\n",
    "test/fallback.test.js": "module.exports = true;\n",
  });
  const selection = selectChangedTests([{ status: "A", file: "plugins/new.js", oldFile: null }], [
    { file: "test/loader.test.js", domain: "core", owner: "core" }, fallbackSuite(),
  ], fixture, { fallbackSuites: { dynamic: ["test/fallback.test.js"] } });
  assert.equal(selection.dynamic_registration_detected, true);
  assert.deepStrictEqual(selection.fallback_selected, ["test/fallback.test.js"]);
  assert.equal(selection.fallback_by_file["plugins/new.js"].category, "dynamic");
});

test("configuration and shared fixture changes are classified conservatively", () => {
  const fixture = impactFixture("config-fixture", {
    "config/runtime.json": "{}\n",
    "test/helpers/shared.js": "module.exports = true;\n",
    "test/edge.test.js": "require('./helpers/shared');\n",
    "test/fallback.test.js": "module.exports = true;\n",
  });
  const suites = [{ file: "test/edge.test.js", domain: "core", owner: "core" }, fallbackSuite()];
  const selection = selectChangedTests([
    { status: "M", file: "config/runtime.json", oldFile: null },
    { status: "M", file: "test/helpers/shared.js", oldFile: null },
  ], suites, fixture, { fallbackSuites: { config: ["test/fallback.test.js"] } });
  assert.equal(classifyPath("config/runtime.json").categories.includes("config"), true);
  assert.deepStrictEqual(selection.selected, ["test/edge.test.js", "test/fallback.test.js"]);
  assert.equal(selection.fallback_by_file["config/runtime.json"].category, "config");
});

test("pack and workflow changes select their conservative fallback", () => {
  const fixture = impactFixture("pack-workflow", {
    "packs/demo/sidekick.pack.json": "{}\n",
    "packs/demo/workflows/run.json": "{}\n",
    "test/fallback.test.js": "module.exports = true;\n",
  });
  const selection = selectChangedTests([
    { status: "M", file: "packs/demo/sidekick.pack.json", oldFile: null },
    { status: "M", file: "packs/demo/workflows/run.json", oldFile: null },
  ], [fallbackSuite()], fixture, { fallbackSuites: { pack: ["test/fallback.test.js"], workflow: ["test/fallback.test.js"] } });
  assert.deepStrictEqual(selection.fallback_selected, ["test/fallback.test.js"]);
  assert.equal(selection.fallback_by_file["packs/demo/sidekick.pack.json"].category, "pack");
  assert.equal(selection.fallback_by_file["packs/demo/workflows/run.json"].category, "workflow");
});

test("package, GitHub workflow, manifest, and resource changes have explicit impact categories", () => {
  const fixture = impactFixture("repository-assets", { "test/fallback.test.js": "module.exports = true;\n" });
  const selection = selectChangedTests([
    { status: "M", file: "package-lock.json", oldFile: null },
    { status: "M", file: ".github/workflows/ci.yml", oldFile: null },
    { status: "M", file: "test/manifests/core.json", oldFile: null },
    { status: "M", file: "test/suite-resources.json", oldFile: null },
  ], [fallbackSuite()], fixture, {
    fallbackSuites: { dependency: ["test/fallback.test.js"], github: ["test/fallback.test.js"], fixture: ["test/fallback.test.js"] },
  });
  assert.equal(selection.fallback_by_file["package-lock.json"].category, "dependency");
  assert.equal(selection.fallback_by_file[".github/workflows/ci.yml"].category, "github");
  assert.equal(selection.fallback_by_file["test/manifests/core.json"].category, "fixture");
  assert.equal(selection.fallback_by_file["test/suite-resources.json"].category, "fixture");
  assert.deepStrictEqual(selection.fallback_selected, ["test/fallback.test.js"]);
});

test("migration and Dashboard asset changes are not silently unmatched", () => {
  const fixture = impactFixture("migration-dashboard", { "test/fallback.test.js": "module.exports = true;\n" });
  const selection = selectChangedTests([
    { status: "M", file: "migrations/001_schema.sql", oldFile: null },
    { status: "M", file: "static/dashboard.js", oldFile: null },
  ], [fallbackSuite()], fixture, {
    fallbackSuites: { migration: ["test/fallback.test.js"], dashboard: ["test/fallback.test.js"] },
  });
  assert.equal(selection.fallback_by_file["migrations/001_schema.sql"].category, "migration");
  assert.equal(selection.fallback_by_file["static/dashboard.js"].category, "dashboard");
  assert.deepStrictEqual(selection.fallback_selected, ["test/fallback.test.js"]);
});

test("unmatched impactful changes select a fallback while documentation does not", () => {
  const fixture = impactFixture("unmatched", { "test/fallback.test.js": "module.exports = true;\n" });
  const selection = selectChangedTests([
    { status: "M", file: "vendor/runtime.bin", oldFile: null },
    { status: "M", file: "docs/testing.md", oldFile: null },
  ], [fallbackSuite()], fixture, { fallbackSuites: { unknown: ["test/fallback.test.js"] } });
  assert.deepStrictEqual(selection.impactful_unmatched_changes, ["vendor/runtime.bin"]);
  assert.deepStrictEqual(selection.fallback_selected, ["test/fallback.test.js"]);
  assert.deepStrictEqual(selection.fallback_by_file["vendor/runtime.bin"].candidates, ["test/fallback.test.js"]);
});

test("changed-test execution fails CI when a required fallback was not run or no tests passed", async () => {
  const fixture = impactFixture("execution-gate", { "test/fallback.test.js": "module.exports = true;\n" });
  const suites = [fallbackSuite()];
  const notRun = await runChangedTests({
    changes: [{ status: "M", file: "vendor/runtime.bin", oldFile: null }], cwd: fixture, suites,
    options: { fallbackSuites: { unknown: ["test/fallback.test.js"] } },
    runner: async () => ({ passed: 0, failed: 0, results: [], exitCode: 0 }),
  });
  assert.equal(notRun.exitCode, 1);
  assert.deepStrictEqual(notRun.execution.fallback_not_run, ["test/fallback.test.js"]);
  assert.equal(notRun.execution.zero_tests, true);
});

test("flake classification requires sufficient valid historical evidence", () => {
  assert.equal(classifyHistory(["failed", "passed", "inconclusive", "failed"]).state, "inconclusive");
  assert.equal(classifyHistory(["failed", "passed", "failed", "passed", "passed"]).state, "quarantined");
  assert.equal(classifyHistory(["failed", "timeout", "failed", "cancelled", "failed"]).state, "infrastructure");
  assert.equal(classifyHistory(["failed", "cancelled", "failed", "passed", "passed"]).state, "inconclusive");
  assert.equal(classifyHistory(["failed", "failed", "failed", "failed", "failed"]).state, "reproducible_failure");
});

test("flake history uses a strict schema instead of discarding malformed evidence", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "sidekick-flake-history-"));
  const file = path.join(fixture, "history.json");
  writeFileSync(file, JSON.stringify({ version: 1, entries: [{ suite: "test/example.test.js", observations: ["passed", "failed"] }] }));
  assert.equal(readHistory(file).status, "valid");
  writeFileSync(file, JSON.stringify({ version: 1, entries: [{ suite: "test/example.test.js", observations: ["passed", "bogus"] }] }));
  assert.throws(() => readHistory(file), /invalid status/);
  writeFileSync(file, JSON.stringify([{ suite: "test/example.test.js", observations: ["passed"] }]));
  assert.throws(() => readHistory(file), /version 1/);
});

test("flake quarantine requires an exact owned justified bounded entry", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "sidekick-flake-quarantine-"));
  const file = path.join(fixture, "quarantine.json");
  const entry = { suite: "test/example.test.js", owner: "core-team", reason: "Known scheduler race under shared fixture", issue: "FLAKE-123", added_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-10T00:00:00.000Z" };
  writeFileSync(file, JSON.stringify({ version: 1, max_duration_days: 14, entries: [entry] }));
  assert.equal(readQuarantine(file).entries[0].suite, entry.suite);
  writeFileSync(file, JSON.stringify({ version: 1, max_duration_days: 14, entries: [{ ...entry, suite: "test/*.test.js" }] }));
  assert.throws(() => readQuarantine(file), /exact test suite path/);
  writeFileSync(file, JSON.stringify({ version: 1, max_duration_days: 14, entries: [{ ...entry, expires_at: "2026-02-01T00:00:00.000Z" }] }));
  assert.throws(() => readQuarantine(file), /exceeds max_duration_days/);
});

test("flake parser separates pass, failure, timeout, crash, malformed output, and inconclusive runs", () => {
  const suites = ["test/example.test.js"];
  const report = (status, exitCode = status === "failed" ? 1 : 0) => ({ status: exitCode, stdout: JSON.stringify({ version: 2, results: [{ suite: suites[0], status }], not_run: [], exitCode }) });
  assert.equal(parseBatchResult(suites, report("passed")).classification, "passed");
  assert.equal(parseBatchResult(suites, report("failed")).classification, "failed");
  assert.equal(parseBatchResult(suites, { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }).suites[suites[0]], "timeout");
  assert.equal(parseBatchResult(suites, { signal: "SIGSEGV" }).suites[suites[0]], "crash");
  assert.equal(parseBatchResult(suites, { status: 0, stdout: "not json\n" }).suites[suites[0]], "malformed_output");
  assert.equal(parseBatchResult(suites, { status: 0, stdout: JSON.stringify({ version: 2, results: [], not_run: suites, exitCode: 0 }) }).classification, "inconclusive");
  const timeout = parseBatchResult(suites, { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) });
  const mixed = buildFlakeReport(suites, [{ suites: { [suites[0]]: "failed" } }, { suites: { [suites[0]]: "timeout" } }]);
  assert.equal(timeout.classification, "infrastructure");
  assert.equal(mixed.classifications[suites[0]].state, "infrastructure");
  assert.equal(shouldFailFlake(mixed), true);
});

test("flake gate fails all-fail, mixed, one-failure, missing-history, and expired-quarantine cases", () => {
  const suite = "test/example.test.js";
  const historical = [{ suite, observations: ["failed", "passed", "failed", "passed", "passed"] }];
  const active = [{ suite, owner: "core-team", reason: "Known scheduler race under shared fixture", issue: "FLAKE-123", added_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-10T00:00:00.000Z" }];
  const run = statuses => statuses.map(suiteStatus => ({ suites: { [suite]: suiteStatus } }));
  const allFail = buildFlakeReport([suite], run(["failed", "failed", "failed", "failed", "failed"]), historical, undefined, active, Date.parse("2026-01-05T00:00:00.000Z"));
  assert.equal(allFail.classifications[suite].state, "reproducible_failure");
  assert.equal(shouldFailFlake(allFail), true);
  const mixed = buildFlakeReport([suite], run(["failed", "passed", "passed", "passed", "passed"]), historical);
  assert.equal(mixed.classifications[suite].state, "ordinary_failure");
  assert.equal(shouldFailFlake(mixed), true);
  const oneFailure = buildFlakeReport([suite], run(["failed", "passed", "passed", "passed", "passed"]), historical);
  assert.equal(oneFailure.classifications[suite].state, "ordinary_failure");
  assert.equal(shouldFailFlake(oneFailure), true);
  const missingHistory = buildFlakeReport([suite], run(["failed", "passed", "passed", "passed", "passed"]));
  assert.ok(missingHistory.gate.failures.some(failure => failure.reason === "insufficient_historical_evidence"));
  const insufficientHistory = buildFlakeReport([suite], run(["failed", "passed", "passed", "passed", "passed"]), [{ suite, observations: ["passed", "failed", "passed", "passed"] }]);
  assert.equal(insufficientHistory.classifications[suite].historical.state, "insufficient_evidence");
  assert.equal(shouldFailFlake(insufficientHistory), true);
  const expired = buildFlakeReport([suite], run(["failed", "passed", "passed", "passed", "passed"]), historical, undefined, active, Date.parse("2026-01-11T00:00:00.000Z"));
  assert.deepStrictEqual(expired.expired_quarantines, [suite]);
  assert.equal(shouldFailFlake(expired), true);
});

test("flake gate permits only a current ordinary failure covered by active exact-suite quarantine", () => {
  const suite = "test/example.test.js";
  const historical = [{ suite, observations: ["failed", "passed", "failed", "passed", "passed"] }];
  const quarantine = [{ suite, owner: "core-team", reason: "Known scheduler race under shared fixture", issue: "FLAKE-123", added_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-10T00:00:00.000Z" }];
  const report = buildFlakeReport([suite], [
    { suites: { [suite]: "failed" } },
    { suites: { [suite]: "passed" } },
    { suites: { [suite]: "passed" } },
  ], historical, undefined, quarantine, Date.parse("2026-01-05T00:00:00.000Z"));
  assert.equal(report.classifications[suite].state, "quarantined_current_failure");
  assert.deepStrictEqual(report.quarantined_current_failures, [suite]);
  assert.equal(shouldFailFlake(report), false);
  const otherSuite = buildFlakeReport([suite], [{ suites: { [suite]: "failed" } }], historical, undefined, [{ ...quarantine[0], suite: "test/other.test.js" }], Date.parse("2026-01-05T00:00:00.000Z"));
  assert.equal(shouldFailFlake(otherSuite), true);
});

test("flake reports historical quarantine qualification separately from current transitions", () => {
  const suite = "test/example.test.js";
  const historical = [{ suite, observations: ["failed", "passed", "failed", "passed", "passed"] }];
  const quarantine = [{ suite, owner: "core-team", reason: "Known scheduler race under shared fixture", issue: "FLAKE-123", added_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-10T00:00:00.000Z" }];
  const report = buildFlakeReport([suite], [
    { suites: { [suite]: "passed" } },
    { suites: { [suite]: "passed" } },
  ], historical, undefined, quarantine, Date.parse("2026-01-05T00:00:00.000Z"));
  assert.deepStrictEqual(report.quarantined, [suite]);
  assert.deepStrictEqual(report.reproducible_failures, []);
});

test("flake reports quarantine only from attributable history, not one current transition", () => {
  const report = buildFlakeReport(["test/example.test.js"], [
    { suites: { "test/example.test.js": "failed" } },
    { suites: { "test/example.test.js": "passed" } },
    { suites: { "test/example.test.js": "inconclusive" } },
  ]);
  assert.deepStrictEqual(report.quarantined, []);
  assert.deepStrictEqual(report.reproducible_failures, []);
  assert.deepStrictEqual(report.classifications["test/example.test.js"].historical.state, "insufficient_evidence");
});
