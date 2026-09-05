"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildReport, getSpecs, shouldFail } = require("../scripts/test-mutation");
const { evaluatePolicy, loadPolicy } = require("../scripts/test-coverage");

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

test("coverage policy is versioned and evaluates security domains independently", () => {
  const policy = loadPolicy();
  assert.ok(policy.version >= 2);
  const summary = {
    "/repo/src/core/authorization.js": { lines: { total: 10, covered: 8 }, branches: { total: 10, covered: 3 } },
    "/repo/src/tools/path-policy.js": { lines: { total: 10, covered: 4 }, branches: { total: 10, covered: 2 } },
    "/repo/src/tools/result.js": { lines: { total: 10, covered: 9 }, branches: { total: 10, covered: 9 } },
  };
  const report = evaluatePolicy(summary, policy);
  assert.equal(report.security.authorization.lines, 80);
  assert.equal(report.security["path-policy"].branches, 20);
  assert.ok(report.security_failures.length === 0);
});
