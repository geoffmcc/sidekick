"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const mutation = require("../scripts/test-mutation");

test("mutation inventory covers every critical domain and exceeds the legacy inventory", () => {
  const policy = mutation.loadPolicy();
  const specs = mutation.getSpecs("full");
  const results = specs.flatMap(spec => spec.pattern.map(pattern => ({
    group: spec.group,
    category: pattern.category,
    security: Boolean(pattern.security),
    status: "assertion_killed",
  })));
  assert.ok(results.length > 14);
  for (const [domain, minimum] of Object.entries(policy.thresholds.domain_minimums)) {
    assert.ok(results.filter(result => result.group === domain).length >= minimum, domain);
  }
  for (const category of policy.required_categories) assert.ok(results.some(result => result.category === category), category);
});

test("mutation errors stay in the denominator and fail the quality gate", () => {
  const policy = mutation.loadPolicy();
  const report = mutation.buildReport([
    { group: "identity", category: "normalization", security: true, status: "assertion_killed" },
    { group: "identity", category: "normalization", security: true, status: "invalid_baseline" },
  ], "targeted", policy);
  assert.equal(report.total, 2);
  assert.equal(report.mutation_score, 50);
  assert.equal(report.security_score, 50);
  assert.equal(mutation.shouldFail(report, policy), true);
});
