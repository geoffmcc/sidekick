const crypto = require("crypto");
const dbStore = require("../db");

function nowIso() { return new Date().toISOString(); }
function generateId(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`; }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function json(value) { return JSON.stringify(value || {}); }

function ensureSchema() {
  const db = dbStore.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_models (
      model_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES compute_providers(provider_id) ON DELETE CASCADE,
      provider_model_name TEXT NOT NULL,
      display_name TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      context_limit INTEGER,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      supports_structured_output INTEGER NOT NULL DEFAULT 0,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      supports_embedding INTEGER NOT NULL DEFAULT 0,
      estimated_memory_bytes INTEGER,
      quantization TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      preferred_workloads_json TEXT NOT NULL DEFAULT '[]',
      deprecated INTEGER NOT NULL DEFAULT 0,
      deprecation_notice TEXT,
      benchmark_score REAL,
      benchmark_last_run TEXT,
      last_verified TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compute_models_provider ON compute_models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_compute_models_enabled ON compute_models(enabled);
    CREATE INDEX IF NOT EXISTS idx_compute_models_embedding ON compute_models(supports_embedding);
    CREATE INDEX IF NOT EXISTS idx_compute_models_vision ON compute_models(supports_vision);
  `);
}

function rowToModel(row) {
  if (!row) return null;
  return {
    modelId: row.model_id,
    providerId: row.provider_id,
    providerModelName: row.provider_model_name,
    displayName: row.display_name,
    capabilities: parseJson(row.capabilities_json, []),
    contextLimit: row.context_limit,
    supportsTools: row.supports_tools === 1,
    supportsStructuredOutput: row.supports_structured_output === 1,
    supportsVision: row.supports_vision === 1,
    supportsEmbedding: row.supports_embedding === 1,
    estimatedMemoryBytes: row.estimated_memory_bytes,
    quantization: row.quantization,
    enabled: row.enabled === 1,
    preferredWorkloads: parseJson(row.preferred_workloads_json, []),
    deprecated: row.deprecated === 1,
    deprecationNotice: row.deprecation_notice,
    benchmarkScore: row.benchmark_score,
    benchmarkLastRun: row.benchmark_last_run,
    lastVerified: row.last_verified,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createModel({
  providerId, providerModelName, displayName, capabilities = [],
  contextLimit, supportsTools = false, supportsStructuredOutput = false,
  supportsVision = false, supportsEmbedding = false,
  estimatedMemoryBytes, quantization, enabled = true,
  preferredWorkloads = [], deprecated = false, deprecationNotice,
  metadata = {},
}) {
  ensureSchema();
  const modelId = generateId("model");
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO compute_models (
      model_id, provider_id, provider_model_name, display_name, capabilities_json,
      context_limit, supports_tools, supports_structured_output, supports_vision,
      supports_embedding, estimated_memory_bytes, quantization, enabled,
      preferred_workloads_json, deprecated, deprecation_notice, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    modelId, providerId, providerModelName, displayName || providerModelName,
    json(capabilities), contextLimit || null, supportsTools ? 1 : 0,
    supportsStructuredOutput ? 1 : 0, supportsVision ? 1 : 0,
    supportsEmbedding ? 1 : 0, estimatedMemoryBytes || null, quantization || null,
    enabled ? 1 : 0, json(preferredWorkloads), deprecated ? 1 : 0,
    deprecationNotice || null, json(metadata)
  );
  return getModel(modelId);
}

function getModel(modelId) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_models WHERE model_id = ?").get(modelId);
  return rowToModel(row);
}

function getModelByProviderName(providerId, providerModelName) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM compute_models WHERE provider_id = ? AND provider_model_name = ?").get(providerId, providerModelName);
  return rowToModel(row);
}

function listModels({ providerId, enabled, supportsEmbedding, supportsVision, capability } = {}) {
  ensureSchema();
  const db = dbStore.getDb();
  let sql = "SELECT * FROM compute_models WHERE 1=1";
  const params = [];
  if (providerId) { sql += " AND provider_id = ?"; params.push(providerId); }
  if (enabled !== undefined) { sql += " AND enabled = ?"; params.push(enabled ? 1 : 0); }
  if (supportsEmbedding !== undefined) { sql += " AND supports_embedding = ?"; params.push(supportsEmbedding ? 1 : 0); }
  if (supportsVision !== undefined) { sql += " AND supports_vision = ?"; params.push(supportsVision ? 1 : 0); }
  sql += " ORDER BY display_name";
  const rows = db.prepare(sql).all(...params);
  let models = rows.map(rowToModel);
  if (capability) {
    models = models.filter(m => m.capabilities.includes(capability));
  }
  return models;
}

function updateModel(modelId, updates) {
  ensureSchema();
  const db = dbStore.getDb();
  const existing = db.prepare("SELECT * FROM compute_models WHERE model_id = ?").get(modelId);
  if (!existing) return null;

  const fields = [];
  const params = [];
  if (updates.displayName !== undefined) { fields.push("display_name = ?"); params.push(updates.displayName); }
  if (updates.capabilities !== undefined) { fields.push("capabilities_json = ?"); params.push(json(updates.capabilities)); }
  if (updates.contextLimit !== undefined) { fields.push("context_limit = ?"); params.push(updates.contextLimit); }
  if (updates.supportsTools !== undefined) { fields.push("supports_tools = ?"); params.push(updates.supportsTools ? 1 : 0); }
  if (updates.supportsStructuredOutput !== undefined) { fields.push("supports_structured_output = ?"); params.push(updates.supportsStructuredOutput ? 1 : 0); }
  if (updates.supportsVision !== undefined) { fields.push("supports_vision = ?"); params.push(updates.supportsVision ? 1 : 0); }
  if (updates.supportsEmbedding !== undefined) { fields.push("supports_embedding = ?"); params.push(updates.supportsEmbedding ? 1 : 0); }
  if (updates.estimatedMemoryBytes !== undefined) { fields.push("estimated_memory_bytes = ?"); params.push(updates.estimatedMemoryBytes); }
  if (updates.quantization !== undefined) { fields.push("quantization = ?"); params.push(updates.quantization); }
  if (updates.enabled !== undefined) { fields.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }
  if (updates.preferredWorkloads !== undefined) { fields.push("preferred_workloads_json = ?"); params.push(json(updates.preferredWorkloads)); }
  if (updates.deprecated !== undefined) { fields.push("deprecated = ?"); params.push(updates.deprecated ? 1 : 0); }
  if (updates.deprecationNotice !== undefined) { fields.push("deprecation_notice = ?"); params.push(updates.deprecationNotice); }
  if (updates.benchmarkScore !== undefined) { fields.push("benchmark_score = ?"); params.push(updates.benchmarkScore); }
  if (updates.benchmarkLastRun !== undefined) { fields.push("benchmark_last_run = ?"); params.push(updates.benchmarkLastRun); }
  if (updates.lastVerified !== undefined) { fields.push("last_verified = ?"); params.push(updates.lastVerified); }
  if (updates.metadata !== undefined) { fields.push("metadata_json = ?"); params.push(json(updates.metadata)); }

  if (fields.length === 0) return getModel(modelId);
  fields.push("updated_at = ?");
  params.push(nowIso());
  params.push(modelId);
  db.prepare(`UPDATE compute_models SET ${fields.join(", ")} WHERE model_id = ?`).run(...params);
  return getModel(modelId);
}

function deleteModel(modelId) {
  ensureSchema();
  const db = dbStore.getDb();
  const result = db.prepare("DELETE FROM compute_models WHERE model_id = ?").run(modelId);
  return result.changes > 0;
}

function findBestModelForRequest({ capability, contextLimit, requiresTools, requiresVision, requiresEmbedding, providerId, modelId, workloadClass }) {
  ensureSchema();
  let models = listModels({ enabled: true });
  if (providerId) models = models.filter(m => m.providerId === providerId);
  if (modelId) {
    const exact = models.find(m => m.modelId === modelId || m.providerModelName === modelId);
    if (exact) return exact;
  }
  if (capability) models = models.filter(m => m.capabilities.includes(capability));
  if (requiresTools) models = models.filter(m => m.supportsTools);
  if (requiresVision) models = models.filter(m => m.supportsVision);
  if (requiresEmbedding) models = models.filter(m => m.supportsEmbedding);
  if (contextLimit) models = models.filter(m => !m.contextLimit || m.contextLimit >= contextLimit);
  models = models.filter(m => !m.deprecated);
  if (workloadClass) {
    const preferred = models.filter(m => m.preferredWorkloads.includes(workloadClass));
    if (preferred.length > 0) models = preferred;
  }
  if (models.length === 0) return null;
  models.sort((a, b) => {
    const scoreA = (a.benchmarkScore || 50) + (a.contextLimit || 0) / 1000;
    const scoreB = (b.benchmarkScore || 50) + (b.contextLimit || 0) / 1000;
    return scoreB - scoreA;
  });
  return models[0];
}

module.exports = {
  ensureSchema,
  createModel,
  getModel,
  getModelByProviderName,
  listModels,
  updateModel,
  deleteModel,
  findBestModelForRequest,
  rowToModel,
};
