"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const SKIP_EXIT_CODE = 77;
const CONFIG_EXIT_CODE = 2;
const root = path.resolve(__dirname, "..");
const manifestDir = path.join(__dirname, "manifests");
const allowedTiers = new Set(["smoke", "unit", "contract", "integration", "security", "e2e", "compatibility", "live"]);
const allowedCriticality = new Set(["required", "optional"]);
const allowedContractKinds = new Set(["isolated", "shared", "exclusive"]);
const supportedPlatforms = new Set(["linux", "win32", "darwin"]);
const suiteResourcePath = path.join(__dirname, "suite-resources.json");
const DEFAULT_OUTPUT_LIMIT = 12000;
const DEFAULT_SLOW_THRESHOLD_MS = 15000;
const DEFAULT_HEARTBEAT_MS = 5000;
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const meaninglessNames = new Set(["bar", "default", "foo", "generic", "isolated", "misc", "none", "resource", "shared", "test", "test-fixture", "thing", "unknown"]);
const provisioners = new Map();
const cleanups = new Map();

function validateRegisteredName(name, label) {
  if (typeof name !== "string" || !identifierPattern.test(name) || meaninglessNames.has(name)) {
    throw new Error(`${label} must be a meaningful registered name`);
  }
  return name;
}

function registerProvisioner(name, implementation) {
  validateRegisteredName(name, "provisioner name");
  const handler = typeof implementation === "function" ? { provision: implementation } : implementation;
  if (!handler || typeof handler.provision !== "function") throw new Error(`provisioner ${name} must define provision()`);
  if (handler.supports !== undefined && typeof handler.supports !== "function") throw new Error(`provisioner ${name} supports must be a function`);
  if (provisioners.has(name)) throw new Error(`provisioner already registered: ${name}`);
  provisioners.set(name, Object.freeze({ ...handler }));
  return name;
}

function registerCleanup(name, implementation) {
  validateRegisteredName(name, "cleanup name");
  const handler = typeof implementation === "function" ? implementation : implementation?.cleanup;
  if (typeof handler !== "function") throw new Error(`cleanup ${name} must define cleanup()`);
  if (cleanups.has(name)) throw new Error(`cleanup already registered: ${name}`);
  cleanups.set(name, handler);
  return name;
}

function validateScopedEnv(env, label) {
  if (env === undefined) return {};
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error(`${label}: env must be an object`);
  const forbidden = new Set(["DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "NODE_OPTIONS"]);
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || forbidden.has(key)) throw new Error(`${label}: invalid scoped environment key ${key}`);
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`${label}: scoped environment values must be scalar`);
  }
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]));
}

function safeTempChild(target, ownerRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(ownerRoot);
  if (path.dirname(resolvedRoot) !== path.resolve(os.tmpdir()) || path.dirname(resolvedTarget) !== resolvedRoot) {
    throw new Error(`refusing cleanup outside the owned suite temp root: ${target}`);
  }
  return resolvedTarget;
}

function resourceDirectory(context, resource) {
  const directory = path.join(context.root, `${resource}-${crypto.randomUUID()}`);
  fs.mkdirSync(directory, { recursive: false });
  return directory;
}

function noProvision() { return {}; }

registerProvisioner("scope-metadata", noProvision);
registerProvisioner("in-process", noProvision);
registerProvisioner("sqlite-file", context => {
  const directory = resourceDirectory(context, "sqlite");
  const file = path.join(directory, "sidekick.db");
  fs.closeSync(fs.openSync(file, "a"));
  return { value: { path: file }, env: { SIDEKICK_TEST_DATA_DIR: directory, SIDEKICK_TEST_DB_FILE: file }, owned_paths: [directory] };
});
registerProvisioner("temp-directory", context => {
  const directory = resourceDirectory(context, "filesystem");
  return { value: { path: directory }, env: { SIDEKICK_TEST_FILESYSTEM_ROOT: directory, SIDEKICK_TEST_FIXTURE_DIR: directory }, owned_paths: [directory] };
});
registerProvisioner("process-group", context => ({ value: { id: context.suite.id }, env: { SIDEKICK_TEST_PROCESS_SCOPE: context.token } }));
registerProvisioner("browser-profile", context => {
  const directory = resourceDirectory(context, "browser");
  return { value: { path: directory }, env: { SIDEKICK_TEST_BROWSER_ROOT: directory }, owned_paths: [directory] };
});
registerProvisioner("git-workspace", context => {
  const directory = resourceDirectory(context, "git");
  return { value: { path: directory }, env: { SIDEKICK_TEST_GIT_ROOT: directory }, owned_paths: [directory] };
});
registerProvisioner("environment-scope", context => ({ value: { id: context.token }, env: { SIDEKICK_TEST_ENV_SCOPE: context.token } }));
registerProvisioner("temp-workspace", context => {
  const directory = resourceDirectory(context, "workspace");
  return { value: { path: directory }, env: { SIDEKICK_TEST_WORKSPACE: directory, SIDEKICK_TEST_WORKSPACE_ROOT: directory }, owned_paths: [directory] };
});
registerProvisioner("loopback-port", async context => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    const onError = error => { server.removeListener("listening", resolve); reject(error); };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!port) throw new Error("loopback-port provisioner did not receive a port");
  return { value: { host: "127.0.0.1", port }, env: { SIDEKICK_TEST_PORT: port } };
});
registerProvisioner("operator-live", context => ({ value: { id: context.suite.id }, env: { SIDEKICK_TEST_LIVE_RESOURCE: context.suite.id } }));

registerCleanup("no-op", async () => {});
registerCleanup("owned-temp-tree", async ({ state, scope }) => {
  for (const target of state.owned_paths || []) fs.rmSync(safeTempChild(target, scope.root), { recursive: true, force: true });
});
registerCleanup("close-port", async ({ state }) => {
  if (state.server?.listening) await new Promise(resolve => state.server.close(() => resolve()));
});
registerCleanup("operator-owned", async () => {});

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
  const contracts = JSON.parse(fs.readFileSync(suiteResourcePath, "utf8"));
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts) || contracts.version !== 1 || !contracts.resources || !contracts.suites) {
    throw new Error("test/suite-resources.json: version, resources, and suites are required");
  }
  for (const [name, contract] of Object.entries(contracts.resources)) {
    validateRegisteredName(name, "test/suite-resources.json resource name");
    validateContract(contract, `test/suite-resources.json resource ${name}`);
  }
  for (const [file, contract] of Object.entries(contracts.suites)) {
    validateContract(contract, `test/suite-resources.json suite ${file}`);
    if (file !== "*" && !file.startsWith("test/")) throw new Error(`test/suite-resources.json: invalid suite path ${file}`);
  }
  return contracts;
}

function validateContract(contract, label) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error(`${label}: contract must be an object`);
  if (!allowedContractKinds.has(contract.kind)) throw new Error(`${label}: kind must be isolated, shared, or exclusive`);
  for (const field of ["provisioner", "fixture", "cleanup", "cleanup_owner", "lock_identity"]) {
    if (typeof contract[field] !== "string" || !contract[field].trim()) throw new Error(`${label}: ${field} is required`);
  }
  if (!Array.isArray(contract.supported_platforms) || !contract.supported_platforms.length || contract.supported_platforms.some(platform => !supportedPlatforms.has(platform))) {
    throw new Error(`${label}: supported_platforms is invalid`);
  }
  for (const field of ["provisioner", "fixture", "cleanup", "cleanup_owner", "lock_identity"]) validateRegisteredName(contract[field], `${label} ${field}`);
  if (!provisioners.has(contract.provisioner)) throw new Error(`${label}: unknown provisioner ${contract.provisioner}`);
  if (!cleanups.has(contract.cleanup)) throw new Error(`${label}: unknown cleanup ${contract.cleanup}`);
  return contract;
}

function validateManifest(manifest) {
  if (!manifest.domain || !/^[a-z][a-z0-9-]+$/.test(manifest.domain)) throw new Error(`${manifest.source}: invalid domain`);
  if (!Number.isInteger(manifest.priority)) throw new Error(`${manifest.source}: priority is required`);
  if (!allowedTiers.has(manifest.tier) || !allowedCriticality.has(manifest.criticality)) throw new Error(`${manifest.source}: invalid tier or criticality`);
  if (!Array.isArray(manifest.patterns) || !manifest.patterns.length || !Array.isArray(manifest.resources)) throw new Error(`${manifest.source}: patterns and resources are required`);
  if (!manifest.resource_contracts || typeof manifest.resource_contracts !== "object" || Array.isArray(manifest.resource_contracts)) throw new Error(`${manifest.source}: resource_contracts are required`);
  const resources = new Set(manifest.resources);
  if (manifest.resources.some(resource => typeof resource !== "string" || !identifierPattern.test(resource) || meaninglessNames.has(resource)) || resources.size !== manifest.resources.length) throw new Error(`${manifest.source}: resources must be unique meaningful names`);
  const contractNames = Object.keys(manifest.resource_contracts);
  if (contractNames.length !== resources.size || contractNames.some(resource => !resources.has(resource))) throw new Error(`${manifest.source}: resource_contracts must classify every declared resource and no others`);
  for (const resource of manifest.resources) validateContract(manifest.resource_contracts[resource], `${manifest.source} resource ${resource}`);
  if (!Number.isInteger(manifest.timeout_ms) || manifest.timeout_ms < 1000) throw new Error(`${manifest.source}: timeout_ms must be a positive integer`);
  for (const pattern of manifest.patterns) globToRegExp(pattern);
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
    const suiteContract = suiteResourceScopes.suites[file] || suiteResourceScopes.suites["*"];
    if (!suiteContract) throw new Error(`missing suite contract: ${file}`);
    if (!suiteContract.supported_platforms.includes(process.platform)) continue;
    const contracts = Object.fromEntries(manifest.resources.map(resource => [resource, manifest.resource_contracts[resource]]));
    for (const resource of manifest.resources) {
      if (!suiteResourceScopes.resources[resource]) throw new Error(`${manifest.source}: resource ${resource} is not registered in test/suite-resources.json`);
    }
    const resources = manifest.resources.flatMap(resource => {
      const contract = contracts[resource];
      if (contract.kind === "exclusive" || suiteContract.kind === "exclusive") return ["exclusive", contract.lock_identity];
      if (suiteContract.kind === "isolated" && contract.kind === "isolated") return [`${contract.lock_identity}:${file}`];
      return [contract.lock_identity];
    });
    suites.push({ file, id: identity, domain: manifest.domain, tier: manifest.tier, criticality: manifest.criticality,
      resources: manifest.resources, contracts, suite_contract: suiteContract, lock_resources: resources, timeout_ms: manifest.timeout_ms, live, owner: manifest.owner,
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

async function provisionSuiteResources(suite, { platform = process.platform, cwd = root } = {}) {
  const supported = suite.suite_contract?.supported_platforms || supportedPlatforms;
  if (!supported.includes(platform)) throw new Error(`${suite.file}: resource contract does not support platform ${platform}`);
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-suite-"));
  const scope = { suite, cwd, platform, token: `${suite.id}:${crypto.randomUUID()}`, root: rootPath, env: {
    SIDEKICK_TEST_SUITE_ID: suite.id,
    SIDEKICK_TEST_SUITE_ROOT: rootPath,
    SIDEKICK_TEST_RESOURCE_ROOT: rootPath
  }, resources: [], released: false };
  try {
    for (const resource of suite.resources || []) {
      const contract = suite.contracts?.[resource];
      if (!contract) throw new Error(`${suite.file}: missing contract for resource ${resource}`);
      const provisioner = provisioners.get(contract.provisioner);
      const cleanup = cleanups.get(contract.cleanup);
      if (!provisioner) throw new Error(`${suite.file}: unknown provisioner ${contract.provisioner}`);
      if (!cleanup) throw new Error(`${suite.file}: unknown cleanup ${contract.cleanup}`);
      if (!contract.supported_platforms.includes(platform)) throw new Error(`${suite.file}: resource ${resource} does not support platform ${platform}`);
      if (provisioner.supports && !provisioner.supports(platform)) throw new Error(`${suite.file}: provisioner ${contract.provisioner} does not support platform ${platform}`);
      const provided = await provisioner.provision({ suite, resource, contract, cwd, platform, root: rootPath, token: scope.token });
      if (provided === undefined || provided === null || typeof provided !== "object" || Array.isArray(provided)) throw new Error(`${suite.file} resource ${resource}: provisioner must return an object`);
      const env = validateScopedEnv(provided.env, `${suite.file} resource ${resource}`);
      const ownedPaths = Array.isArray(provided.owned_paths) ? provided.owned_paths.map(target => safeTempChild(target, rootPath)) : [];
      scope.resources.push({ name: resource, contract, state: { ...provided, env, owned_paths: ownedPaths }, cleanup });
      Object.assign(scope.env, env);
    }
    return scope;
  } catch (error) {
    await cleanupSuiteResources(scope, { reason: "provision-failed" });
    throw error;
  }
}

function detectResourceLeaks(scope) {
  const leaks = [];
  for (const resource of scope?.resources || []) {
    for (const target of resource.state.owned_paths || []) if (fs.existsSync(target)) leaks.push({ resource: resource.name, type: "path", path: target });
    if (resource.state.server?.listening) leaks.push({ resource: resource.name, type: "port", port: resource.state.port });
  }
  return leaks;
}

async function cleanupSuiteResources(scope, { reason = "complete" } = {}) {
  if (!scope || scope.released) return { errors: [], leaks: [] };
  const errors = [];
  for (const resource of [...scope.resources].reverse()) {
    try { await resource.cleanup({ suite: scope.suite, resource: resource.name, contract: resource.contract, state: resource.state, scope, reason }); }
    catch (error) { errors.push({ resource: resource.name, message: error.message }); }
  }
  const leaks = detectResourceLeaks(scope);
  try {
    if (path.dirname(path.resolve(scope.root)) !== path.resolve(os.tmpdir())) throw new Error("suite root is not a direct OS temp child");
    fs.rmSync(scope.root, { recursive: true, force: true });
    if (fs.existsSync(scope.root)) leaks.push({ resource: "suite-root", type: "path", path: scope.root });
  } catch (error) { errors.push({ resource: "suite-root", message: error.message }); }
  scope.released = true;
  return { errors, leaks };
}

class ResourceLocks {
  constructor() { this.busy = new Set(); this.waiters = []; }
  canAcquire(names) { return !this.busy.has("exclusive") && !names.some(name => this.busy.has(name)) && (!names.includes("exclusive") || !this.busy.size); }
  async acquire(resources, signal) {
    const names = [...new Set(resources || [])].sort();
    const started = Date.now();
    let waits = 0;
    while (!this.canAcquire(names)) {
      waits++;
      const acquired = await new Promise(resolve => {
        const waiter = { names, resolve: null };
        const cancel = () => { this.waiters = this.waiters.filter(item => item !== waiter); resolve(false); };
        if (signal?.aborted) return cancel();
        waiter.resolve = value => { signal?.removeEventListener("abort", cancel); resolve(value); };
        signal?.addEventListener("abort", cancel, { once: true });
        this.waiters.push(waiter);
      });
      if (!acquired) return null;
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
      next.resolve(true);
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

async function executeSuite(suite, { cwd, stream, testNamePattern, signal, coverage = false, queue_wait_ms = 0, lock_wait_ms = 0, active = 0, maxOutputChars = DEFAULT_OUTPUT_LIMIT }) {
  const started = Date.now();
  let stdout = "", stderr = "", timedOut = false, cancelled = Boolean(signal?.aborted), outputTruncated = false;
  let scope;
  let child;
  let code = null;
  let signalName = null;
  let executionError = null;
  const append = (target, chunk) => {
    const text = chunk.toString();
    const current = target === "stdout" ? stdout : stderr;
    const visible = text.slice(0, Math.max(0, maxOutputChars - current.length));
    if (visible.length < text.length) outputTruncated = true;
    if (target === "stdout") stdout += visible; else stderr += visible;
    if (stream && visible) process[target].write(visible);
  };
  try {
    if (!cancelled) scope = await provisionSuiteResources(suite, { cwd });
    if (!scope) cancelled = true;
    if (scope && signal?.aborted) cancelled = true;
    if (scope && !cancelled) {
      const args = coverage ? ["--experimental-test-coverage", "--test"] : ["--test"];
      if (testNamePattern) args.push("--test-name-pattern", testNamePattern);
      args.push(path.resolve(cwd, suite.file));
      const childEnv = { ...process.env, NODE_ENV: "test", ...scope.env };
      // Do not make a child node:test process look recursive when the runner is tested by node:test.
      delete childEnv.NODE_TEST_CONTEXT;
      delete childEnv.NODE_TEST_WORKER_ID;
      child = spawn(process.execPath, args, { cwd, detached: process.platform !== "win32", env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => append("stdout", chunk));
      child.stderr.on("data", chunk => append("stderr", chunk));
      let terminationPromise = null;
      const terminateChild = () => { terminationPromise ||= terminate(child); return terminationPromise; };
      const completion = new Promise(resolve => {
        let complete = false;
        const finish = result => { if (complete) return; complete = true; resolve(result); };
        child.once("error", error => finish({ error }));
        child.once("close", (exitCode, exitSignal) => finish({ code: exitCode, signal: exitSignal }));
      });
      const timer = setTimeout(async () => { timedOut = true; await terminateChild(); }, Number.isInteger(suite.timeout_ms) ? suite.timeout_ms : 120000);
      const onAbort = async () => { cancelled = true; await terminateChild(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const completionResult = await completion;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      code = completionResult.code ?? null;
      signalName = completionResult.signal ?? null;
      executionError = completionResult.error || null;
    }
  } catch (error) {
    executionError = error;
  }
  const cleanup = await cleanupSuiteResources(scope, { reason: timedOut ? "timeout" : cancelled ? "cancelled" : executionError ? "execution-failed" : "complete" });
  const status = timedOut ? "timeout" : cancelled ? "cancelled" : executionError ? "failed" : code === SKIP_EXIT_CODE ? "skipped" : code === 0 ? "passed" : "failed";
  const cleanupFailed = cleanup.errors.length > 0 || cleanup.leaks.length > 0;
  const finalStatus = cleanupFailed ? "failed" : status;
  const error = executionError?.message || (cleanupFailed ? "resource cleanup failed or leaked" : undefined);
  return { suite: suite.file, id: suite.id, status: finalStatus, code, signal: signalName, duration_ms: Date.now() - started, queue_wait_ms, lock_wait_ms, active_concurrency: active, stdout, stderr, output_truncated: outputTruncated, error, cleanup_errors: cleanup.errors, resource_leaks: cleanup.leaks, resource_env: scope ? Object.keys(scope.env) : [], reproduction: `node ${suite.file}${testNamePattern ? ` --test-name-pattern ${JSON.stringify(testNamePattern)}` : ""}` };
}

function validateRunConfig({ concurrency, overallTimeoutMs, seed }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("concurrency must be an integer between 1 and 20");
  if (!Number.isInteger(overallTimeoutMs) || overallTimeoutMs < 1000) throw new Error("overallTimeoutMs must be an integer of at least 1000ms");
  if (seed !== undefined && !Number.isInteger(seed)) throw new Error("seed must be an integer");
}

async function runSuites({ requested = [], cwd = root, domain, tier, seed, concurrency, stream = false, failFast = false, testNamePattern, coverage = false, signal, overallTimeoutMs, maxOutputChars = DEFAULT_OUTPUT_LIMIT, slowThresholdMs = DEFAULT_SLOW_THRESHOLD_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS, output = console, onProgress, onEvent } = {}) {
  if (concurrency === undefined) concurrency = process.env.SIDEKICK_TEST_CONCURRENCY === undefined ? 4 : Number(process.env.SIDEKICK_TEST_CONCURRENCY);
  if (overallTimeoutMs === undefined) overallTimeoutMs = process.env.SIDEKICK_TEST_OVERALL_TIMEOUT_MS === undefined ? 30 * 60 * 1000 : Number(process.env.SIDEKICK_TEST_OVERALL_TIMEOUT_MS);
  try { validateRunConfig({ concurrency, overallTimeoutMs, seed }); } catch (error) {
    output.error(error.message);
    return { passed: 0, failed: 1, skipped: 0, exitCode: CONFIG_EXIT_CODE, failures: [], results: [], error: error.message };
  }
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 100) return { passed: 0, failed: 1, skipped: 0, exitCode: CONFIG_EXIT_CODE, failures: [], results: [], error: "maxOutputChars must be an integer of at least 100" };
  if (!Number.isInteger(slowThresholdMs) || slowThresholdMs < 100) return { passed: 0, failed: 1, skipped: 0, exitCode: CONFIG_EXIT_CODE, failures: [], results: [], error: "slowThresholdMs must be an integer of at least 100ms" };
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 100) return { passed: 0, failed: 1, skipped: 0, exitCode: CONFIG_EXIT_CODE, failures: [], results: [], error: "heartbeatMs must be an integer of at least 100ms" };
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
  const state = { completed: 0, current: [], queued: orderedSelection.map(suite => suite.file), lock_waiting: [], counts: { passed: 0, failed: 0, skipped: 0, timeout: 0, cancelled: 0 } };
  const emitState = (event, extra = {}) => progress({ type: event === "heartbeat" ? "runner" : "suite", event, elapsed_ms: Date.now() - wall_started, completed: state.completed, total: orderedSelection.length, counts: { ...state.counts }, current: [...state.current], queued: [...state.queued], lock_waiting: [...state.lock_waiting], ...extra });
  emitState("started", { concurrency });
  orderedSelection.forEach((suite, index) => emitState("queued", { suite: suite.file, id: suite.id, index }));
  const controller = new AbortController();
  let stopped = false;
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  controller.signal.addEventListener("abort", () => { stopped = true; }, { once: true });
  const overallTimer = setTimeout(() => controller.abort(), Math.max(1000, overallTimeoutMs));
  const heartbeat = setInterval(() => emitState("heartbeat"), heartbeatMs);
  let active = 0;
  let peak_concurrency = 0;
  async function worker() {
    while (queue.length && !stopped) {
      const runnable = queue.findIndex(item => locks.canAcquire(item.suite.lock_resources || item.suite.resources));
      const item = queue.splice(runnable < 0 ? 0 : runnable, 1)[0];
      const suite = item.suite;
      const queue_wait_ms = Date.now() - item.queued_at;
      state.queued = state.queued.filter(name => name !== suite.file);
      const lockResources = suite.lock_resources || suite.resources;
      if (!locks.canAcquire(lockResources)) {
        state.lock_waiting.push(suite.file);
        emitState("lock-waiting", { suite: suite.file, id: suite.id });
      }
      const release = await locks.acquire(lockResources, controller.signal);
      state.lock_waiting = state.lock_waiting.filter(name => name !== suite.file);
      let counted = false;
      try {
        if (!release || controller.signal.aborted) continue;
        active++;
        counted = true;
        peak_concurrency = Math.max(peak_concurrency, active);
        state.current.push(suite.file);
        emitState("started", { suite: suite.file, id: suite.id, active_concurrency: active, queue_wait_ms, lock_wait_ms: release.wait_ms });
        const slowTimer = setTimeout(() => emitState("slow-warning", { suite: suite.file, id: suite.id, threshold_ms: slowThresholdMs }), slowThresholdMs);
        const result = await executeSuite(suite, { cwd, stream, testNamePattern, coverage, signal: controller.signal, queue_wait_ms, lock_wait_ms: release.wait_ms, active, maxOutputChars });
        clearTimeout(slowTimer);
        results.push(result);
        state.current = state.current.filter(name => name !== suite.file);
        state.completed++;
        state.counts[result.status] = (state.counts[result.status] || 0) + 1;
        emitState("finished", { suite: suite.file, id: suite.id, status: result.status, duration_ms: result.duration_ms, active_concurrency: active });
        if (result.status === "failed" || result.status === "timeout" || result.status === "cancelled") stopped = stopped || failFast;
      } finally { if (counted) active--; if (release) release(); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(20, concurrency)) }, () => worker()));
  clearTimeout(overallTimer);
  clearInterval(heartbeat);
  signal?.removeEventListener("abort", forwardAbort);
  results.sort((a, b) => a.suite.localeCompare(b.suite));
  const passed = results.filter(item => item.status === "passed").length;
  const skipped = results.filter(item => item.status === "skipped").length;
  const unexpectedSkips = results.filter(item => item.status === "skipped" && !allSuites.find(suite => suite.file === item.suite)?.allow_skip);
  const failures = results.filter(item => item.status !== "passed" && (item.status !== "skipped" || unexpectedSkips.some(skip => skip.suite === item.suite)));
  const notRun = selection.selected.filter(suite => !results.some(result => result.suite === suite.file)).map(suite => suite.file);
  const report = { version: 2, passed, failed: failures.length, skipped, unexpected_skips: unexpectedSkips.map(item => item.suite), not_run: notRun, cancelled: results.filter(item => item.status === "cancelled").map(item => item.suite), timed_out: results.filter(item => item.status === "timeout").map(item => item.suite), wall_duration_ms: Date.now() - wall_started, duration_ms: Date.now() - wall_started, peak_concurrency, slowest: [...results].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 10), failures, results };
  notRun.forEach(suite => emitState("not_run", { suite }));
  output.log(`Test summary: ${passed} passed, ${failures.length} failed, ${skipped} skipped; slowest: ${report.slowest.slice(0, 3).map(item => `${item.suite} (${item.duration_ms}ms)`).join(", ")}`);
  if (failures.length) output.error(`Failed suites: ${failures.map(item => `${item.suite} [${item.status}]`).join(", ")}`);
  if (notRun.length) output.error(`Not run: ${notRun.join(", ")}`);
  const final = { ...report, seed: Number.isInteger(seed) ? seed : null, exitCode: failures.length || unexpectedSkips.length || notRun.length ? 1 : 0 };
  emitState("finished", { exitCode: final.exitCode, passed, failed: failures.length, skipped, not_run: notRun.length });
  return final;
}

function createProgressReporter({ output = process.stderr, json = false } = {}) {
  return event => {
    if (json || !output || typeof output.write !== "function") return;
    const counts = event.counts || {};
    const line = [`[${event.elapsed_ms || 0}ms]`, `${event.completed || 0}/${event.total || 0}`, `pass=${counts.passed || 0}`, `fail=${counts.failed || 0}`, `skip=${counts.skipped || 0}`];
    if (event.event === "heartbeat") line.push(`current=${event.current?.join(",") || "-"}`, `queued=${event.queued?.length || 0}`, `lock-waiting=${event.lock_waiting?.length || 0}`);
    if (event.event === "lock-waiting") line.push(`lock-waiting=${event.suite}`);
    if (event.event === "slow-warning") line.push(`SLOW=${event.suite}`);
    if (event.event === "finished" && event.suite) line.push(`${event.suite}=${event.status}`, `${event.duration_ms}ms`);
    output.write(`${line.join(" ")}\n`);
  };
}

module.exports = {
  CONFIG_EXIT_CODE, SKIP_EXIT_CODE, discoverSuites, selectSuites, runSuites, ResourceLocks, globToRegExp, shuffleSuites,
  validateContract, validateManifest, validateRunConfig, createProgressReporter, executeSuite,
  registerProvisioner, registerCleanup, provisionSuiteResources, cleanupSuiteResources, detectResourceLeaks,
  provisioners, cleanups
};
