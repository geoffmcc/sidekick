const providerRegistry = require("./provider-registry");
const modelRegistry = require("./model-registry");
const workerManager = require("./worker-manager");
const jobManager = require("./job-manager");
const inferenceService = require("./inference-service");
const capabilityRouter = require("./capability-router");
const healthMonitor = require("./health-monitor");
const executorRegistry = require("./executor-registry");
const errors = require("./errors");

// Reconciliation cadence. Workers heartbeat every ~30s; three missed beats
// (90s) marks a connection stale. The timer is unref'd so it never keeps the
// process alive on its own.
const RECONCILE_INTERVAL_MS = 30000;
const MISSED_HEARTBEAT_MULTIPLIER = 3;
let reconcileTimer = null;

function startReconciliation() {
  if (reconcileTimer) return;
  const run = () => {
    try { workerManager.reconcileWorkerStates(RECONCILE_INTERVAL_MS * MISSED_HEARTBEAT_MULTIPLIER); }
    catch { /* best-effort; a failed pass is retried on the next tick */ }
  };
  run(); // immediate pass at startup to clear stale online state
  reconcileTimer = setInterval(run, RECONCILE_INTERVAL_MS);
  if (reconcileTimer.unref) reconcileTimer.unref();
}

function stopReconciliation() {
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
}

function initialize() {
  providerRegistry.ensureSchema();
  modelRegistry.ensureSchema();
  workerManager.ensureSchema();
  jobManager.ensureSchema();
  jobManager.recoverExpiredLeases();
  startReconciliation();
  try {
    const dbStore = require("../db");
    const db = dbStore.getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS compute_routing_rules (
        rule_id TEXT PRIMARY KEY,
        rule_name TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50,
        enabled INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        workload_class TEXT,
        capability_filter TEXT,
        provider_filter TEXT,
        model_filter TEXT,
        worker_filter TEXT,
        data_classification_filter TEXT,
        trust_level_min TEXT,
        preferred_provider_ids_json TEXT NOT NULL DEFAULT '[]',
        preferred_model_ids_json TEXT NOT NULL DEFAULT '[]',
        preferred_worker_ids_json TEXT NOT NULL DEFAULT '[]',
        fallback_provider_ids_json TEXT NOT NULL DEFAULT '[]',
        max_latency_ms INTEGER,
        require_vision INTEGER NOT NULL DEFAULT 0,
        require_tools INTEGER NOT NULL DEFAULT 0,
        require_embedding INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_compute_routing_workload ON compute_routing_rules(workload_class);
      CREATE INDEX IF NOT EXISTS idx_compute_routing_priority ON compute_routing_rules(priority DESC);

      CREATE TABLE IF NOT EXISTS compute_benchmarks (
        benchmark_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model_id TEXT,
        worker_id TEXT,
        benchmark_type TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        provider_availability REAL,
        model_load_time_ms INTEGER,
        first_token_latency_ms INTEGER,
        generation_tokens_per_sec REAL,
        embedding_tokens_per_sec REAL,
        peak_memory_bytes INTEGER,
        failure_rate REAL,
        cancellation_responsiveness_ms INTEGER,
        hardware_json TEXT NOT NULL DEFAULT '{}',
        model_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS compute_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_type TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        worker_id TEXT,
        job_id TEXT,
        value REAL NOT NULL,
        unit TEXT,
        tags_json TEXT NOT NULL DEFAULT '{}',
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_compute_metrics_type ON compute_metrics(metric_type);
      CREATE INDEX IF NOT EXISTS idx_compute_metrics_recorded ON compute_metrics(recorded_at);
    `);
  } catch {}
}

function overview() {
  const providers = providerRegistry.listProviders({ enabled: true });
  const healthyProviders = providers.filter(p => p.health.status === "healthy");
  const workers = workerManager.listWorkers();
  const onlineWorkers = workers.filter(w => w.state === "online" || w.state === "degraded");
  const jobStats = jobManager.getJobStats();
  const workerStats = workerManager.getWorkerStats();
  return {
    providers: {
      total: providers.length,
      healthy: healthyProviders.length,
    },
    workers: {
      total: workers.length,
      online: onlineWorkers.length,
      ...workerStats,
    },
    jobs: jobStats,
    routing: {
      rulesCount: getRoutingRules().length,
    },
    executors: executorRegistry.listExecutors().length,
  };
}

function getRoutingRules() {
  try {
    const dbStore = require("../db");
    const db = dbStore.getDb();
    const rows = db.prepare("SELECT * FROM compute_routing_rules ORDER BY priority DESC").all();
    return rows.map(r => ({
      ruleId: r.rule_id,
      ruleName: r.rule_name,
      priority: r.priority,
      enabled: r.enabled === 1,
      description: r.description,
      workloadClass: r.workload_class,
      capabilityFilter: r.capability_filter,
      dataClassificationFilter: r.data_classification_filter,
      trustLevelMin: r.trust_level_min,
      preferredProviders: JSON.parse(r.preferred_provider_ids_json || "[]"),
      preferredModels: JSON.parse(r.preferred_model_ids_json || "[]"),
      preferredWorkers: JSON.parse(r.preferred_worker_ids_json || "[]"),
      fallbackProviders: JSON.parse(r.fallback_provider_ids_json || "[]"),
      maxLatencyMs: r.max_latency_ms,
      requireVision: r.require_vision === 1,
      requireTools: r.require_tools === 1,
      requireEmbedding: r.require_embedding === 1,
    }));
  } catch { return []; }
}

function explainRouting(request) {
  const { provider, model, reason } = capabilityRouter.selectProvider(request);
  const fallbacks = capabilityRouter.selectWithFallback(request);
  return {
    selected: provider ? {
      providerId: provider.providerId,
      providerType: provider.providerType,
      displayName: provider.displayName,
      health: provider.health.status,
      trustLevel: provider.trustLevel,
    } : null,
    model: model ? {
      modelId: model.modelId,
      name: model.providerModelName,
      displayName: model.displayName,
      contextLimit: model.contextLimit,
    } : null,
    reason,
    fallbackCount: fallbacks.fallbacks?.length || 0,
  };
}

module.exports = {
  initialize,
  startReconciliation,
  stopReconciliation,
  overview,
  providerRegistry,
  modelRegistry,
  workerManager,
  jobManager,
  inferenceService,
  capabilityRouter,
  healthMonitor,
  executorRegistry,
  errors,
  getRoutingRules,
  explainRouting,
};
