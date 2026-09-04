"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { enableFailpoint, hitFailpoint, resetFailpoints } = require("../platform/fault-injection");

test("failpoints are inert unless the isolated harness enables them", () => {
  resetFailpoints();
  assert.doesNotThrow(() => hitFailpoint("before-persistence"));
});

test("enabled failpoints throw at the named boundary and clean up", () => {
  const restore = process.env.SIDEKICK_TEST_FAILPOINTS;
  process.env.SIDEKICK_TEST_FAILPOINTS = "1";
  const disable = enableFailpoint("before-persistence");
  try { assert.throws(() => hitFailpoint("before-persistence"), /Injected failpoint/); }
  finally { disable(); resetFailpoints(); if (restore === undefined) delete process.env.SIDEKICK_TEST_FAILPOINTS; else process.env.SIDEKICK_TEST_FAILPOINTS = restore; }
});
