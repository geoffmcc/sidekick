#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const workerConfig = require("../compute/worker-config");
const credentialStore = require("../compute/worker-credential");
const { validateControlPlaneUrl } = require("../compute/control-plane-url");
const { readSecret } = require("../core/runtime-secrets");
const { getCanonicalRegistry } = require("../tools/canonical-registry");
const toolContext = require("../tools/context");
const { createRegistry } = require("../tools/registry");
const { normalizeDescriptor } = require("../tools/descriptor");
const { descriptorIdentity } = require("./placement");
const { createWorkspace, resolveWorkspacePath, discoverRepositories, stableId } = require("./workspace");
const { workspacePermissionForTool } = require("./workspace-permissions");
const { resolveCommandOnPath } = require("../security/command-lookup");

const VERSION = require("../../package.json").version;
const PROTOCOL_VERSION = "1";
const SERVER_URL = process.env.SIDEKICK_URL || process.env.SIDEKICK_SERVER_URL || "http://127.0.0.1:4097";
const CONFIG_PATH = process.env.SIDEKICK_NODE_CONFIG || path.join(os.homedir(), ".config", "sidekick", "node.json");
const CREDENTIAL_PATH = process.env.SIDEKICK_NODE_CREDENTIAL || path.join(os.homedir(), ".config", "sidekick", "node-credential.json");
let workspaceRoot = process.env.SIDEKICK_NODE_WORKSPACE_ROOT || null;
let workspaceName = process.env.SIDEKICK_NODE_WORKSPACE_NAME || null;
const HEARTBEAT_MS = boundedInt(process.env.SIDEKICK_NODE_HEARTBEAT_MS, 30000, 5000, 300000);
const POLL_MS = boundedInt(process.env.SIDEKICK_NODE_POLL_MS, 1000, 250, 60000);
const CONCURRENCY = boundedInt(process.env.SIDEKICK_NODE_CONCURRENCY, 2, 1, 8);
const MAX_OUTPUT = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const WORKSPACE_ROOT_DEFAULT_TOOLS = new Set([
  "list", "search", "security_scan", "semantic_repo", "dev_repo_profile",
  "dev_change_summary", "dev_verify", "changelog", "git",
]);
let workerId = null;
let credential = null;
let workspace = null;
let running = true;
let nodeConfig = {};
let nodeRegistry = null;
const activeControllers = new Set();

function boundedInt(value, fallback, min, max) { const n = Number(value || fallback); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function log(message) { process.stderr.write(`[sidekick-node] ${new Date().toISOString()} ${redact(message)}\n`); }
function redact(value) { return String(value || "").replace(/(?:wksec_|enroll_)[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/(token|secret|password|api[_-]?key)=?[^\s,;]+/gi, "$1=[REDACTED]"); }
function loadConfig() { try { const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("configuration must be an object"); return parsed; } catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`invalid node configuration: ${e.message}`); } }
function token() {
  const file = process.env.SIDEKICK_NODE_ENROLL_TOKEN_FILE || path.join(os.homedir(), ".config", "sidekick", "node-enrollment-token");
  // Missing enrollment material is a normal pre-enrollment state. When the
  // file exists, use the shared secret reader so permissions, ACLs, symlinks,
  // race replacement, and size are validated before its contents are read.
  if (!fs.existsSync(file)) return "";
  process.env.SIDEKICK_NODE_ENROLL_TOKEN_FILE = file;
  return readSecret("SIDEKICK_NODE_ENROLL_TOKEN");
}
function nodeId() { return process.env.SIDEKICK_NODE_ID || workerConfig.generateStableNodeId(); }
function networkScopes() {
  const configured = Array.isArray(nodeConfig.networkScopes) ? nodeConfig.networkScopes : [];
  const environment = String(process.env.SIDEKICK_NODE_NETWORK_SCOPE || "").split(",").map(value => value.trim()).filter(Boolean);
  return [...new Set([...configured, ...environment].map(String).filter(value => /^[A-Za-z][A-Za-z0-9_.:-]{0,120}$/.test(value)))].slice(0, 16);
}
function registry() {
  if (nodeRegistry) return nodeRegistry;
  const builtin = getCanonicalRegistry({ includeActiveModules: false });
  const descriptors = [...builtin.list()];
  if (Array.isArray(nodeConfig.packs) && nodeConfig.packs.includes("developer")) {
    const entry = require("../../packs/developer/modules/developer-tools/entry");
    const services = createDeveloperServices(builtin);
    for (const descriptor of entry.buildDescriptors(services)) descriptors.push(normalizeDescriptor({ ...descriptor, source: "module:developer-tools", family: null }));
  }
  nodeRegistry = createRegistry(descriptors);
  return nodeRegistry;
}
function createDeveloperServices(builtin, {
  targetWorkspace = workspace,
  dispatchCanonical = (name, args, options) => require("../tools/dispatcher").callTool(name, args, options),
} = {}) {
  return {
    config: { repository_roots: targetWorkspace?.root ? [targetWorkspace.root] : [] },
    paths: { enforce: localPathPolicy },
    dispatch: async (name, args, options = {}) => {
      if (!builtin.get(name)) return { content: [{ type: "text", text: `Unknown local dependency: ${name}` }], isError: true };
      if (name === "bash") {
        try {
          if (targetWorkspace?.permissions?.execute !== true) throw new Error("execution is not granted by the node workspace");
          workspaceForPath(args?.cwd, "execute", targetWorkspace);
        } catch (error) {
          return { content: [{ type: "text", text: `Workspace denied: ${redact(error.message)}` }], isError: true, code: "workspace_denied" };
        }
      }
      return dispatchCanonical(name, args || {}, options);
    },
  };
}
function descriptorSetHash() { const names = registry().list().map(d => `${d.name}:${descriptorIdentity(d)}`).join("\n"); return crypto.createHash("sha256").update(names).digest("hex"); }
function commandOnPath(name, searchPath = process.env.PATH || "", pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD") {
  return Boolean(resolveCommandOnPath(name, searchPath, pathExt));
}
function binaries() {
  const names = ["git", "rg", "grep", "node", "npm", "python3", "go", "cargo", "ruby", "java"];
  return names.filter(name => commandOnPath(name));
}
function capabilities() { return { nodeId: nodeId(), executionHost: os.hostname(), nodeVersion: process.version, osType: os.type(), osRelease: os.release(), architecture: os.arch(), platform: process.platform, descriptorSetHash: descriptorSetHash(), binaries: binaries(), packs: Array.isArray(nodeConfig.packs) ? nodeConfig.packs.slice(0, 16) : [], workspaces: workspace ? [{ name: workspace.name, root: workspace.root, permissions: workspace.permissions, limits: workspace.limits }] : [], networkScopes: networkScopes(), browser: false, privilege: false, healthy: true }; }
function effectiveConcurrency(targetWorkspace = workspace) {
  const workspaceLimit = Number(targetWorkspace?.limits?.maxConcurrent);
  return Math.min(CONCURRENCY, Number.isInteger(workspaceLimit) && workspaceLimit > 0 ? workspaceLimit : CONCURRENCY);
}
function effectiveOutputLimit(targetWorkspace = workspace) {
  const workspaceLimit = Number(targetWorkspace?.limits?.maxOutputBytes);
  return Math.min(MAX_OUTPUT, Number.isInteger(workspaceLimit) && workspaceLimit > 0 ? workspaceLimit : MAX_OUTPUT);
}
function request(method, endpoint, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let url;
    try { validateControlPlaneUrl(SERVER_URL); url = new URL(endpoint, SERVER_URL); }
    catch (error) { reject(error); return; }
    const transport = url.protocol === "https:" ? https : http; const data = body == null ? null : JSON.stringify(body);
    const headers = { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}), ...(workerId && credential ? { authorization: `Bearer ${workerId}:${credential}` } : {}) };
    const req = transport.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, response => {
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: "invalid server response" }; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout"))); req.on("error", reject); if (data) req.write(data); req.end();
  });
}
function saveCredential(record) { fs.mkdirSync(path.dirname(CREDENTIAL_PATH), { recursive: true, mode: 0o700 }); credentialStore.save(record, CREDENTIAL_PATH); }
function pathFields(args) { return Object.entries(args || {}).filter(([key, value]) => typeof value === "string" && /(?:^path$|_path$|^path_[ab]$|^destination$|^output$|^target$|^cwd$)/i.test(key)); }
function workspaceForPath(value, operation, targetWorkspace = workspace) {
  if (!targetWorkspace) throw new Error("workspace is not configured");
  return resolveWorkspacePath(targetWorkspace, value, { operation, allowMissing: operation === "write" });
}
function localPathPolicy(target, operation = "read") {
  try {
    workspaceForPath(target, operation);
    return null;
  } catch (error) {
    return { content: [{ type: "text", text: `Path policy denied: ${redact(error.message)}` }], isError: true, code: "path_policy_denied" };
  }
}
function validateLocalArguments(descriptor, args, workspaceOverride = workspace) {
  const rawArgs = args || {};
  const parsed = descriptor.schema.safeParse(rawArgs); if (!parsed.success) throw new Error("local argument validation failed");
  // These handlers otherwise fall back to the node process working directory
  // or the Sidekick source tree. On an execution node, an omitted path means
  // the explicitly configured workspace, never the service's own files.
  if (workspaceOverride?.root && WORKSPACE_ROOT_DEFAULT_TOOLS.has(descriptor.name)
    && typeof rawArgs.path !== "string" && !(descriptor.name === "git" && parsed.data.action === "clone")) {
    parsed.data.path = workspaceOverride.root;
  }
  if (descriptor.name === "bash" && workspaceOverride?.root && typeof parsed.data.cwd !== "string") {
    parsed.data.cwd = workspaceOverride.root;
  }
  const safetyArguments = {
    dev_verify: ["dry_run"],
    dev_change_summary: ["include_ignored"],
    semantic_repo: ["include", "exclude", "relevant_files"],
    dev_repo_profile: ["include", "exclude"],
  }[descriptor.name];
  if (safetyArguments && safetyArguments.some(key => Object.prototype.hasOwnProperty.call(rawArgs, key) && parsed.data[key] === undefined)) {
    throw new Error("stale tool schema: safety argument was stripped before local execution");
  }
  if (descriptor.name === "git" && ["clone", "pull", "push"].includes(parsed.data.action)) {
    // The node currently receives scope names, not an independently enforced
    // destination policy. Treating any configured name as permission to use
    // arbitrary node egress would misrepresent authorization as isolation.
    throw new Error("network Git operations are unavailable: this execution node has no enforced scoped egress broker");
  }
  const requiredPermission = workspacePermissionForTool(descriptor.name, parsed.data) || "read";
  if (!workspaceOverride || workspaceOverride.permissions?.[requiredPermission] !== true) {
    throw new Error(`execution node workspace does not permit ${requiredPermission}`);
  }
  for (const [key, value] of pathFields(parsed.data)) {
    const operation = requiredPermission === "write" || ["destination", "output", "path_a", "path_b"].includes(key)
      ? "write"
      : requiredPermission === "execute" && descriptor.name === "bash" && key === "cwd" ? "execute" : "read";
    workspaceForPath(value, operation, workspaceOverride);
  }
  return parsed.data;
}
function boundedResult(result, maxOutputBytes = effectiveOutputLimit()) {
  const outputLimit = Math.max(1024, Math.min(MAX_OUTPUT, Number(maxOutputBytes) || MAX_OUTPUT));
  const normalized = result && typeof result === "object" ? result : { content: [{ type: "text", text: String(result || "") }] };
  let truncated = false;
  function trim(value, depth = 0) {
    if (typeof value === "string") {
      const next = redact(value).slice(0, Math.min(outputLimit, 8192));
      truncated ||= next.length !== value.length;
      return next;
    }
    if (value === null || typeof value !== "object") return value;
    if (depth >= 8) { truncated = true; return "[TRUNCATED]"; }
    if (Array.isArray(value)) return value.slice(0, 256).map(item => trim(item, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 256).map(([key, item]) => [key, trim(item, depth + 1)]));
  }
  let bounded = trim(normalized);
  while (Buffer.byteLength(JSON.stringify(bounded), "utf8") > outputLimit) {
    truncated = true;
    const text = JSON.stringify(bounded);
    bounded = { content: [{ type: "text", text: text.slice(0, outputLimit - 128) }], truncated: true };
    break;
  }
  if (truncated && bounded && typeof bounded === "object" && !Array.isArray(bounded)) bounded.truncated = true;
  return bounded;
}
async function enroll() {
  const existing = credentialStore.load(CREDENTIAL_PATH);
  if (existing) { workerId = existing.workerId; credential = existing.credential; const check = await request("POST", "/execution-node/node/heartbeat", { capabilities: capabilities(), descriptorSetHash: descriptorSetHash(), protocolVersion: PROTOCOL_VERSION, limits: { maxConcurrent: effectiveConcurrency(), maxOutputBytes: effectiveOutputLimit() } }); if (check.status === 200) return; workerId = null; credential = null; }
  const enrollmentToken = token(); if (!enrollmentToken) throw new Error("node enrollment token is not configured");
  const result = await request("POST", "/execution-node/enrollment/exchange", { token: enrollmentToken, nodeId: nodeId(), displayName: process.env.SIDEKICK_NODE_NAME || os.hostname(), platform: process.platform, architecture: os.arch(), nodeVersion: VERSION, protocolVersion: PROTOCOL_VERSION, descriptorSetHash: descriptorSetHash(), capabilities: capabilities(), limits: { maxConcurrent: effectiveConcurrency(), maxOutputBytes: effectiveOutputLimit() } });
  if (result.status !== 200 || !result.body.credential) throw new Error(`node enrollment failed (${result.status})`);
  workerId = result.body.worker.workerId; credential = result.body.credential; saveCredential({ workerId, nodeId: nodeId(), credential });
}
async function heartbeat() { const result = await request("POST", "/execution-node/node/heartbeat", { capabilities: capabilities(), descriptorSetHash: descriptorSetHash(), protocolVersion: PROTOCOL_VERSION, limits: { maxConcurrent: effectiveConcurrency(), maxOutputBytes: effectiveOutputLimit() } }); if (result.status === 401 || result.status === 403) throw new Error("node credential rejected or node revoked"); if (result.status !== 200) throw new Error(`heartbeat failed (${result.status})`); }
async function disconnect() { if (!workerId) return; try { await request("POST", "/execution-node/node/disconnect", { reason: "node_shutdown" }, 5000); } catch {} }
async function execute(job, controller = new AbortController()) {
  const descriptor = registry().get(job.toolName);
  if (!descriptor) throw new Error("unknown tool");
  if (descriptor.version && descriptor.version !== job.descriptorVersion) throw new Error("descriptor version mismatch");
  if (descriptorIdentity(descriptor) !== job.descriptorIdentity) throw new Error("descriptor identity mismatch");
  const args = validateLocalArguments(descriptor, job.args);
  const started = Date.now();
  const timeoutMs = Number(job.context?.timeoutMs) > 0 ? Number(job.context.timeoutMs) : null;
  const deadlineAt = job.context?.deadlineAt || null;
  if (deadlineAt && Date.parse(deadlineAt) <= Date.now()) {
    const error = new Error("node execution deadline expired before the worker started");
    error.code = "node_execution_timeout";
    throw error;
  }
  const deadlineTimer = deadlineAt ? setTimeout(() => controller.abort(Object.assign(new Error("node execution deadline expired"), { code: "node_execution_timeout" })), Math.max(0, Date.parse(deadlineAt) - Date.now())) : null;
  try {
    const executionContext = { ...(job.context || {}), signal: controller.signal };
    const result = boundedResult(await toolContext.runWithContext(executionContext, () => descriptor.handler(args, { signal: controller.signal, context: executionContext, timeoutMs, deadlineAt })));
    if (controller.signal.aborted) throw controller.signal.reason || Object.assign(new Error("node execution cancelled"), { code: "node_execution_cancelled" });
    if (timeoutMs && Date.now() - started > timeoutMs) throw Object.assign(new Error(`node execution exceeded its ${timeoutMs}ms deadline`), { code: "node_execution_timeout" });
    const receipt = { receiptId: stableId("receipt", `${job.jobId}:${started}`), jobId: job.jobId, tool: descriptor.name, descriptorVersion: job.descriptorVersion, descriptorIdentity: job.descriptorIdentity, nodeId: nodeId(), workspace: workspaceName, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), sideEffect: descriptor.risk === "low" ? "read" : "governed", outputBytes: Buffer.byteLength(JSON.stringify(result)), evidence: { untrusted: true, truncated: result.truncated === true } };
    return { result, receipt };
  } finally { if (deadlineTimer) clearTimeout(deadlineTimer); }
}
async function claimLoop() { const active = new Set(); while (running) { if (active.size < effectiveConcurrency()) { try { const response = await request("POST", "/execution-node/node/jobs/claim", { leaseMs: 120000 }); if (response.status === 200 && response.body.job) { const job = response.body.job; const controller = new AbortController(); activeControllers.add(controller); const cancelPoll = setInterval(async () => { try { const status = await request("POST", `/execution-node/node/jobs/${job.jobId}/cancellation`, { leaseId: job.leaseId }); if (status.body.cancellation?.requested) controller.abort(Object.assign(new Error("node execution cancelled"), { code: "node_execution_cancelled" })); } catch {} }, Math.max(1000, Math.min(10000, POLL_MS * 10))); const renewPoll = setInterval(() => request("POST", `/execution-node/node/jobs/${job.jobId}/renew`, { leaseId: job.leaseId, leaseMs: 120000 }).catch(() => {}), 30000); const promise = execute(job, controller).then(output => request("POST", `/execution-node/node/jobs/${job.jobId}/complete`, { leaseId: job.leaseId, result: output.result, receipt: output.receipt })).catch(error => request("POST", `/execution-node/node/jobs/${job.jobId}/fail`, { leaseId: job.leaseId, code: error.code || "local_execution_failed", message: redact(error.message) })).catch(error => { log(`job ${job.jobId} outcome delivery failed: ${error.message}`); }).finally(() => { clearInterval(cancelPoll); clearInterval(renewPoll); activeControllers.delete(controller); active.delete(promise); }); active.add(promise); } else await sleep(POLL_MS); } catch (e) { log(e.message); await sleep(Math.min(30000, POLL_MS * 2)); } } else await sleep(POLL_MS); } await Promise.allSettled([...active]); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function prepare() { nodeConfig = loadConfig(); nodeRegistry = null; workspaceRoot = nodeConfig.workspaceRoot || nodeConfig.workspace || workspaceRoot; workspaceName = nodeConfig.workspaceName || nodeConfig.name || workspaceName; if (!workspaceRoot || !workspaceName) throw new Error("workspaceRoot and workspaceName must be explicitly configured"); workspace = createWorkspace({ name: workspaceName, root: workspaceRoot, permissions: nodeConfig.permissions || { read: true, write: process.env.SIDEKICK_NODE_ALLOW_WRITES === "1", execute: process.env.SIDEKICK_NODE_ALLOW_EXECUTE === "1" }, limits: nodeConfig.limits || { maxConcurrent: CONCURRENCY } }); }
async function main() { prepare(); log(`workspace ${workspace.name} configured with ${discoverRepositories(workspace).length} repository(s)`); await enroll(); await heartbeat(); let timer = null; const stop = () => { running = false; if (timer) clearInterval(timer); for (const controller of activeControllers) controller.abort(new Error("node shutting down")); }; timer = setInterval(() => heartbeat().catch(e => { log(e.message); stop(); }), HEARTBEAT_MS); process.on("SIGTERM", stop); process.on("SIGINT", stop); await claimLoop(); await disconnect(); }
function status() { const record = credentialStore.load(CREDENTIAL_PATH); console.log(JSON.stringify({ version: VERSION, protocolVersion: PROTOCOL_VERSION, serverUrl: SERVER_URL, nodeId: nodeId(), workspace: workspaceName, workspaceRoot, configPath: CONFIG_PATH, credentialPath: CREDENTIAL_PATH, enrolled: Boolean(record), workerId: record?.workerId || null, packs: Array.isArray(nodeConfig.packs) ? nodeConfig.packs : [] }, null, 2)); }
async function doctor() { const checks = []; try { prepare(); checks.push({ name: "workspace", ok: true, repositories: discoverRepositories(workspace).length }); } catch (error) { checks.push({ name: "workspace", ok: false, error: error.message }); } const record = credentialStore.load(CREDENTIAL_PATH); checks.push({ name: "credential", ok: Boolean(record), state: record ? "present" : "not_enrolled" }); checks.push({ name: "enrollment_token", ok: Boolean(token()), state: token() ? "configured" : "not_configured" }); checks.push({ name: "descriptor_set", ok: (() => { try { descriptorSetHash(); return true; } catch { return false; } })() }); console.log(JSON.stringify({ ok: checks.every(check => check.ok), checks }, null, 2)); if (checks.some(check => !check.ok)) process.exitCode = 1; }
async function runCommand(command) { if (command === "version") return console.log(VERSION); if (command === "status") { nodeConfig = loadConfig(); return status(); } if (command === "doctor") return doctor(); if (command === "enroll") { prepare(); await enroll(); return; } return main(); }
if (require.main === module) runCommand(process.argv[2] || "run").catch(error => { log(error.message); process.exitCode = 1; });
module.exports = { capabilities, descriptorSetHash, validateLocalArguments, createDeveloperServices, boundedResult, effectiveConcurrency, effectiveOutputLimit, createWorkspace, binaries, commandOnPath, request };
