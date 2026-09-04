"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { discoverSuites } = require("../suite-runner");

test("domain manifests expose bounded metadata for all discovered suites", () => {
  const suites = discoverSuites();
  assert.ok(suites.some(suite => suite.domain === "packs"));
  for (const suite of suites.filter(item => item.domain === "packs")) {
    assert.match(suite.id, /^packs:test\//);
    assert.ok(suite.timeout_ms <= 300000);
    assert.ok(suite.resources.every(resource => /^[a-z-]+$/.test(resource)));
  }
});
