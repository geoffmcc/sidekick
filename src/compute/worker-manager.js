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
  // Multi-dimensional state columns (Phase 1)
  ensureColumn("compute_workers", "connection_state", "TEXT NOT NULL DEFAULT 'offline'");
  ensureColumn("compute_workers", "admin_state", "TEXT NOT NULL DEFAULT 'enabled'");
  ensureColumn("compute_workers", "credential_state", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn("compute_workers", "health_state", "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn("compute_workers", "disconnected_at", "TEXT");
  ensureColumn("compute_workers", "last_disconnect_reason", "TEXT");
  // Placement v1: the enrollment token's data-classification scope becomes a
  // persisted, enforced worker attribute instead of being silently discarded.
  // Existing workers default to the historical implicit scope.
  ensureColumn("compute_workers", "allowed_data_classifications_json", "TEXT NOT NULL DEFAULT '[\"public\",\"internal\",\"private\"]'");
  // Re-enrollment tracking (Phase 4)
  ensureColumn("compute_enrollment_tokens", "re_enrollment_of", "TEXT");
  ensureColumn("compute_enrollment_tokens", "replaced_worker_id", "TEXT");
  // Backfill from existing state column for legacy workers
  backfillNewStateColumns();
}

function ensureColumn(table, column, definition) {
  const db = dbStore.getDb();
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillNewStateColumns() {
  const db = dbStore.getDb();
  try {
    // Only backfill rows where the new columns have default values (not yet set)
    db.exec(`
      UPDATE compute_workers SET
        connection_state = CASE WHEN state = 'online' THEN 'online' ELSE 'offline' END,
        admin_state = CASE
          WHEN state = 'maintenance' THEN 'maintenance'
          WHEN state = 'draining' THEN 'draining'
          ELSE 'enabled' END,
        credential_state = CASE WHEN state = 'revoked' THEN 'revoked' ELSE 'active' END,
        health_state = CASE WHEN state = 'degraded' THEN 'degraded' ELSE 'unknown' END
      WHERE connection_state = 'offline' AND admin_state = 'enabled' AND credential_state = 'active'
    `);
  } catch {}
}

function deriveLegacyState(connectionState, adminState, credentialState) {
  if (credentialState === "revoked") return "revoked";
  if (adminState === "maintenance") return "maintenance";
  if (adminState === "draining") return "draining";
  if (connectionState === "online") return "online";
  return "offline";
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
    allowedDataClassifications: parseJson(row.allowed_data_classifications_json, ["public", "internal", "private"]),
    state: row.state,
    connectionState: row.connection_state || "offline",
    adminState: row.admin_state || "enabled",
    credentialState: row.credential_state || "active",
    healthState: row.health_state || "unknown",
    disconnectedAt: row.disconnected_at,
    lastDisconnectReason: row.last_disconnect_reason,
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

function createEnrollmentToken({ displayName, trustLevel = "trusted", allowedDataClassifications = ["public", "internal", "private"], maxConcurrentJobs = 2, expiresInMs = 3600000, createdBy = "admin", reEnrollmentOf = null }) {
  ensureSchema();
  const token = generateId("enroll") + crypto.randomBytes(16).toString("hex");
  const tokenHash = hashToken(token);
  const tokenId = generateId("etok");
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO compute_enrollment_tokens (token_id, token_hash, display_name, trust_level, allowed_data_classifications_json, max_concurrent_jobs, expires_at, created_by, re_enrollment_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tokenId, tokenHash, displayName || null, trustLevel, json(allowedDataClassifications), maxConcurrentJobs, expiresAt, createdBy, reEnrollmentOf || null);
  return { tokenId, token, expiresAt, reEnrollmentOf: reEnrollmentOf || null };
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
    reEnrollmentOf: row.re_enrollment_of || null,
  };
}

function enrollWorker({ nodeId, displayName, platform, architecture, cpuInfo, memoryBytes, accelerators, providers, executors, modelInventory, limits, health, workerVersion, publicKey, enrollmentToken, protocolVersion = "1" }) {
  ensureSchema();
  const tokenData = consumeEnrollmentToken(enrollmentToken, nodeId);
  const credential = generateSecret();
  const db = dbStore.getDb();
  const existing = getWorkerByNodeId(nodeId);
  if (existing) {
    // Re-enrollment (credential recovery). Only permitted when the token was
    // scoped to this node, or the node is already revoked/retired — otherwise an
    // active node cannot be silently taken over. Reuses the worker identity and
    // issues a fresh credential (un-revoking the record).
    const authorized = tokenData.reEnrollmentOf && tokenData.reEnrollmentOf === nodeId;
    if (!authorized && existing.credentialState !== "revoked") {
      throw new EnrollmentError(`Node ${nodeId} is already enrolled; issue a re-enrollment token for this node to replace it`);
    }
    const now = nowIso();
    db.prepare(`
      UPDATE compute_workers SET
        display_name = ?, platform = ?, architecture = ?, cpu_info = ?, memory_bytes = ?,
        accelerators_json = ?, providers_json = ?, executors_json = ?, model_inventory_json = ?,
        limits_json = ?, health_json = ?, last_health_check = ?, worker_version = ?,
        trust_level = ?, allowed_data_classifications_json = ?, max_concurrent_jobs = ?, protocol_version = ?,
        credential_hash = ?, credential_state = 'active', credential_rotated_at = ?,
        state = 'online', connection_state = 'online', revocation_reason = NULL, revoked_at = NULL,
        enrollment_token_hash = ?, public_key = ?, updated_at = ?
      WHERE worker_id = ?
    `).run(
      displayName, platform, architecture || null, cpuInfo || null, memoryBytes || 0,
      json(accelerators || []), json(providers || []), json(executors || []), json(modelInventory || []),
      json(limits || {}), json(health || {}), health ? now : null, workerVersion || null,
      tokenData.trustLevel, json(tokenData.allowedDataClassifications || []), tokenData.maxConcurrentJobs, String(protocolVersion || "1"),
      hashToken(credential), now, hashToken(enrollmentToken), publicKey || null, now, existing.workerId
    );
    db.prepare("UPDATE compute_enrollment_tokens SET replaced_worker_id = ? WHERE token_id = ?").run(existing.workerId, tokenData.tokenId);
    const worker = getWorker(existing.workerId);
    return { ...worker, worker, credential, reEnrolled: true, replacedWorkerId: existing.workerId };
  }
  const workerId = generateId("wk");
  db.prepare(`
    INSERT INTO compute_workers (
      worker_id, node_id, display_name, platform, architecture, cpu_info,
      memory_bytes, accelerators_json, providers_json, executors_json,
      model_inventory_json, limits_json, health_json, last_health_check,
      worker_version, trust_level, allowed_data_classifications_json, state, max_concurrent_jobs, enrolled_at,
      enrollment_token_hash, credential_hash, credential_rotated_at, public_key, protocol_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workerId, nodeId, displayName, platform, architecture || null,
    cpuInfo || null, memoryBytes || 0, json(accelerators || []),
    json(providers || []), json(executors || []),
    json(modelInventory || []), json(limits || {}), json(health || {}), health ? nowIso() : null,
    workerVersion || null, tokenData.trustLevel, json(tokenData.allowedDataClassifications || []),
    tokenData.maxConcurrentJobs, nowIso(),
    hashToken(enrollmentToken), hashToken(credential), nowIso(), publicKey || null, String(protocolVersion || "1")
  );
  const worker = getWorker(workerId);
  return { ...worker, worker, credential, reEnrolled: false };
}

function authenticateWorker(workerId, credential) {
  ensureSchema();
  if (!workerId || !credential) return null;
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_workers WHERE worker_id = ?").get(workerId);
  if (!row || !row.credential_hash) return null;
  if (row.state === "revoked" || row.credential_state === "revoked") return null;
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
  const current = getWorker(workerId);
  if (!current) return null;
  const fields = [];
  const params = [];
  if (updates.displayName !== undefined) { fields.push("display_name = ?"); params.push(updates.displayName); }
  if (updates.trustLevel !== undefined) { fields.push("trust_level = ?"); params.push(updates.trustLevel); }

  // Multi-dimensional lifecycle state. Admin action arrives either as an
  // explicit adminState or as the legacy maintenanceMode flag; either way we
  // keep admin_state, maintenance_mode, and the derived legacy state coherent so
  // a later heartbeat cannot silently resurrect an administratively parked worker.
  let connectionState = current.connectionState;
  let adminState = current.adminState;
  let credentialState = current.credentialState;
  let dimsChanged = false;
  if (updates.connectionState !== undefined) { connectionState = updates.connectionState; fields.push("connection_state = ?"); params.push(connectionState); dimsChanged = true; }
  if (updates.adminState !== undefined) {
    adminState = updates.adminState;
  } else if (updates.maintenanceMode !== undefined) {
    adminState = updates.maintenanceMode ? "maintenance" : "enabled";
  }
  if (adminState !== current.adminState || updates.adminState !== undefined || updates.maintenanceMode !== undefined) {
    fields.push("admin_state = ?"); params.push(adminState); dimsChanged = true;
    fields.push("maintenance_mode = ?"); params.push(adminState === "maintenance" ? 1 : 0);
  }
  if (updates.credentialState !== undefined) { credentialState = updates.credentialState; fields.push("credential_state = ?"); params.push(credentialState); dimsChanged = true; }
  if (updates.healthState !== undefined) { fields.push("health_state = ?"); params.push(updates.healthState); }

  // Legacy state: an explicit value wins (back-compat); otherwise derive it from
  // the resulting dimensions whenever any dimension changed.
  if (updates.state !== undefined) { fields.push("state = ?"); params.push(updates.state); }
  else if (dimsChanged) { fields.push("state = ?"); params.push(deriveLegacyState(connectionState, adminState, credentialState)); }

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
  if (worker.credentialState === "revoked") throw new WorkerRevokedError(workerId);
  if (worker.connectionState === "offline") {
    updates.connection_state = "online";
    updates.state = deriveLegacyState("online", worker.adminState, worker.credentialState);
  }
  const setClauses = Object.keys(updates).map(k => k + " = ?");
  const params = [...Object.values(updates), workerId];
  db.prepare(`UPDATE compute_workers SET ${setClauses.join(", ")} WHERE worker_id = ?`).run(...params);
  return getWorker(workerId);
}

function revokeWorker(workerId, reason = "admin_revoked") {
  ensureSchema();
  const db = dbStore.getDb();
  const now = nowIso();
  db.prepare("UPDATE compute_workers SET state = 'revoked', credential_state = 'revoked', revocation_reason = ?, revoked_at = ?, updated_at = ? WHERE worker_id = ?")
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

// Periodic connection reconciliation over the multi-dimensional state model.
// Any worker whose heartbeat has lapsed beyond thresholdMs is moved to
// connection_state = 'offline'. admin_state (maintenance/draining) is preserved
// so a parked worker stays parked, and revoked workers are never touched. The
// legacy `state` column is recomputed from the resulting dimensions.
function reconcileWorkerStates(thresholdMs = 90000) {
  ensureSchema();
  const db = dbStore.getDb();
  const now = nowIso();
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const stale = db.prepare(`
    SELECT worker_id, admin_state, credential_state FROM compute_workers
    WHERE connection_state = 'online'
      AND credential_state != 'revoked'
      AND (last_heartbeat IS NULL OR last_heartbeat < ?)
  `).all(cutoff);
  const update = db.prepare(`
    UPDATE compute_workers
    SET connection_state = 'offline', state = ?, disconnected_at = ?, last_disconnect_reason = 'missed_heartbeat', updated_at = ?
    WHERE worker_id = ?
  `);
  for (const row of stale) {
    const legacy = deriveLegacyState("offline", row.admin_state, row.credential_state);
    update.run(legacy, now, now, row.worker_id);
  }
  return stale.map(r => r.worker_id);
}

// Graceful, authenticated disconnect notification from a worker. Moves the
// worker to connection_state = 'offline' immediately without waiting for the
// heartbeat threshold. Preserves admin_state; a revoked worker is a terminal
// no-op. reason is bounded to keep it out of unbounded-storage territory.
function disconnectWorker(workerId, reason = "graceful") {
  ensureSchema();
  const db = dbStore.getDb();
  const worker = getWorker(workerId);
  if (!worker) return null;
  if (worker.credentialState === "revoked") return worker;
  const now = nowIso();
  const legacy = deriveLegacyState("offline", worker.adminState, worker.credentialState);
  db.prepare(`
    UPDATE compute_workers
    SET connection_state = 'offline', state = ?, disconnected_at = ?, last_disconnect_reason = ?, updated_at = ?
    WHERE worker_id = ?
  `).run(legacy, now, String(reason || "graceful").slice(0, 200), now, workerId);
  return getWorker(workerId);
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
  reconcileWorkerStates,
  disconnectWorker,
  deriveLegacyState,
  getWorkerStats,
  rowToWorker,
};
