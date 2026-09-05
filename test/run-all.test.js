"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { ResourceLocks, createProgressReporter, discoverSuites, globToRegExp, selectSuites, validateContract, validateManifest, runSuites, executeSuite, registerProvisioner, registerCleanup, provisionSuiteResources, cleanupSuiteResources } = require("./suite-runner");

function fixtureSuite(file, contracts = { environment: { kind: "isolated", provisioner: "environment-scope", fixture: "process-environment", cleanup: "no-op", cleanup_owner: "suite", lock_identity: "environment", supported_platforms: ["linux", "win32", "darwin"] } }) {
  return { file, id: `fixture:${file}`, resources: Object.keys(contracts), contracts, suite_contract: { supported_platforms: ["linux", "win32", "darwin"] } };
}

function temporarySuite(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-runner-fixture-"));
  const file = "child.test.js";
  fs.writeFileSync(path.join(directory, file), source);
  return { directory, suite: fixtureSuite(file) };
}

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
  assert.throws(() => validateContract({ kind: "isolated", provisioner: "none", fixture: "x", cleanup: "no-op", cleanup_owner: "x", lock_identity: "x", supported_platforms: ["plan9"] }, "fixture resource"), /supported_platforms/);
  assert.throws(() => validateContract({ kind: "shared", provisioner: "none", fixture: "x", cleanup: "no-op", cleanup_owner: "x", lock_identity: "" , supported_platforms: ["linux"] }, "fixture resource"), /lock_identity/);
  assert.throws(() => validateContract({ kind: "isolated", provisioner: "missing-provisioner", fixture: "fixture", cleanup: "no-op", cleanup_owner: "suite", lock_identity: "fixture", supported_platforms: ["linux"] }, "fixture resource"), /unknown provisioner/);
  assert.throws(() => validateContract({ kind: "isolated", provisioner: "none", fixture: "fixture", cleanup: "no-op", cleanup_owner: "suite", lock_identity: "fixture", supported_platforms: ["linux"] }, "fixture resource"), /meaningful registered name/);
});

test("resource provisioners give children distinct scoped temp resources and env", async () => {
  const first = temporarySuite("const test = require('node:test'); test('scope', () => { console.log(JSON.stringify({ root: process.env.SIDEKICK_TEST_SUITE_ROOT, db: process.env.SIDEKICK_TEST_DB_FILE, port: process.env.SIDEKICK_TEST_PORT })); });");
  const second = temporarySuite("const test = require('node:test'); test('scope', () => { console.log(JSON.stringify({ root: process.env.SIDEKICK_TEST_SUITE_ROOT, db: process.env.SIDEKICK_TEST_DB_FILE, port: process.env.SIDEKICK_TEST_PORT })); });");
  const contracts = {
    sqlite: { kind: "isolated", provisioner: "sqlite-file", fixture: "sqlite-database", cleanup: "owned-temp-tree", cleanup_owner: "suite", lock_identity: "sqlite", supported_platforms: ["linux", "win32", "darwin"] },
    ports: { kind: "isolated", provisioner: "loopback-port", fixture: "loopback-port", cleanup: "close-port", cleanup_owner: "suite", lock_identity: "ports", supported_platforms: ["linux", "win32", "darwin"] },
    workspace: { kind: "isolated", provisioner: "temp-workspace", fixture: "workspace-directory", cleanup: "owned-temp-tree", cleanup_owner: "suite", lock_identity: "workspace", supported_platforms: ["linux", "win32", "darwin"] }
  };
  first.suite = fixtureSuite(first.suite.file, contracts);
  second.suite = fixtureSuite(second.suite.file, contracts);
  try {
    const [firstResult, secondResult] = await Promise.all([
      executeSuite(first.suite, { cwd: first.directory, maxOutputChars: 2000 }),
      executeSuite(second.suite, { cwd: second.directory, maxOutputChars: 2000 })
    ]);
    assert.equal(firstResult.status, "passed", firstResult.error || firstResult.stderr);
    assert.equal(secondResult.status, "passed", secondResult.error || secondResult.stderr);
    const firstScope = JSON.parse(firstResult.stdout.match(/\{"root".*\}/)?.[0]);
    const secondScope = JSON.parse(secondResult.stdout.match(/\{"root".*\}/)?.[0]);
    assert.notEqual(firstScope.root, secondScope.root);
    assert.notEqual(firstScope.db, secondScope.db);
    assert.notEqual(firstScope.port, secondScope.port);
    assert.deepEqual(firstResult.resource_leaks, []);
    assert.deepEqual(secondResult.resource_leaks, []);
  } finally {
    fs.rmSync(first.directory, { recursive: true, force: true });
    fs.rmSync(second.directory, { recursive: true, force: true });
  }
});

test("isolated suites can run concurrently without sharing their scopes", async () => {
  const result = await runSuites({
    requested: ["test/core/fault-injection.test.js", "test/agent-loop.test.js"],
    concurrency: 2,
    output: { log() {}, error() {} }
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  assert.equal(result.peak_concurrency, 2);
  assert.ok(result.results.every(item => item.resource_leaks.length === 0));
});

test("cleanup runs after failures, timeouts, cancellation, and spawn errors", async () => {
  const cases = [
    { source: "const test = require('node:test'); test('failure', () => { throw new Error('expected'); });", status: "failed" },
    { source: "setTimeout(() => {}, 10000);", status: "timeout", timeout_ms: 100 },
    { source: "setTimeout(() => {}, 10000);", status: "cancelled", abort: true },
    { source: null, status: "failed" }
  ];
  for (const item of cases) {
    const fixture = item.source === null ? { directory: fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-runner-fixture-")), suite: fixtureSuite("missing.test.js") } : temporarySuite(item.source);
    const controller = new AbortController();
    fixture.suite.timeout_ms = item.timeout_ms || 5000;
    try {
      const promise = executeSuite(fixture.suite, { cwd: fixture.directory, signal: controller.signal, maxOutputChars: 2000 });
      if (item.abort) setTimeout(() => controller.abort(), 25);
      const result = await promise;
      assert.equal(result.status, item.status, JSON.stringify(result));
      assert.deepEqual(result.resource_leaks, []);
      assert.deepEqual(result.cleanup_errors, []);
    } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
  }
});

test("cleanup failures and leaked owned paths fail an otherwise passing suite", async () => {
  const provisionerName = "runner-leak-fixture";
  const cleanupName = "runner-leak-cleanup";
  registerProvisioner(provisionerName, context => {
    const target = path.join(context.root, "leaked-resource");
    fs.mkdirSync(target);
    return { value: { path: target }, owned_paths: [target] };
  });
  registerCleanup(cleanupName, async () => { throw new Error("cleanup failed"); });
  const fixture = temporarySuite("const test = require('node:test'); test('pass', () => {});");
  fixture.suite = fixtureSuite(fixture.suite.file, { leak: { kind: "isolated", provisioner: provisionerName, fixture: "owned-directory", cleanup: cleanupName, cleanup_owner: "suite", lock_identity: "leak", supported_platforms: ["linux", "win32", "darwin"] } });
  try {
    const result = await executeSuite(fixture.suite, { cwd: fixture.directory, maxOutputChars: 2000 });
    assert.equal(result.status, "failed");
    assert.match(result.error, /cleanup/);
    assert.equal(result.cleanup_errors.length, 1);
    assert.equal(result.resource_leaks.length, 1);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("unsupported platforms are refused before provisioning", async () => {
  const suite = fixtureSuite("unsupported.test.js");
  suite.suite_contract.supported_platforms = [process.platform === "linux" ? "win32" : "linux"];
  await assert.rejects(() => provisionSuiteResources(suite), /does not support platform/);
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
  const result = await runSuites({ requested: ["test/core/fault-injection.test.js"], concurrency: 1, output: { log() {}, error() {} }, onProgress: event => events.push(event) });
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
