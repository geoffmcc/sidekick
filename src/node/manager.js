"use strict";

const crypto = require("crypto");
const dbStore = require("../db");
const computeWorkers = require("../compute/worker-manager");
const { descriptorIdentity } = require("./placement");

const MAX_RESULT_BYTES = 1024 * 1024;

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`; }
function json(value, fallback = {}) { try { return JSON.stringify(value == null ? fallback : value); } catch { return JSON.stringify(fallback); } }
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function ensureSchema() {
  const db = dbStore.getDb();
  computeWorkers.ensureSchema();
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_nodes (
      worker_id TEXT PRIMARY KEY REFERENCES compute_workers(worker_id) ON DELETE CASCADE,
      protocol_version TEXT NOT NULL DEFAULT '1',
      descriptor_set_hash TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      authorized_workspaces_json TEXT NOT NULL DEFAULT '[]',
      authorized_network_scopes_json TEXT NOT NULL DEFAULT '[]',
      local_limits_json TEXT NOT NULL DEFAULT '{}',
      capability_state TEXT NOT NULL DEFAULT 'unknown',
      capability_checked_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_execution_nodes_capability_state ON execution_nodes(capability_state);
    CREATE TABLE IF NOT EXISTS execution_node_workspaces (
      workspace_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL REFERENCES compute_workers(worker_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      root_identity TEXT NOT NULL,
      permissions_json TEXT NOT NULL DEFAULT '{}',
      limits_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'active',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(worker_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_node_workspaces_worker ON execution_node_workspaces(worker_id);
    CREATE TABLE IF NOT EXISTS execution_node_repositories (
      repository_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES execution_node_workspaces(workspace_id) ON DELETE CASCADE,
      root_identity TEXT NOT NULL,
      display_name TEXT,
      state TEXT NOT NULL DEFAULT 'registered',
      last_seen_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(workspace_id, root_identity)
    );
    CREATE TABLE IF NOT EXISTS execution_node_jobs (
      job_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL REFERENCES compute_workers(worker_id),
      task_id TEXT,
      request_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      descriptor_version TEXT NOT NULL,
      descriptor_identity TEXT NOT NULL,
      args_json TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      workspace_id TEXT,
      repository_id TEXT,
      idempotency_key TEXT UNIQUE,
      state TEXT NOT NULL DEFAULT 'queued',
       lease_id TEXT,
       lease_expires_at TEXT,
       cancellation_requested INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      receipt_json TEXT,
      error_code TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_execution_node_jobs_worker_state ON execution_node_jobs(worker_id, state);
    CREATE INDEX IF NOT EXISTS idx_execution_node_jobs_lease ON execution_node_jobs(lease_expires_at);
  `);
  try { db.exec("ALTER TABLE execution_node_jobs ADD COLUMN cancellation_requested INTEGER NOT NULL DEFAULT 0"); } catch (error) {
    if (!/duplicate column name/i.test(String(error.message || ""))) throw error;
  }
}

function nodeRow(row) {
  if (!row) return null;
  const worker = computeWorkers.getWorker(row.worker_id);
  return {
    nodeId: worker?.nodeId || null,
    workerId: row.worker_id,
    protocolVersion: row.protocol_version,
    descriptorSetHash: row.descriptor_set_hash,
    capabilities: parse(row.capabilities_json, {}),
    authorizedWorkspaces: parse(row.authorized_workspaces_json, []),
    authorizedNetworkScopes: parse(row.authorized_network_scopes_json, []),
    localLimits: parse(row.local_limits_json, {}),
    capabilityState: row.capability_state,
    capabilityCheckedAt: row.capability_checked_at,
    revokedAt: row.revoked_at,
    worker,
  };
}

function register(workerId, { protocolVersion = "1", descriptorSetHash = "", capabilities = {}, workspaces = [], networkScopes = [], limits = {} } = {}) {
  ensureSchema();
  const db = dbStore.getDb();
  db.prepare(`INSERT INTO execution_nodes (worker_id, protocol_version, descriptor_set_hash, capabilities_json, authorized_workspaces_json, authorized_network_scopes_json, local_limits_json, capability_state, capability_checked_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'healthy', ?, ?)
    ON CONFLICT(worker_id) DO UPDATE SET protocol_version=excluded.protocol_version, descriptor_set_hash=excluded.descriptor_set_hash, capabilities_json=excluded.capabilities_json, authorized_workspaces_json=excluded.authorized_workspaces_json, authorized_network_scopes_json=excluded.authorized_network_scopes_json, local_limits_json=excluded.local_limits_json, capability_state='healthy', capability_checked_at=excluded.capability_checked_at, updated_at=excluded.updated_at`)
    .run(workerId, String(protocolVersion), String(descriptorSetHash), json(capabilities), json(workspaces, []), json(networkScopes, []), json(limits), now(), now());
  return get(workerId);
}

function get(workerId) { ensureSchema(); return nodeRow(dbStore.getDb().prepare("SELECT * FROM execution_nodes WHERE worker_id = ?").get(workerId)); }
function list() { ensureSchema(); return dbStore.getDb().prepare("SELECT * FROM execution_nodes ORDER BY created_at").all().map(nodeRow); }

function setWorkspace(workerId, workspace) {
  ensureSchema();
  const db = dbStore.getDb();
  db.prepare(`INSERT INTO execution_node_workspaces (workspace_id, worker_id, name, root_identity, permissions_json, limits_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET name=excluded.name, root_identity=excluded.root_identity, permissions_json=excluded.permissions_json, limits_json=excluded.limits_json, state='active', updated_at=excluded.updated_at`)
    .run(workspace.workspaceId, workerId, workspace.name, workspace.rootIdentity, json(workspace.permissions), json(workspace.limits), now());
  return getWorkspace(workspace.workspaceId);
}
function getWorkspace(workspaceId) { ensureSchema(); const row = dbStore.getDb().prepare("SELECT * FROM execution_node_workspaces WHERE workspace_id = ?").get(workspaceId); return row ? { workspaceId: row.workspace_id, workerId: row.worker_id, name: row.name, rootIdentity: row.root_identity, permissions: parse(row.permissions_json, {}), limits: parse(row.limits_json, {}), state: row.state } : null; }
function listWorkspaces(workerId) { ensureSchema(); return dbStore.getDb().prepare("SELECT * FROM execution_node_workspaces WHERE worker_id = ? AND state = 'active' ORDER BY name").all(workerId).map(row => getWorkspace(row.workspace_id)); }

function authorizeWorkspace(workerId, workspace) {
  const stored = setWorkspace(workerId, workspace);
  const db = dbStore.getDb();
  const names = listWorkspaces(workerId).map(item => item.name);
  db.prepare("UPDATE execution_nodes SET authorized_workspaces_json = ?, updated_at = ? WHERE worker_id = ?").run(json(names, []), now(), workerId);
  return stored;
}

function replaceRepositories(workspaceId, repositories) {
  ensureSchema();
  const db = dbStore.getDb();
  const transaction = db.transaction(items => {
    for (const repo of items) db.prepare(`INSERT INTO execution_node_repositories (repository_id, workspace_id, root_identity, display_name, state, last_seen_at, metadata_json)
      VALUES (?, ?, ?, ?, 'registered', ?, ?) ON CONFLICT(repository_id) DO UPDATE SET root_identity=excluded.root_identity, display_name=excluded.display_name, state='registered', last_seen_at=excluded.last_seen_at, metadata_json=excluded.metadata_json`)
      .run(repo.repositoryId, workspaceId, repo.rootIdentity, repo.displayName || null, now(), json(repo.metadata));
  });
  transaction(Array.isArray(repositories) ? repositories.slice(0, 1024) : []);
  return db.prepare("SELECT * FROM execution_node_repositories WHERE workspace_id = ? ORDER BY repository_id").all(workspaceId).map(row => ({ repositoryId: row.repository_id, workspaceId: row.workspace_id, rootIdentity: row.root_identity, displayName: row.display_name, state: row.state, lastSeenAt: row.last_seen_at }));
}

function enqueue({ workerId, requestId, taskId, toolName, descriptor, args, context = {}, workspaceId = null, repositoryId = null, idempotencyKey = null }) {
  ensureSchema();
  const db = dbStore.getDb();
  if (workspaceId) {
    const workspace = db.prepare("SELECT workspace_id FROM execution_node_workspaces WHERE workspace_id = ? AND worker_id = ? AND state = 'active'").get(workspaceId, workerId);
    if (!workspace) throw new Error("execution workspace is not authorized for this worker");
  }
  if (repositoryId) {
    const repository = db.prepare("SELECT r.repository_id FROM execution_node_repositories r JOIN execution_node_workspaces w ON w.workspace_id = r.workspace_id WHERE r.repository_id = ? AND r.state = 'registered' AND w.worker_id = ? AND w.state = 'active' AND (? IS NULL OR r.workspace_id = ?)").get(repositoryId, workerId, workspaceId, workspaceId);
    if (!repository) throw new Error("execution repository is not authorized for this worker workspace");
  }
  if (idempotencyKey) {
    const existing = db.prepare("SELECT * FROM execution_node_jobs WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return jobRow(existing);
  }
  const jobId = id("nodejob");
  db.prepare(`INSERT INTO execution_node_jobs (job_id, worker_id, task_id, request_id, tool_name, descriptor_version, descriptor_identity, args_json, context_json, workspace_id, repository_id, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(jobId, workerId, taskId || null, requestId, toolName, descriptor.version || "1", descriptorIdentity(descriptor), json(args), json(context), workspaceId, repositoryId, idempotencyKey);
  return getJob(jobId);
}

function jobRow(row) { return row ? { jobId: row.job_id, workerId: row.worker_id, taskId: row.task_id, requestId: row.request_id, toolName: row.tool_name, descriptorVersion: row.descriptor_version, descriptorIdentity: row.descriptor_identity, args: parse(row.args_json, {}), context: parse(row.context_json, {}), workspaceId: row.workspace_id, repositoryId: row.repository_id, state: row.state, leaseId: row.lease_id, leaseExpiresAt: row.lease_expires_at, cancellationRequested: row.cancellation_requested === 1, result: parse(row.result_json, null), receipt: parse(row.receipt_json, null), errorCode: row.error_code, errorMessage: row.error_message, attempts: row.attempts, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at } : null; }
function getJob(jobId) { ensureSchema(); return jobRow(dbStore.getDb().prepare("SELECT * FROM execution_node_jobs WHERE job_id = ?").get(jobId)); }
function claim(workerId, leaseMs = 120000) { ensureSchema(); const db = dbStore.getDb(); const leaseId = id("lease"); const expires = new Date(Date.now() + Math.min(30 * 60 * 1000, Math.max(1000, leaseMs))).toISOString(); const tx = db.transaction(() => { const row = db.prepare("SELECT * FROM execution_node_jobs WHERE worker_id = ? AND state = 'queued' AND cancellation_requested = 0 ORDER BY created_at LIMIT 1").get(workerId); if (!row) return null; db.prepare("UPDATE execution_node_jobs SET state='leased', lease_id=?, lease_expires_at=?, attempts=attempts+1, started_at=?, updated_at=? WHERE job_id=? AND state='queued' AND cancellation_requested=0").run(leaseId, expires, now(), now(), row.job_id); return db.prepare("SELECT * FROM execution_node_jobs WHERE job_id=?").get(row.job_id); }); return jobRow(tx()); }
function renew(jobId, workerId, leaseId, leaseMs = 120000) { ensureSchema(); const expires = new Date(Date.now() + Math.min(30 * 60 * 1000, Math.max(1000, leaseMs))).toISOString(); const changed = dbStore.getDb().prepare("UPDATE execution_node_jobs SET lease_expires_at=?, updated_at=? WHERE job_id=? AND worker_id=? AND lease_id=? AND state='leased' AND cancellation_requested=0").run(expires, now(), jobId, workerId, leaseId); if (changed.changes !== 1) throw new Error("job lease is no longer valid"); return getJob(jobId); }
function requestCancel(jobId) { ensureSchema(); const db = dbStore.getDb(); const row = db.prepare("SELECT state FROM execution_node_jobs WHERE job_id=?").get(jobId); if (!row) return null; const state = row.state === "queued" ? "cancelled" : row.state; const ts = now(); db.prepare("UPDATE execution_node_jobs SET cancellation_requested=1, state=?, completed_at=CASE WHEN ?='cancelled' THEN COALESCE(completed_at, ?) ELSE completed_at END, updated_at=? WHERE job_id=? AND state IN ('queued','leased')").run(state, state, ts, ts, jobId); return getJob(jobId); }
function cancellation(jobId, workerId, leaseId) { ensureSchema(); const row = dbStore.getDb().prepare("SELECT cancellation_requested, state FROM execution_node_jobs WHERE job_id=? AND worker_id=? AND lease_id=?").get(jobId, workerId, leaseId); return row ? { requested: row.cancellation_requested === 1, state: row.state } : null; }
function disconnect(workerId, reason = "node_disconnect") { ensureSchema(); const db = dbStore.getDb(); const ts = now(); db.prepare("UPDATE execution_node_jobs SET state='cancelled', cancellation_requested=1, error_code='node_disconnected', error_message=?, completed_at=COALESCE(completed_at, ?), updated_at=? WHERE worker_id=? AND state='leased'").run(String(reason).slice(0, 200), ts, ts, workerId); return computeWorkers.disconnectWorker(workerId, reason); }
function finish(jobId, workerId, leaseId, result, receipt) { ensureSchema(); const db = dbStore.getDb(); const job = db.prepare("SELECT * FROM execution_node_jobs WHERE job_id=? AND worker_id=? AND lease_id=? AND state='leased'").get(jobId, workerId, leaseId); if (!job || job.cancellation_requested) throw new Error("job lease is no longer valid"); const resultJson = json(result, null); const receiptJson = json(receipt, null); if (Buffer.byteLength(resultJson) > MAX_RESULT_BYTES || Buffer.byteLength(receiptJson) > 64 * 1024) throw new Error("node result exceeds the size bound"); const parsedReceipt = parse(receiptJson, null); if (!parsedReceipt || parsedReceipt.jobId !== jobId || parsedReceipt.tool !== job.tool_name || parsedReceipt.descriptorVersion !== job.descriptor_version || parsedReceipt.descriptorIdentity !== job.descriptor_identity) throw new Error("node receipt does not match the leased job"); const changed = db.prepare("UPDATE execution_node_jobs SET state='completed', result_json=?, receipt_json=?, completed_at=?, updated_at=? WHERE job_id=? AND worker_id=? AND lease_id=? AND state='leased' AND cancellation_requested=0").run(resultJson, receiptJson, now(), now(), jobId, workerId, leaseId); if (changed.changes !== 1) throw new Error("job lease is no longer valid"); return getJob(jobId); }
function fail(jobId, workerId, leaseId, code, message) { ensureSchema(); const db = dbStore.getDb(); const normalizedCode = String(code); const state = normalizedCode.includes("cancel") || normalizedCode === "node_execution_timeout" ? "cancelled" : "failed"; const changed = db.prepare("UPDATE execution_node_jobs SET state=?, error_code=?, error_message=?, completed_at=?, updated_at=? WHERE job_id=? AND worker_id=? AND lease_id=? AND state='leased'").run(state, normalizedCode.slice(0, 120), String(message).slice(0, 1000), now(), now(), jobId, workerId, leaseId); if (changed.changes !== 1) throw new Error("job lease is no longer valid"); return getJob(jobId); }
function recoverExpired() { ensureSchema(); const db = dbStore.getDb(); const ts = now(); const cancelled = db.prepare("UPDATE execution_node_jobs SET state='cancelled', completed_at=COALESCE(completed_at, ?), updated_at=? WHERE state='leased' AND cancellation_requested=1 AND lease_expires_at < ?").run(ts, ts, ts).changes; const queued = db.prepare("UPDATE execution_node_jobs SET state='queued', lease_id=NULL, lease_expires_at=NULL, updated_at=? WHERE state='leased' AND cancellation_requested=0 AND lease_expires_at < ?").run(ts, ts, ts).changes; return cancelled + queued; }

module.exports = { ensureSchema, register, get, list, setWorkspace, authorizeWorkspace, getWorkspace, listWorkspaces, replaceRepositories, enqueue, getJob, claim, renew, requestCancel, cancellation, disconnect, finish, fail, recoverExpired };
