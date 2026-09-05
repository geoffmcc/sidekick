"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ResourceLocks, createProgressReporter, discoverSuites, globToRegExp, selectSuites, validateContract, validateManifest, runSuites } = require("./suite-runner");

test("recursive discovery assigns every suite one domain owner", () => {
  const suites = discoverSuites();
  assert.ok(suites.length > 200);
  assert.equal(new Set(suites.map(suite => suite.id)).size, suites.length);
  assert.ok(suites.every(suite => suite.domain && suite.tier && suite.resources.length));
  assert.ok(suites.every(suite => suite.lock_resources.length));
});

test("manifest resource ownership is explicit and complete", () => {
  assert.throws(() => validateManifest({ source: "fixture.json", domain: "fixture", priority: 1, tier: "unit", criticality: "required", patterns: ["test/*.test.js"], resources: ["sqlite"] }), /resource_contracts are required/);
  assert.throws(() => validateContract({ kind: "maybe" }, "fixture resource"), /isolated, shared, or exclusive/);
  assert.throws(() => validateContract({ kind: "isolated", provisioner: "x", fixture: "x", cleanup_owner: "x", lock_identity: "x", supported_platforms: ["plan9"] }, "fixture resource"), /supported_platforms/);
  assert.throws(() => validateContract({ kind: "shared", provisioner: "x", fixture: "x", cleanup_owner: "x", lock_identity: "" , supported_platforms: ["linux"] }, "fixture resource"), /lock_identity/);
});

test("invalid runner configuration fails closed", async () => {
  const result = await runSuites({ requested: ["test/run-all.test.js"], concurrency: 0, output: { log() {}, error() {} } });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /concurrency/);
  const timeout = await runSuites({ requested: ["test/run-all.test.js"], overallTimeoutMs: 0, output: { log() {}, error() {} } });
  assert.equal(timeout.exitCode, 2);
  assert.match(timeout.error, /overallTimeoutMs/);
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

test("resource lock waiters acquire in request order", async () => {
  const locks = new ResourceLocks();
  const first = await locks.acquire(["sqlite"]);
  const order = [];
  const second = locks.acquire(["sqlite"]).then(release => { order.push("second"); release(); });
  const third = locks.acquire(["sqlite"]).then(release => { order.push("third"); release(); });
  first();
  await Promise.all([second, third]);
  assert.deepEqual(order, ["second", "third"]);
});

test("exclusive contracts serialize otherwise unrelated resources", async () => {
  const locks = new ResourceLocks();
  const first = await locks.acquire(["exclusive", "live"]);
  let acquired = false;
  const pending = locks.acquire(["sqlite"]).then(release => { acquired = true; release(); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acquired, false);
  first();
  await pending;
});

test("cancelled lock waiters are removed and do not deadlock later suites", async () => {
  const locks = new ResourceLocks();
  const first = await locks.acquire(["sqlite"]);
  const controller = new AbortController();
  const cancelled = locks.acquire(["sqlite"], controller.signal);
  controller.abort();
  assert.equal(await cancelled, null);
  first();
  const release = await locks.acquire(["sqlite"]);
  release();
});

test("runner emits structured lifecycle progress without changing the final report", async () => {
  const events = [];
  const result = await runSuites({ requested: ["test/run-all.test.js"], concurrency: 1, output: { log() {}, error() {} }, onProgress: event => events.push(event) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.version, 2);
  assert.equal(events[0].event, "started");
  assert.equal(events.at(-1).event, "finished");
  assert.ok(events.some(event => event.type === "suite" && event.event === "started"));
  assert.ok(events.every(event => Number.isInteger(event.elapsed_ms) && event.total === 1 && event.completed <= event.total));
});

test("progress reporter includes queue and lock state and stays silent for JSON mode", () => {
  let text = "";
  createProgressReporter({ output: { write(value) { text += value; } } })({ event: "heartbeat", elapsed_ms: 1234, completed: 1, total: 3, counts: { passed: 1 }, current: ["a"], queued: ["b"], lock_waiting: ["c"] });
  assert.match(text, /1234ms.*1\/3.*current=a.*queued=1.*lock-waiting=1/);
  let wrote = false;
  createProgressReporter({ json: true, output: { write() { wrote = true; } } })({ event: "heartbeat" });
  assert.equal(wrote, false);
});
