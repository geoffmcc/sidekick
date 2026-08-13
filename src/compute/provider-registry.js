const crypto = require("crypto");
const dbStore = require("../db");
const { CIRCUIT_STATES, PROVIDER_HEALTH_STATES, DataClassificationError } = require("./errors");

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function json(value) { return JSON.stringify(value || {}); }

function ensureSchema() {
  const db = dbStore.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_providers (
      provider_id TEXT PRIMARY KEY,
      provider_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      endpoint TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'private',
      auth_secret_key TEXT,
      tls_policy TEXT NOT NULL DEFAULT 'prefer',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      health_status TEXT NOT NULL DEFAULT 'unknown',
      health_last_check TEXT,
      health_last_success TEXT,
      health_last_error TEXT,
      health_failure_count INTEGER NOT NULL DEFAULT 0,
      health_circuit_state TEXT NOT NULL DEFAULT 'closed',
      health_circuit_opened_at TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      cost_policy TEXT NOT NULL DEFAULT 'free',
      data_classifications_json TEXT NOT NULL DEFAULT '["public","internal","private"]',
      mode TEXT NOT NULL DEFAULT 'direct',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compute_providers_type ON compute_providers(provider_type);
    CREATE INDEX IF NOT EXISTS idx_compute_providers_enabled ON compute_providers(enabled);
    CREATE INDEX IF NOT EXISTS idx_compute_providers_health ON compute_providers(health_status);
    CREATE INDEX IF NOT EXISTS idx_compute_providers_mode ON compute_providers(mode);
  `);
}

function rowToProvider(row) {
  if (!row) return null;
  return {
    providerId: row.provider_id,
    providerType: row.provider_type,
    displayName: row.display_name,
    endpoint: row.endpoint,
    enabled: row.enabled === 1,
    trustLevel: row.trust_level,
    hasAuth: !!row.auth_secret_key,
    tlsPolicy: row.tls_policy,
    capabilities: parseJson(row.capabilities_json, []),
    health: {
      status: row.health_status,
      lastCheck: row.health_last_check,
      lastSuccess: row.health_last_success,
      lastError: row.health_last_error,
      failureCount: row.health_failure_count,
      circuitState: row.health_circuit_state,
      circuitOpenedAt: row.health_circuit_opened_at,
    },
    priority: row.priority,
    costPolicy: row.cost_policy,
    dataClassifications: parseJson(row.data_classifications_json, []),
    mode: row.mode,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createProvider({
  providerType, displayName, endpoint, enabled = true,
  trustLevel = "private", authSecretKey = null, tlsPolicy = "prefer",
  capabilities = [], priority = 50, costPolicy = "free",
  dataClassifications = ["public", "internal", "private"],
  mode = "direct", metadata = {},
}) {
  ensureSchema();
  const providerId = generateId("prov");
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO compute_providers (
      provider_id, provider_type, display_name, endpoint, enabled, trust_level,
      auth_secret_key, tls_policy, capabilities_json, priority, cost_policy,
      data_classifications_json, mode, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    providerId, providerType, displayName, endpoint || null,
    enabled ? 1 : 0, trustLevel, authSecretKey, tlsPolicy,
    json(capabilities), priority, costPolicy,
    json(dataClassifications), mode, json(metadata)
  );
  return getProvider(providerId);
}

function getProvider(providerId) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_providers WHERE provider_id = ?").get(providerId);
  return rowToProvider(row);
}

function listProviders({ enabled, providerType, mode, healthStatus } = {}) {
  ensureSchema();
  const db = dbStore.getDb();
  let sql = "SELECT * FROM compute_providers WHERE 1=1";
  const params = [];
  if (enabled !== undefined) { sql += " AND enabled = ?"; params.push(enabled ? 1 : 0); }
  if (providerType) { sql += " AND provider_type = ?"; params.push(providerType); }
  if (mode) { sql += " AND mode = ?"; params.push(mode); }
  if (healthStatus) { sql += " AND health_status = ?"; params.push(healthStatus); }
  sql += " ORDER BY priority DESC, display_name";
  return db.prepare(sql).all(...params).map(rowToProvider);
}

function updateProvider(providerId, updates) {
  ensureSchema();
  const db = dbStore.getDb();
  const existing = db.prepare("SELECT * FROM compute_providers WHERE provider_id = ?").get(providerId);
  if (!existing) return null;

  const fields = [];
  const params = [];
  if (updates.displayName !== undefined) { fields.push("display_name = ?"); params.push(updates.displayName); }
  if (updates.endpoint !== undefined) { fields.push("endpoint = ?"); params.push(updates.endpoint); }
  if (updates.enabled !== undefined) { fields.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }
  if (updates.trustLevel !== undefined) { fields.push("trust_level = ?"); params.push(updates.trustLevel); }
  if (updates.authSecretKey !== undefined) { fields.push("auth_secret_key = ?"); params.push(updates.authSecretKey); }
  if (updates.tlsPolicy !== undefined) { fields.push("tls_policy = ?"); params.push(updates.tlsPolicy); }
  if (updates.capabilities !== undefined) { fields.push("capabilities_json = ?"); params.push(json(updates.capabilities)); }
  if (updates.priority !== undefined) { fields.push("priority = ?"); params.push(updates.priority); }
  if (updates.costPolicy !== undefined) { fields.push("cost_policy = ?"); params.push(updates.costPolicy); }
  if (updates.dataClassifications !== undefined) { fields.push("data_classifications_json = ?"); params.push(json(updates.dataClassifications)); }
  if (updates.mode !== undefined) { fields.push("mode = ?"); params.push(updates.mode); }
  if (updates.metadata !== undefined) { fields.push("metadata_json = ?"); params.push(json(updates.metadata)); }

  if (fields.length === 0) return getProvider(providerId);
  fields.push("updated_at = ?");
  params.push(nowIso());
  params.push(providerId);
  db.prepare(`UPDATE compute_providers SET ${fields.join(", ")} WHERE provider_id = ?`).run(...params);
  return getProvider(providerId);
}

function deleteProvider(providerId) {
  ensureSchema();
  const db = dbStore.getDb();
  const result = db.prepare("DELETE FROM compute_providers WHERE provider_id = ?").run(providerId);
  return result.changes > 0;
}

function updateHealth(providerId, { status, error, success }) {
  ensureSchema();
  const db = dbStore.getDb();
  const now = nowIso();
  const existing = db.prepare("SELECT * FROM compute_providers WHERE provider_id = ?").get(providerId);
  if (!existing) return null;

  let failureCount = existing.health_failure_count;
  let circuitState = existing.health_circuit_state;
  let circuitOpenedAt = existing.health_circuit_opened_at;

  if (status === "healthy") {
    failureCount = 0;
    circuitState = CIRCUIT_STATES.CLOSED;
    circuitOpenedAt = null;
  } else {
    failureCount++;
    if (failureCount >= 5 && circuitState === CIRCUIT_STATES.CLOSED) {
      circuitState = CIRCUIT_STATES.OPEN;
      circuitOpenedAt = now;
    }
  }

  db.prepare(`
    UPDATE compute_providers SET
      health_status = ?, health_last_check = ?, health_last_success = ?,
      health_last_error = ?, health_failure_count = ?,
      health_circuit_state = ?, health_circuit_opened_at = ?, updated_at = ?
    WHERE provider_id = ?
  `).run(
    status, now, success ? now : existing.health_last_success,
    error || existing.health_last_error, failureCount,
    circuitState, circuitOpenedAt, now, providerId
  );
  return getProvider(providerId);
}

function checkCircuit(providerId) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT health_circuit_state, health_circuit_opened_at FROM compute_providers WHERE provider_id = ?").get(providerId);
  if (!row) return null;
  if (row.health_circuit_state === CIRCUIT_STATES.OPEN) {
    const openedAt = new Date(row.health_circuit_opened_at).getTime();
    if (Date.now() - openedAt > 60000) {
      updateHealth(providerId, { status: "healthy" });
      return CIRCUIT_STATES.HALF_OPEN;
    }
    return CIRCUIT_STATES.OPEN;
  }
  return row.health_circuit_state;
}

/**
 * Ages every open circuit that has served its cooldown into half-open, so a
 * provider excluded by transient failures becomes eligible again.
 *
 * This exists because the exclusion is self-sustaining: placement refuses to
 * route to an open circuit, so no request can ever record the success that
 * would close it. `checkCircuit` implements the cooldown but had no caller;
 * the compute reconciliation pass now drives it.
 *
 * Returns the provider ids that were reopened for testing.
 */
function recoverOpenCircuits() {
  ensureSchema();
  const db = dbStore.getDb();
  const rows = db.prepare(
    "SELECT provider_id FROM compute_providers WHERE health_circuit_state = ? AND enabled = 1"
  ).all(CIRCUIT_STATES.OPEN);
  const reopened = [];
  for (const row of rows) {
    if (checkCircuit(row.provider_id) === CIRCUIT_STATES.HALF_OPEN) reopened.push(row.provider_id);
  }
  return reopened;
}

// Return the raw credential reference stored on a provider (the NAME of a
// secret in the encrypted store), or null. Deliberately NOT part of
// rowToProvider: the provider object exposes only `hasAuth` so the reference
// never leaks into API responses, logs, or the dashboard. The single consumer
// is provider-credentials.resolveProviderApiKey at inference dispatch.
function getAuthSecretRef(providerId) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT auth_secret_key FROM compute_providers WHERE provider_id = ?").get(providerId);
  return row ? (row.auth_secret_key || null) : null;
}

function canReceiveDataClassification(providerId, dataClassification) {
  const provider = getProvider(providerId);
  if (!provider) return false;
  if (!provider.enabled) return false;
  return provider.dataClassifications.includes(dataClassification);
}

module.exports = {
  ensureSchema,
  createProvider,
  getProvider,
  listProviders,
  updateProvider,
  deleteProvider,
  updateHealth,
  checkCircuit,
  recoverOpenCircuits,
  canReceiveDataClassification,
  getAuthSecretRef,
  rowToProvider,
};
