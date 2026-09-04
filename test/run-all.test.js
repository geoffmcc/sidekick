"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ResourceLocks, discoverSuites, globToRegExp, selectSuites } = require("./suite-runner");

test("recursive discovery assigns every suite one domain owner", () => {
  const suites = discoverSuites();
  assert.ok(suites.length > 200);
  assert.equal(new Set(suites.map(suite => suite.id)).size, suites.length);
  assert.ok(suites.every(suite => suite.domain && suite.tier && suite.resources.length));
});

test("selection fails closed for unknown suites and supports domain filters", () => {
  const suites = discoverSuites();
  assert.match(selectSuites(suites, ["missing.test.js"]).error, /Invalid/);
  assert.equal(selectSuites(suites, [], { domain: "security" }).selected.every(suite => suite.domain === "security"), true);
});

test("glob metadata supports wildcard alternatives", () => {
  const matcher = globToRegExp("test/{agent,brain}*.test.{js,cjs}");
  assert.equal(matcher.test("test/agent-loop.test.js"), true);
  assert.equal(matcher.test("test/brain.test.cjs"), true);
  assert.equal(matcher.test("test/dashboard.test.js"), false);
});

test("resource locks serialize shared resources and always release", async () => {
  const locks = new ResourceLocks();
  const first = await locks.acquire(["sqlite"]);
  let acquired = false;
  const pending = locks.acquire(["sqlite"]).then(release => { acquired = true; release(); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acquired, false);
  first();
  await pending;
  assert.equal(acquired, true);
});
