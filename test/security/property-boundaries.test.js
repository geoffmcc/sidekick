"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fc = require("fast-check");
const { assertNoSyntheticSecret } = require("../helpers/security");
const { PROJECT_RE } = require("../../src/core/project-identity");

const seed = Number(process.env.SIDEKICK_PROPERTY_SEED || 739391);
const runs = Number(process.env.SIDEKICK_PROPERTY_RUNS || 100);

test("property seed is deterministic and project identifiers stay bounded", () => {
  const property = fc.property(fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-") , maxLength: 80 }), value => {
    assert.equal(PROJECT_RE.test(value), /^[a-z][a-z0-9_]*$/.test(value));
    assert.ok(!PROJECT_RE.test(value) || value[0] >= "a");
  });
  fc.assert(property, { seed, numRuns: runs, endOnFailure: true });
});

test("nested synthetic secrets never appear in serialized security output", () => {
  const secret = "TEST_ONLY_SECRET_7b4c";
  const nested = { arrays: [secret], encoded: encodeURIComponent(secret), headers: { authorization: `Bearer ${secret}` } };
  assertNoSyntheticSecret(JSON.stringify(nested).replaceAll(secret, "[REDACTED]"), secret);
});
