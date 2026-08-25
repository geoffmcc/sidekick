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
const { getCanonicalRegistry } = require("../tools/canonical-registry");
const { createRegistry } = require("../tools/registry");
const { normalizeDescriptor } = require("../tools/descriptor");
const { descriptorIdentity } = require("./placement");
const { createWorkspace, resolveWorkspacePath, discoverRepositories, stableId } = require("./workspace");

const VERSION = require("../../package.json").version;
const PROTOCOL_VERSION = "1";
const SERVER_URL = process.env.SIDEKICK_URL || process.env.SIDEKICK_SERVER_URL || "http://127.0.0.1:4097";
const CONFIG_PATH = process.env.SIDEKICK_NODE_CONFIG || path.join(os.homedir(), ".config", "sidekick", "node.json");
const CREDENTIAL_PATH = process.env.SIDEKICK_NODE_CREDENTIAL || path.join(os.homedir(), ".config", "sidekick", "node-credential.json");
let workspaceRoot = process.env.SIDEKICK_NODE_WORKSPACE_ROOT || "/home/geoffrey/Projects/security-research";
const WORKSPACE_NAME = "security-research";
const HEARTBEAT_MS = boundedInt(process.env.SIDEKICK_NODE_HEARTBEAT_MS, 30000, 5000, 300000);
const POLL_MS = boundedInt(process.env.SIDEKICK_NODE_POLL_MS, 1000, 250, 60000);
const CONCURRENCY = boundedInt(process.env.SIDEKICK_NODE_CONCURRENCY, 2, 1, 8);
const MAX_OUTPUT = 1024 * 1024;
let workerId = null;
let credential = null;
let workspace = null;
let running = true;
let nodeConfig = {};
let nodeRegistry = null;

function boundedInt(value, fallback, min, max) { const n = Number(value || fallback); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function log(message) { process.stderr.write(`[sidekick-node] ${new Date().toISOString()} ${redact(message)}\n`); }
function redact(value) { return String(value || "").replace(/(?:wksec_|enroll_)[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/(token|secret|password|api[_-]?key)=?[^\s,;]+/gi, "$1=[REDACTED]"); }
function loadConfig() { try { const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("configuration must be an object"); return parsed; } catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`invalid node configuration: ${e.message}`); } }
function token() { const file = process.env.SIDEKICK_NODE_ENROLL_TOKEN_FILE || path.join(os.homedir(), ".config", "sidekick", "node-enrollment-token"); try { const value = fs.readFileSync(file, "utf8").trim(); return value || process.env.SIDEKICK_NODE_ENROLL_TOKEN; } catch { return process.env.SIDEKICK_NODE_ENROLL_TOKEN; } }
function nodeId() { return process.env.SIDEKICK_NODE_ID || workerConfig.generateStableNodeId(); }
function registry() {
  if (nodeRegistry) return nodeRegistry;
  const builtin = getCanonicalRegistry({ includeActiveModules: false });
  const descriptors = [...builtin.list()];
  if (Array.isArray(nodeConfig.packs) && nodeConfig.packs.includes("developer")) {
    const entry = require("../../packs/developer/modules/developer-tools/entry");
    const services = { dispatch: async (name, args) => {
      const descriptor = builtin.get(name);
      if (!descriptor) return { content: [{ type: "text", text: `Unknown local dependency: ${name}` }], isError: true };
      return descriptor.handler(args || {}, { context: { source: "node" } });
    } };
    for (const descriptor of entry.buildDescriptors(services)) descriptors.push(normalizeDescriptor({ ...descriptor, source: "module:developer-tools", family: null }));
  }
  nodeRegistry = createRegistry(descriptors);
  return nodeRegistry;
}
function descriptorSetHash() { const names = registry().list().map(d => `${d.name}:${descriptorIdentity(d)}`).join("\n"); return crypto.createHash("sha256").update(names).digest("hex"); }
function binaries() { const names = ["git", "rg", "grep", "node", "npm", "python3", "go", "cargo", "ruby", "java"]; return names.filter(name => { try { require("child_process").execFileSync("which", [name], { stdio: "ignore", timeout: 1000 }); return true; } catch { return false; } }); }
function capabilities() { return { nodeId: nodeId(), nodeVersion: process.version, osType: os.type(), osRelease: os.release(), architecture: os.arch(), platform: process.platform, descriptorSetHash: descriptorSetHash(), binaries: binaries(), packs: Array.isArray(nodeConfig.packs) ? nodeConfig.packs.slice(0, 16) : [], workspaces: [WORKSPACE_NAME], networkScopes: Array.isArray(nodeConfig.networkScopes) ? nodeConfig.networkScopes.slice(0, 16) : [], browser: false, privilege: false, healthy: true }; }
function request(method, endpoint, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, SERVER_URL); const transport = url.protocol === "https:" ? https : http; const data = body == null ? null : JSON.stringify(body);
    const headers = { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}), ...(workerId && credential ? { authorization: `Bearer ${workerId}:${credential}` } : {}) };
    const req = transport.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, response => { let text = ""; response.on("data", chunk => { text += chunk; if (text.length > 2 * 1024 * 1024) req.destroy(new Error("response too large")); }); response.on("end", () => { let parsed = {}; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: "invalid server response" }; } resolve({ status: response.statusCode, body: parsed }); }); });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout"))); req.on("error", reject); if (data) req.write(data); req.end();
  });
}
function saveCredential(record) { fs.mkdirSync(path.dirname(CREDENTIAL_PATH), { recursive: true, mode: 0o700 }); credentialStore.save(record, CREDENTIAL_PATH); }
function pathFields(args) { return Object.entries(args || {}).filter(([key, value]) => typeof value === "string" && /(?:^path$|_path$|^path_[ab]$|^destination$|^output$|^target$|^cwd$)/i.test(key)); }
function workspaceForPath(value, operation) {
  if (!workspace) throw new Error("workspace is not configured");
  return resolveWorkspacePath(workspace, value, { operation, allowMissing: operation === "write" });
}
function validateLocalArguments(descriptor, args) {
  const parsed = descriptor.schema.safeParse(args || {}); if (!parsed.success) throw new Error("local argument validation failed");
  if (descriptor.name === "git" && ["clone", "pull", "push"].includes(parsed.data.action) && !process.env.SIDEKICK_NODE_NETWORK_SCOPE) throw new Error("network scope is required for this Git operation");
  for (const [key, value] of pathFields(parsed.data)) {
    const operation = ["destination", "output", "path_a", "path_b"].includes(key) ? "write" : "read";
    workspaceForPath(value, operation === "write" && descriptor.name !== "read" ? "write" : "read");
  }
  return parsed.data;
}
function boundedResult(result) {
  const normalized = result && typeof result === "object" ? { ...result } : { content: [{ type: "text", text: String(result || "") }] };
  if (Array.isArray(normalized.content)) normalized.content = normalized.content.map(item => ({ ...item, text: typeof item.text === "string" ? redact(item.text).slice(0, MAX_OUTPUT) : item.text }));
  return JSON.parse(JSON.stringify(normalized, (_key, value) => typeof value === "string" ? value.slice(0, MAX_OUTPUT) : value));
}
async function enroll() {
  const existing = credentialStore.load(CREDENTIAL_PATH);
  if (existing) { workerId = existing.workerId; credential = existing.credential; const check = await request("POST", "/execution-node/node/heartbeat", { capabilities: capabilities(), descriptorSetHash: descriptorSetHash(), protocolVersion: PROTOCOL_VERSION, limits: { maxConcurrent: CONCURRENCY, maxOutputBytes: MAX_OUTPUT } }); if (check.status === 200) return; workerId = null; credential = null; }
  const enrollmentToken = token(); if (!enrollmentToken) throw new Error("node enrollment token is not configured");
  const result = await request("POST", "/execution-node/enrollment/exchange", { token: enrollmentToken, nodeId: nodeId(), displayName: process.env.SIDEKICK_NODE_NAME || os.hostname(), platform: process.platform, architecture: os.arch(), nodeVersion: VERSION, protocolVersion: PROTOCOL_VERSION, descriptorSetHash: descriptorSetHash(), capabilities: capabilities(), limits: { maxConcurrent: CONCURRENCY, maxOutputBytes: MAX_OUTPUT } });
  if (result.status !== 200 || !result.body.credential) throw new Error(`node enrollment failed (${result.status})`);
  workerId = result.body.worker.workerId; credential = result.body.credential; saveCredential({ workerId, nodeId: nodeId(), credential });
}
async function heartbeat() { const result = await request("POST", "/execution-node/node/heartbeat", { capabilities: capabilities(), descriptorSetHash: descriptorSetHash(), protocolVersion: PROTOCOL_VERSION, limits: { maxConcurrent: CONCURRENCY, maxOutputBytes: MAX_OUTPUT } }); if (result.status === 401 || result.status === 403) throw new Error("node credential rejected or node revoked"); if (result.status !== 200) throw new Error(`heartbeat failed (${result.status})`); }
async function execute(job) {
  const descriptor = registry().get(job.toolName);
  if (!descriptor) throw new Error("unknown tool");
  if (descriptor.version && descriptor.version !== job.descriptorVersion) throw new Error("descriptor version mismatch");
  if (descriptorIdentity(descriptor) !== job.descriptorIdentity) throw new Error("descriptor identity mismatch");
  const args = validateLocalArguments(descriptor, job.args);
  const started = Date.now(); const result = boundedResult(await descriptor.handler(args, { signal: null, context: job.context }));
  const receipt = { receiptId: stableId("receipt", `${job.jobId}:${started}`), jobId: job.jobId, tool: descriptor.name, descriptorVersion: job.descriptorVersion, descriptorIdentity: job.descriptorIdentity, nodeId: nodeId(), workspace: WORKSPACE_NAME, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), sideEffect: descriptor.risk === "low" ? "read" : "governed", outputBytes: Buffer.byteLength(JSON.stringify(result)), evidence: { untrusted: true, truncated: JSON.stringify(result).length > MAX_OUTPUT } };
  return { result, receipt };
}
async function claimLoop() { const active = new Set(); while (running) { if (active.size < CONCURRENCY) { try { const response = await request("POST", "/execution-node/node/jobs/claim", { leaseMs: 120000 }); if (response.status === 200 && response.body.job) { const job = response.body.job; const promise = execute(job).then(output => request("POST", `/execution-node/node/jobs/${job.jobId}/complete`, { leaseId: job.leaseId, result: output.result, receipt: output.receipt })).catch(error => request("POST", `/execution-node/node/jobs/${job.jobId}/fail`, { leaseId: job.leaseId, code: "local_execution_failed", message: redact(error.message) })).catch(() => {}); active.add(promise); promise.finally(() => active.delete(promise)); } else await sleep(POLL_MS); } catch (e) { log(e.message); await sleep(Math.min(30000, POLL_MS * 2)); } } else await sleep(POLL_MS); } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function prepare() { nodeConfig = loadConfig(); nodeRegistry = null; workspaceRoot = nodeConfig.workspaceRoot || nodeConfig.workspace || workspaceRoot; if (workspaceRoot !== "/home/geoffrey/Projects/security-research" && process.env.SIDEKICK_NODE_ALLOW_CUSTOM_WORKSPACE !== "1") throw new Error("this installation is restricted to /home/geoffrey/Projects/security-research"); workspace = createWorkspace({ name: WORKSPACE_NAME, root: workspaceRoot, permissions: { read: true, write: process.env.SIDEKICK_NODE_ALLOW_WRITES === "1", execute: process.env.SIDEKICK_NODE_ALLOW_EXECUTE === "1" }, limits: { maxConcurrent: CONCURRENCY } }); }
async function main() { prepare(); log(`workspace ${workspace.name} configured with ${discoverRepositories(workspace).length} repository(s)`); await enroll(); await heartbeat(); const timer = setInterval(() => heartbeat().catch(e => { log(e.message); running = false; }), HEARTBEAT_MS); process.on("SIGTERM", () => { running = false; clearInterval(timer); }); process.on("SIGINT", () => { running = false; clearInterval(timer); }); await claimLoop(); }
function status() { const record = credentialStore.load(CREDENTIAL_PATH); console.log(JSON.stringify({ version: VERSION, protocolVersion: PROTOCOL_VERSION, serverUrl: SERVER_URL, nodeId: nodeId(), workspace: WORKSPACE_NAME, workspaceRoot, configPath: CONFIG_PATH, credentialPath: CREDENTIAL_PATH, enrolled: Boolean(record), workerId: record?.workerId || null, packs: Array.isArray(nodeConfig.packs) ? nodeConfig.packs : [] }, null, 2)); }
async function doctor() { const checks = []; try { prepare(); checks.push({ name: "workspace", ok: true, repositories: discoverRepositories(workspace).length }); } catch (error) { checks.push({ name: "workspace", ok: false, error: error.message }); } const record = credentialStore.load(CREDENTIAL_PATH); checks.push({ name: "credential", ok: Boolean(record), state: record ? "present" : "not_enrolled" }); checks.push({ name: "enrollment_token", ok: Boolean(token()), state: token() ? "configured" : "not_configured" }); checks.push({ name: "descriptor_set", ok: (() => { try { descriptorSetHash(); return true; } catch { return false; } })() }); console.log(JSON.stringify({ ok: checks.every(check => check.ok), checks }, null, 2)); if (checks.some(check => !check.ok)) process.exitCode = 1; }
async function runCommand(command) { if (command === "version") return console.log(VERSION); if (command === "status") { nodeConfig = loadConfig(); return status(); } if (command === "doctor") return doctor(); if (command === "enroll") { prepare(); await enroll(); return; } return main(); }
if (require.main === module) runCommand(process.argv[2] || "run").catch(error => { log(error.message); process.exitCode = 1; });
module.exports = { capabilities, descriptorSetHash, validateLocalArguments, boundedResult, createWorkspace };
