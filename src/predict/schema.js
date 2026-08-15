const dbStore = require("../db");

const RULE_VERSION = "predict-v2";
const LEGACY_RULE_VERSION = "predict-v1";

let schemaReady = false;

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Creates the predict schema if absent and applies additive, idempotent evolution.
 *
 * This never drops or rewrites data. The v2 identity columns below are owned by
 * migration 037_runtime_schema_convergence.sql (the migration runner's
 * execMigrationSql applies ADD COLUMN idempotently, so a repeated ALTER is a
 * no-op in either boot order). The PRAGMA-guarded ensureColumn calls are kept
 * so this module remains boot-order independent — it must work against a
 * database the migrations have not touched yet.
 */
function ensureSchema(force) {
  if (schemaReady && !force) return;
  const db = dbStore.getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS predictions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      explanation TEXT NOT NULL,
      project TEXT,
      session_id TEXT,
      task_id TEXT,
      time_horizon TEXT NOT NULL DEFAULT 'open_ended',
      probability REAL NOT NULL DEFAULT 0.5,
      confidence TEXT NOT NULL DEFAULT 'low',
      score_breakdown_json TEXT NOT NULL DEFAULT '{}',
      recommended_action_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      fingerprint TEXT,
      rule_version TEXT NOT NULL DEFAULT '${LEGACY_RULE_VERSION}',
      observation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      outcome TEXT,
      outcome_at TEXT,
      legacy INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS prediction_evidence (
      id TEXT PRIMARY KEY,
      prediction_id TEXT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT,
      source_timestamp TEXT,
      summary TEXT NOT NULL,
      safe_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prediction_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prediction_id TEXT NOT NULL,
      feedback TEXT NOT NULL,
      project TEXT,
      rule_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prediction_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      prediction_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prediction_rules (
      rule_version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_predictions_type ON predictions(type);
    CREATE INDEX IF NOT EXISTS idx_predictions_project ON predictions(project);
    CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions(status);
    CREATE INDEX IF NOT EXISTS idx_predictions_fingerprint ON predictions(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_predictions_created ON predictions(created_at);
    CREATE INDEX IF NOT EXISTS idx_predictions_expires ON predictions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_predictions_session ON predictions(session_id);
    CREATE INDEX IF NOT EXISTS idx_pred_evidence_prediction ON prediction_evidence(prediction_id);
    CREATE INDEX IF NOT EXISTS idx_pred_evidence_source ON prediction_evidence(source_type);
    CREATE INDEX IF NOT EXISTS idx_pred_feedback_prediction ON prediction_feedback(prediction_id);
    CREATE INDEX IF NOT EXISTS idx_pred_feedback_project ON prediction_feedback(project);
    CREATE INDEX IF NOT EXISTS idx_pred_audit_type ON prediction_audit(event_type);
    CREATE INDEX IF NOT EXISTS idx_pred_audit_prediction ON prediction_audit(prediction_id);
  `);

  // Additive evolution for the v2 identity model.
  ensureColumn(db, "predictions", "identity_key", "TEXT");
  ensureColumn(db, "predictions", "last_seen_at", "TEXT");
  ensureColumn(db, "predictions", "refresh_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "predictions", "lifecycle_reason", "TEXT");
  ensureColumn(db, "prediction_feedback", "scope_key", "TEXT");

  db.exec(`CREATE INDEX IF NOT EXISTS idx_predictions_identity ON predictions(identity_key);`);

  /**
   * Database-level protection for the logical-identity invariant.
   *
   * Partial unique index: at most one *active* row per identity. Legacy v1 rows
   * have a NULL identity_key and SQLite treats NULLs as distinct, so this can be
   * created safely against existing data without a destructive backfill.
   */
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_predictions_active_identity
        ON predictions(identity_key)
        WHERE identity_key IS NOT NULL AND status = 'active' AND enabled = 1;
    `);
  } catch (e) {
    // Pre-existing duplicate active identities would block the index. Surface it
    // rather than silently losing the guarantee; application-level dedup still applies.
    console.error("[predict] could not create active-identity unique index:", e.message);
  }

  db.prepare(`
    INSERT OR IGNORE INTO prediction_rules (rule_version, name, description, enabled, config_json)
    VALUES (?, ?, ?, 1, '{}')
  `).run(RULE_VERSION, RULE_VERSION, "Predict v2 — scoped, evidence-gated detectors");

  schemaReady = true;
}

module.exports = { ensureSchema, RULE_VERSION, LEGACY_RULE_VERSION };
