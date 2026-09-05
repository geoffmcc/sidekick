"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SKIP_EXIT_CODE = 77;
const CONFIG_EXIT_CODE = 2;
const root = path.resolve(__dirname, "..");
const manifestDir = path.join(__dirname, "manifests");
const allowedTiers = new Set(["smoke", "unit", "contract", "integration", "security", "e2e", "compatibility", "live"]);
const allowedCriticality = new Set(["required", "optional"]);
const allowedResourceScopes = new Set(["isolated", "shared"]);
const suiteResourcePath = path.join(__dirname, "suite-resources.json");

function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") { source += "(?:.*/)?"; i += 2; }
    else if (ch === "*") source += pattern[i + 1] === "*" ? (i++, ".*") : "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) throw new Error(`Malformed glob: ${pattern}`);
      source += `(?:${pattern.slice(i + 1, end).split(",").map(part => globToRegExp(part).source.slice(1, -1)).join("|")})`;
      i = end;
    } else source += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function loadManifests() {
  return fs.readdirSync(manifestDir).filter(file => file.endsWith(".json")).sort()
    .map(file => ({ ...JSON.parse(fs.readFileSync(path.join(manifestDir, file), "utf8")), source: `test/manifests/${file}` }));
}

function loadSuiteResourceScopes() {
  const scopes = JSON.parse(fs.readFileSync(suiteResourcePath, "utf8"));
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes) || Object.values(scopes).some(value => value !== true)) {
    throw new Error("test/suite-resources.json: values must be true");
  }
  return scopes;
}

function validateManifest(manifest) {
  if (!manifest.domain || !/^[a-z][a-z0-9-]+$/.test(manifest.domain)) throw new Error(`${manifest.source}: invalid domain`);
  if (!Number.isInteger(manifest.priority)) throw new Error(`${manifest.source}: priority is required`);
  if (!allowedTiers.has(manifest.tier) || !allowedCriticality.has(manifest.criticality)) throw new Error(`${manifest.source}: invalid tier or criticality`);
  if (!Array.isArray(manifest.patterns) || !manifest.patterns.length || !Array.isArray(manifest.resources)) throw new Error(`${manifest.source}: patterns and resources are required`);
  if (!manifest.resource_scopes || typeof manifest.resource_scopes !== "object" || Array.isArray(manifest.resource_scopes)) throw new Error(`${manifest.source}: resource_scopes are required`);
  const resources = new Set(manifest.resources);
  if (manifest.resources.some(resource => typeof resource !== "string" || !resource.trim()) || resources.size !== manifest.resources.length) throw new Error(`${manifest.source}: resources must be unique non-empty strings`);
  const scopeNames = Object.keys(manifest.resource_scopes);
  if (scopeNames.length !== resources.size || scopeNames.some(resource => !resources.has(resource))) throw new Error(`${manifest.source}: resource_scopes must classify every declared resource and no others`);
  if (scopeNames.some(resource => !allowedResourceScopes.has(manifest.resource_scopes[resource]))) throw new Error(`${manifest.source}: resource scopes must be isolated or shared`);
  if (!Number.isInteger(manifest.timeout_ms) || manifest.timeout_ms < 1000) throw new Error(`${manifest.source}: timeout_ms must be a positive integer`);
  for (const pattern of manifest.patterns) globToRegExp(pattern);
  if (manifest.shared_resources !== undefined) {
    if (!Array.isArray(manifest.shared_resources) || manifest.shared_resources.some(resource => typeof resource !== "string" || !resource.trim())) {
      throw new Error(`${manifest.source}: shared_resources must be a list of non-empty strings`);
    }
    if (manifest.shared_resources.some(resource => !manifest.resources.includes(resource))) {
      throw new Error(`${manifest.source}: shared_resources must be declared in resources`);
    }
    if (manifest.resources.some(resource => (manifest.resource_scopes[resource] === "shared") !== manifest.shared_resources.includes(resource))) {
      throw new Error(`${manifest.source}: shared_resources must match resource_scopes`);
    }
  }
  return manifest;
}

function walk(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "spike-openvino-python" || entry.name === "node_modules" || entry.name.startsWith("test-data-")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, result);
    else if (/\.test\.(?:js|cjs|mjs)$/.test(entry.name)) result.push(file);
  }
  return result;
}

function discoverSuites(testRoot = root) {
  const manifests = loadManifests().map(validateManifest);
  const suiteResourceScopes = loadSuiteResourceScopes();
  const seenDomains = new Set();
  for (const manifest of manifests) {
    if (seenDomains.has(manifest.domain)) throw new Error(`duplicate manifest domain: ${manifest.domain}`);
    seenDomains.add(manifest.domain);
  }
  const suites = [];
  const identities = new Set();
  for (const absolute of walk(path.join(testRoot, "test"))) {
    const file = path.relative(testRoot, absolute).split(path.sep).join("/");
    const matches = manifests.filter(manifest => manifest.patterns.some(pattern => globToRegExp(pattern).test(file)));
    const highestPriority = Math.max(...matches.map(item => item.priority));
    const ownersAtPriority = matches.filter(item => item.priority === highestPriority);
    const manifest = ownersAtPriority[0];
    if (!manifest) throw new Error(`orphaned test suite: ${file}`);
    if (ownersAtPriority.length > 1 && manifest.domain !== "compatibility") {
      const owners = ownersAtPriority.map(item => item.domain);
      if (new Set(owners).size > 1) throw new Error(`test suite has multiple domain owners: ${file} (${owners.join(", ")})`);
    }
    const identity = `${manifest.domain}:${file}`;
    if (identities.has(identity)) throw new Error(`duplicate suite identity: ${identity}`);
    identities.add(identity);
    const live = Boolean(manifest.live) || manifest.domain === "live";
    if (live && process.env.SIDEKICK_TEST_LIVE !== "1") continue;
    const isolated = suiteResourceScopes[file] === true;
    const resources = manifest.resources.map(resource => (!isolated || manifest.resource_scopes[resource] === "shared")
      ? resource
      : `${resource}:${file}`);
    suites.push({ file, id: identity, domain: manifest.domain, tier: manifest.tier, criticality: manifest.criticality,
      resources: manifest.resources, lock_resources: resources, timeout_ms: manifest.timeout_ms, live, owner: manifest.owner,
      allow_skip: manifest.allow_skip === true || live, description: manifest.description || `${manifest.domain} test suite` });
  }
  return suites.sort((a, b) => a.file.localeCompare(b.file));
}

function matchesSelection(suite, name) { return name === suite.file || name === path.basename(suite.file) || name === suite.id; }

function selectSuites(allSuites, requested = [], filters = {}) {
  if (!allSuites.length) return { selected: [], unknown: [], error: "No test suites were discovered." };
  const unknown = requested.filter(name => !allSuites.some(suite => matchesSelection(suite, name)));
  let selected = requested.length ? allSuites.filter(suite => requested.some(name => matchesSelection(suite, name))) : allSuites;
  if (filters.domain) selected = selected.filter(suite => suite.domain === filters.domain);
  if (filters.tier) {
    const tiers = Array.isArray(filters.tier) ? filters.tier : String(filters.tier).split(",");
    selected = selected.filter(suite => tiers.includes(suite.tier));
  }
  if (!selected.length) return { selected: [], unknown, error: unknown.length ? `Invalid test suite selection: ${unknown.join(", ")}` : "No suites match the requested filters." };
  return { selected, unknown, error: unknown.length ? `Invalid test suite selection: ${unknown.join(", ")}` : null };
}

function shuffleSuites(suites, seed) {
  if (!Number.isInteger(seed)) return suites;
  const result = [...suites];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

class ResourceLocks {
  constructor() { this.busy = new Set(); this.waiters = []; }
  canAcquire(names) { return !this.busy.has("exclusive") && !names.some(name => this.busy.has(name)) && (!names.includes("exclusive") || !this.busy.size); }
  async acquire(resources) {
    const names = [...new Set(resources || [])].sort();
    const started = Date.now();
    let waits = 0;
    if (!this.canAcquire(names)) {
      waits++;
      await new Promise(resolve => this.waiters.push({ names, resolve }));
    }
    while (!this.canAcquire(names)) {
      waits++;
      await new Promise(resolve => this.waiters.push({ names, resolve }));
    }
    for (const name of names) this.busy.add(name);
    const release = () => { for (const name of names) this.busy.delete(name); this.#wake(); };
    release.wait_ms = Date.now() - started;
    release.wait_count = waits;
    return release;
  }
  #wake() {
    const next = this.waiters[0];
    if (next && this.canAcquire(next.names)) {
      this.waiters.shift();
      next.resolve();
    }
  }
}

function terminate(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    return new Promise(resolve => killer.once("close", resolve));
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

function executeSuite(suite, { cwd, stream, testNamePattern, signal, coverage = false, queue_wait_ms = 0, lock_wait_ms = 0, active = 0 }) {
  return new Promise(resolve => {
    const started = Date.now();
    const args = coverage ? ["--experimental-test-coverage", "--test"] : ["--test"];
    if (testNamePattern) args.push("--test-name-pattern", testNamePattern);
    args.push(path.resolve(cwd, suite.file));
    const child = spawn(process.execPath, args, { cwd, detached: process.platform !== "win32", env: { ...process.env, NODE_ENV: "test", SIDEKICK_TEST_SUITE_ID: suite.id }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, cancelled = false;
    const append = (target, chunk) => { const text = chunk.toString(); if (target === "stdout") stdout += text; else stderr += text; if (stream) process[target].write(text); };
    child.stdout.on("data", chunk => append("stdout", chunk));
    child.stderr.on("data", chunk => append("stderr", chunk));
    const timer = setTimeout(async () => { timedOut = true; await terminate(child); }, suite.timeout_ms);
    const onAbort = async () => { cancelled = true; await terminate(child); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("close", (code, signalName) => {
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      const status = timedOut ? "timeout" : cancelled ? "cancelled" : code === SKIP_EXIT_CODE ? "skipped" : code === 0 ? "passed" : "failed";
      resolve({ suite: suite.file, id: suite.id, status, code, signal: signalName, duration_ms: Date.now() - started, queue_wait_ms, lock_wait_ms, active_concurrency: active, stdout, stderr, reproduction: `node ${suite.file}${testNamePattern ? ` --test-name-pattern ${JSON.stringify(testNamePattern)}` : ""}` });
    });
  });
}

function validateRunConfig({ concurrency, overallTimeoutMs, seed }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("concurrency must be an integer between 1 and 20");
  if (!Number.isInteger(overallTimeoutMs) || overallTimeoutMs < 1000) throw new Error("overallTimeoutMs must be an integer of at least 1000ms");
  if (seed !== undefined && !Number.isInteger(seed)) throw new Error("seed must be an integer");
}

async function runSuites({ requested = [], cwd = root, domain, tier, seed, concurrency, stream = false, failFast = false, testNamePattern, coverage = false, signal, overallTimeoutMs, output = console, onProgress, onEvent } = {}) {
  if (concurrency === undefined) concurrency = process.env.SIDEKICK_TEST_CONCURRENCY === undefined ? 4 : Number(process.env.SIDEKICK_TEST_CONCURRENCY);
  if (overallTimeoutMs === undefined) overallTimeoutMs = process.env.SIDEKICK_TEST_OVERALL_TIMEOUT_MS === undefined ? 30 * 60 * 1000 : Number(process.env.SIDEKICK_TEST_OVERALL_TIMEOUT_MS);
  try { validateRunConfig({ concurrency, overallTimeoutMs, seed }); } catch (error) {
    output.error(error.message);
    return { passed: 0, failed: 1, skipped: 0, exitCode: CONFIG_EXIT_CODE, failures: [], results: [], error: error.message };
  }
  const progress = event => {
    const structured = Object.freeze({ ...event });
    for (const callback of [onProgress, onEvent, output.progress]) if (typeof callback === "function") callback(structured);
  };
  let allSuites;
  try { allSuites = discoverSuites(cwd); } catch (error) { output.error(error.message); return { passed: 0, failed: 1, skipped: 0, exitCode: CONFIG_EXIT_CODE, failures: [], results: [], error: error.message }; }
  const selection = selectSuites(allSuites, requested, { domain, tier });
  if (selection.error || !selection.selected.length) { output.error(selection.error || "No test suites selected."); return { passed: 0, failed: 1, skipped: 0, exitCode: CONFIG_EXIT_CODE, failures: [], results: [], error: selection.error }; }
  const wall_started = Date.now();
  const orderedSelection = shuffleSuites(selection.selected, seed);
  const locks = new ResourceLocks(), results = [], queue = orderedSelection.map(suite => ({ suite, queued_at: Date.now() }));
  progress({ type: "runner", event: "started", total: orderedSelection.length, concurrency });
  orderedSelection.forEach((suite, index) => progress({ type: "suite", event: "queued", suite: suite.file, id: suite.id, index }));
  const controller = new AbortController();
  let stopped = false;
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  controller.signal.addEventListener("abort", () => { stopped = true; }, { once: true });
  const overallTimer = setTimeout(() => controller.abort(), Math.max(1000, overallTimeoutMs));
  let active = 0;
  let peak_concurrency = 0;
  async function worker() {
    while (queue.length && !stopped) {
      const item = queue.shift();
      const suite = item.suite;
      const queue_wait_ms = Date.now() - item.queued_at;
      const release = await locks.acquire(suite.lock_resources || suite.resources);
      let counted = false;
      try {
        if (controller.signal.aborted) continue;
        active++;
        counted = true;
        peak_concurrency = Math.max(peak_concurrency, active);
        progress({ type: "suite", event: "started", suite: suite.file, id: suite.id, active_concurrency: active, queue_wait_ms, lock_wait_ms: release.wait_ms });
        const result = await executeSuite(suite, { cwd, stream, testNamePattern, coverage, signal: controller.signal, queue_wait_ms, lock_wait_ms: release.wait_ms, active });
        results.push(result);
        progress({ type: "suite", event: "finished", suite: suite.file, id: suite.id, status: result.status, duration_ms: result.duration_ms, active_concurrency: active });
        if (result.status === "failed" || result.status === "timeout" || result.status === "cancelled") stopped = stopped || failFast;
      } finally { if (counted) active--; release(); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(20, concurrency)) }, () => worker()));
  clearTimeout(overallTimer);
  signal?.removeEventListener("abort", forwardAbort);
  results.sort((a, b) => a.suite.localeCompare(b.suite));
  const passed = results.filter(item => item.status === "passed").length;
  const skipped = results.filter(item => item.status === "skipped").length;
  const unexpectedSkips = results.filter(item => item.status === "skipped" && !allSuites.find(suite => suite.file === item.suite)?.allow_skip);
  const failures = results.filter(item => item.status !== "passed" && (item.status !== "skipped" || unexpectedSkips.some(skip => skip.suite === item.suite)));
  const notRun = selection.selected.filter(suite => !results.some(result => result.suite === suite.file)).map(suite => suite.file);
  const report = { version: 2, passed, failed: failures.length, skipped, unexpected_skips: unexpectedSkips.map(item => item.suite), not_run: notRun, cancelled: results.filter(item => item.status === "cancelled").map(item => item.suite), timed_out: results.filter(item => item.status === "timeout").map(item => item.suite), wall_duration_ms: Date.now() - wall_started, duration_ms: Date.now() - wall_started, peak_concurrency, slowest: [...results].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 10), failures, results };
  notRun.forEach(suite => progress({ type: "suite", event: "not_run", suite }));
  output.log(`Test summary: ${passed} passed, ${failures.length} failed, ${skipped} skipped; slowest: ${report.slowest.slice(0, 3).map(item => `${item.suite} (${item.duration_ms}ms)`).join(", ")}`);
  if (failures.length) output.error(`Failed suites: ${failures.map(item => `${item.suite} [${item.status}]`).join(", ")}`);
  if (notRun.length) output.error(`Not run: ${notRun.join(", ")}`);
  const final = { ...report, seed: Number.isInteger(seed) ? seed : null, exitCode: failures.length || unexpectedSkips.length || notRun.length ? 1 : 0 };
  progress({ type: "runner", event: "finished", exitCode: final.exitCode, passed, failed: failures.length, skipped, not_run: notRun.length });
  return final;
}

module.exports = { CONFIG_EXIT_CODE, SKIP_EXIT_CODE, discoverSuites, selectSuites, runSuites, ResourceLocks, globToRegExp, shuffleSuites, validateManifest, validateRunConfig };
