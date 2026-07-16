const crypto = require("crypto");
const dbStore = require("../db");
const { WORKER_STATES, EnrollmentError, WorkerRevokedError } = require("./errors");

function nowIso() { return new Date().toISOString(); }
function generateId(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`; }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function json(value) { return JSON.stringify(value || {}); }
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function generateSecret() { return "wksec_" + crypto.randomBytes(32).toString("base64url"); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function ensureSchema() {
  const db = dbStore.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_workers (
      worker_id TEXT PRIMARY KEY,
      node_id TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      architecture TEXT,
      cpu_info TEXT,
      memory_bytes INTEGER,
      accelerators_json TEXT NOT NULL DEFAULT '[]',
      providers_json TEXT NOT NULL DEFAULT '[]',
      executors_json TEXT NOT NULL DEFAULT '[]',
      model_inventory_json TEXT NOT NULL DEFAULT '[]',
      limits_json TEXT NOT NULL DEFAULT '{}',
      health_json TEXT NOT NULL DEFAULT '{}',
      last_health_check TEXT,
      worker_version TEXT,
      trust_level TEXT NOT NULL DEFAULT 'trusted',
      state TEXT NOT NULL DEFAULT 'offline',
      current_jobs INTEGER NOT NULL DEFAULT 0,
      max_concurrent_jobs INTEGER NOT NULL DEFAULT 1,
      utilization_json TEXT NOT NULL DEFAULT '{}',
      last_heartbeat TEXT,
      heartbeat_interval_ms INTEGER NOT NULL DEFAULT 30000,
      maintenance_mode INTEGER NOT NULL DEFAULT 0,
      revocation_reason TEXT,
      revoked_at TEXT,
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      enrollment_token_hash TEXT,
      credential_hash TEXT,
      credential_rotated_at TEXT,
      public_key TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compute_workers_node ON compute_workers(node_id);
    CREATE INDEX IF NOT EXISTS idx_compute_workers_state ON compute_workers(state);
    CREATE INDEX IF NOT EXISTS idx_compute_workers_platform ON compute_workers(platform);
    CREATE INDEX IF NOT EXISTS idx_compute_workers_trust ON compute_workers(trust_level);

    CREATE TABLE IF NOT EXISTS compute_enrollment_tokens (
      token_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      display_name TEXT,
      trust_level TEXT NOT NULL DEFAULT 'trusted',
      allowed_data_classifications_json TEXT NOT NULL DEFAULT '["public","internal","private"]',
      max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_by_worker TEXT,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compute_enrollment_hash ON compute_enrollment_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_compute_enrollment_expires ON compute_enrollment_tokens(expires_at);
  `);
  ensureColumn("compute_workers", "credential_hash", "TEXT");
  ensureColumn("compute_workers", "credential_rotated_at", "TEXT");
  ensureColumn("compute_workers", "protocol_version", "TEXT NOT NULL DEFAULT '1'");
  ensureColumn("compute_workers", "model_inventory_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("compute_workers", "limits_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("compute_workers", "health_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("compute_workers", "last_health_check", "TEXT");
}

function ensureColumn(table, column, definition) {
  const db = dbStore.getDb();
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function rowToWorker(row) {
  if (!row) return null;
  return {
    workerId: row.worker_id,
    nodeId: row.node_id,
    displayName: row.display_name,
    platform: row.platform,
    architecture: row.architecture,
    cpuInfo: row.cpu_info,
    memoryBytes: row.memory_bytes,
    accelerators: parseJson(row.accelerators_json, []),
    providers: parseJson(row.providers_json, []),
    executors: parseJson(row.executors_json, []),
    modelInventory: parseJson(row.model_inventory_json, []),
    limits: parseJson(row.limits_json, {}),
    health: parseJson(row.health_json, {}),
    lastHealthCheck: row.last_health_check,
    workerVersion: row.worker_version,
    trustLevel: row.trust_level,
    state: row.state,
    currentJobs: row.current_jobs,
    maxConcurrentJobs: row.max_concurrent_jobs,
    utilization: parseJson(row.utilization_json, {}),
    lastHeartbeat: row.last_heartbeat,
    heartbeatIntervalMs: row.heartbeat_interval_ms,
    maintenanceMode: row.maintenance_mode === 1,
    revocationReason: row.revocation_reason,
    revokedAt: row.revoked_at,
    enrolledAt: row.enrolled_at,
    credentialRotatedAt: row.credential_rotated_at,
    protocolVersion: row.protocol_version || "1",
    hasPublicKey: !!row.public_key,
    hasCredential: !!row.credential_hash,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createEnrollmentToken({ displayName, trustLevel = "trusted", allowedDataClassifications = ["public", "internal", "private"], maxConcurrentJobs = 2, expiresInMs = 3600000, createdBy = "admin" }) {
  ensureSchema();
  const token = generateId("enroll") + crypto.randomBytes(16).toString("hex");
  const tokenHash = hashToken(token);
  const tokenId = generateId("etok");
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO compute_enrollment_tokens (token_id, token_hash, display_name, trust_level, allowed_data_classifications_json, max_concurrent_jobs, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tokenId, tokenHash, displayName || null, trustLevel, json(allowedDataClassifications), maxConcurrentJobs, expiresAt, createdBy);
  return { tokenId, token, expiresAt };
}

function consumeEnrollmentToken(token, workerId) {
  ensureSchema();
  const tokenHash = hashToken(token);
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_enrollment_tokens WHERE token_hash = ?").get(tokenHash);
  if (!row) throw new EnrollmentError("Invalid enrollment token");
  if (row.consumed_at) throw new EnrollmentError("Enrollment token already used");
  if (new Date(row.expires_at) < new Date()) throw new EnrollmentError("Enrollment token expired");
  db.prepare("UPDATE compute_enrollment_tokens SET consumed_at = ?, consumed_by_worker = ? WHERE token_id = ?")
    .run(nowIso(), workerId, row.token_id);
  return {
    tokenId: row.token_id,
    trustLevel: row.trust_level,
    allowedDataClassifications: parseJson(row.allowed_data_classifications_json, []),
    maxConcurrentJobs: row.max_concurrent_jobs,
  };
}

function enrollWorker({ nodeId, displayName, platform, architecture, cpuInfo, memoryBytes, accelerators, providers, executors, modelInventory, limits, health, workerVersion, publicKey, enrollmentToken, protocolVersion = "1" }) {
  ensureSchema();
  const tokenData = consumeEnrollmentToken(enrollmentToken, nodeId);
  const workerId = generateId("wk");
  const credential = generateSecret();
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO compute_workers (
      worker_id, node_id, display_name, platform, architecture, cpu_info,
      memory_bytes, accelerators_json, providers_json, executors_json,
      model_inventory_json, limits_json, health_json, last_health_check,
      worker_version, trust_level, state, max_concurrent_jobs, enrolled_at,
      enrollment_token_hash, credential_hash, credential_rotated_at, public_key, protocol_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workerId, nodeId, displayName, platform, architecture || null,
    cpuInfo || null, memoryBytes || 0, json(accelerators || []),
    json(providers || []), json(executors || []),
    json(modelInventory || []), json(limits || {}), json(health || {}), health ? nowIso() : null,
    workerVersion || null, tokenData.trustLevel,
    tokenData.maxConcurrentJobs, nowIso(),
    hashToken(enrollmentToken), hashToken(credential), nowIso(), publicKey || null, String(protocolVersion || "1")
  );
  const worker = getWorker(workerId);
  return { ...worker, worker, credential };
}

function authenticateWorker(workerId, credential) {
  ensureSchema();
  if (!workerId || !credential) return null;
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_workers WHERE worker_id = ?").get(workerId);
  if (!row || !row.credential_hash || row.state === "revoked") return null;
  if (!safeEqual(row.credential_hash, hashToken(credential))) return null;
  return rowToWorker(row);
}

function rotateCredential(workerId) {
  ensureSchema();
  const credential = generateSecret();
  const db = dbStore.getDb();
  const result = db.prepare("UPDATE compute_workers SET credential_hash = ?, credential_rotated_at = ?, updated_at = ? WHERE worker_id = ? AND state != 'revoked'")
    .run(hashToken(credential), nowIso(), nowIso(), workerId);
  if (result.changes !== 1) return null;
  const worker = getWorker(workerId);
  return { ...worker, worker, credential };
}

function getWorker(workerId) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_workers WHERE worker_id = ?").get(workerId);
  return rowToWorker(row);
}

function getWorkerByNodeId(nodeId) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_workers WHERE node_id = ?").get(nodeId);
  return rowToWorker(row);
}

function listWorkers({ state, platform, trustLevel } = {}) {
  ensureSchema();
  const db = dbStore.getDb();
  let sql = "SELECT * FROM compute_workers WHERE 1=1";
  const params = [];
  if (state) { sql += " AND state = ?"; params.push(state); }
  if (platform) { sql += " AND platform = ?"; params.push(platform); }
  if (trustLevel) { sql += " AND trust_level = ?"; params.push(trustLevel); }
  sql += " ORDER BY display_name";
  return db.prepare(sql).all(...params).map(rowToWorker);
}

function updateWorker(workerId, updates) {
  ensureSchema();
  const db = dbStore.getDb();
  const fields = [];
  const params = [];
  if (updates.displayName !== undefined) { fields.push("display_name = ?"); params.push(updates.displayName); }
  if (updates.state !== undefined) { fields.push("state = ?"); params.push(updates.state); }
  if (updates.trustLevel !== undefined) { fields.push("trust_level = ?"); params.push(updates.trustLevel); }
  if (updates.maintenanceMode !== undefined) { fields.push("maintenance_mode = ?"); params.push(updates.maintenanceMode ? 1 : 0); }
  if (updates.maxConcurrentJobs !== undefined) { fields.push("max_concurrent_jobs = ?"); params.push(updates.maxConcurrentJobs); }
  if (updates.accelerators !== undefined) { fields.push("accelerators_json = ?"); params.push(json(updates.accelerators)); }
  if (updates.providers !== undefined) { fields.push("providers_json = ?"); params.push(json(updates.providers)); }
  if (updates.executors !== undefined) { fields.push("executors_json = ?"); params.push(json(updates.executors)); }
  if (updates.modelInventory !== undefined) { fields.push("model_inventory_json = ?"); params.push(json(updates.modelInventory)); }
  if (updates.limits !== undefined) { fields.push("limits_json = ?"); params.push(json(updates.limits)); }
  if (updates.health !== undefined) { fields.push("health_json = ?"); params.push(json(updates.health)); fields.push("last_health_check = ?"); params.push(nowIso()); }
  if (updates.utilization !== undefined) { fields.push("utilization_json = ?"); params.push(json(updates.utilization)); }
  if (updates.workerVersion !== undefined) { fields.push("worker_version = ?"); params.push(updates.workerVersion); }
  if (fields.length === 0) return getWorker(workerId);
  fields.push("updated_at = ?");
  params.push(nowIso());
  params.push(workerId);
  db.prepare(`UPDATE compute_workers SET ${fields.join(", ")} WHERE worker_id = ?`).run(...params);
  return getWorker(workerId);
}

function heartbeat(workerId, { utilization, currentJobs }) {
  ensureSchema();
  const db = dbStore.getDb();
  const now = nowIso();
  const updates = { last_heartbeat: now, updated_at: now };
  if (utilization !== undefined) updates.utilization_json = json(utilization);
  if (currentJobs !== undefined) updates.current_jobs = currentJobs;
  const worker = getWorker(workerId);
  if (!worker) return null;
  if (worker.state === "revoked") throw new WorkerRevokedError(workerId);
  if (worker.state === "offline") updates.state = "online";
  const setClauses = Object.keys(updates).map(k => k + " = ?");
  const params = [...Object.values(updates), workerId];
  db.prepare(`UPDATE compute_workers SET ${setClauses.join(", ")} WHERE worker_id = ?`).run(...params);
  return getWorker(workerId);
}

function revokeWorker(workerId, reason = "admin_revoked") {
  ensureSchema();
  const db = dbStore.getDb();
  const now = nowIso();
  db.prepare("UPDATE compute_workers SET state = 'revoked', revocation_reason = ?, revoked_at = ?, updated_at = ? WHERE worker_id = ?")
    .run(reason, now, now, workerId);
  return getWorker(workerId);
}

function checkWorkersOffline(timeoutMs = 90000) {
  ensureSchema();
  const db = dbStore.getDb();
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const offline = db.prepare(
    "SELECT worker_id FROM compute_workers WHERE state IN ('online', 'degraded') AND last_heartbeat < ?"
  ).all(cutoff);
  for (const { worker_id } of offline) {
    db.prepare("UPDATE compute_workers SET state = 'offline', updated_at = ? WHERE worker_id = ?")
      .run(nowIso(), worker_id);
  }
  return offline.map(w => w.worker_id);
}

function getWorkerStats() {
  ensureSchema();
  const db = dbStore.getDb();
  const byState = db.prepare("SELECT state, COUNT(*) as count FROM compute_workers GROUP BY state").all();
  const byPlatform = db.prepare("SELECT platform, COUNT(*) as count FROM compute_workers GROUP BY platform").all();
  const total = db.prepare("SELECT COUNT(*) as count FROM compute_workers").get();
  return {
    total: total?.count || 0,
    byState: Object.fromEntries(byState.map(s => [s.state, s.count])),
    byPlatform: Object.fromEntries(byPlatform.map(p => [p.platform, p.count])),
  };
}

module.exports = {
  ensureSchema,
  createEnrollmentToken,
  consumeEnrollmentToken,
  enrollWorker,
  authenticateWorker,
  rotateCredential,
  getWorker,
  getWorkerByNodeId,
  listWorkers,
  updateWorker,
  heartbeat,
  revokeWorker,
  checkWorkersOffline,
  getWorkerStats,
  rowToWorker,
};
