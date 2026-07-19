/**
 * sidekick_predict — Evidence-backed prediction and decision-support engine.
 *
 * Predict turns Sidekick's structured operational telemetry into a *small* number
 * of defensible, actionable predictions. It is deliberately conservative: a record
 * that cannot be tied to correlated evidence within a legitimate execution boundary
 * is not a prediction and is never persisted.
 *
 * Deterministic implementation — no LLM dependency.
 * See docs/predict.md for the full contract, thresholds, and lifecycle rules.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dbStore = require("./db");
const { redactSensitive } = require("./redact");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const RULE_VERSION = "predict-v2";
const LEGACY_RULE_VERSION = "predict-v1";

// --- Confidence levels and thresholds ---

const CONFIDENCE_LEVELS = ["none", "low", "medium", "high", "very_high"];
const MIN_OBSERVATIONS_FOR_PREDICTION = 3;
const MIN_OBSERVATIONS_FOR_HIGH_CONFIDENCE = 15;
const MIN_OBSERVATIONS_FOR_VERY_HIGH_CONFIDENCE = 30;
const DEFAULT_EXPIRY_HOURS = 72;
const MAX_EVIDENCE_PER_PREDICTION = 20;
const MAX_PREDICTIONS_PER_ANALYZE = 50;
const MAX_ACTIVE_PREDICTIONS_SCANNED = 200;
const MAX_TOOL_LOGS_SCANNED = 500;

// --- Valid enums ---

const VALID_TYPES = [
  "next_action", "likely_failure", "missing_prerequisite",
  "relevant_context", "incident_recurrence", "workflow_opportunity",
  "stale_or_contradicted"
];
const VALID_STATUSES = ["active", "expired", "superseded", "dismissed", "confirmed", "did_not_occur"];
const TERMINAL_STATUSES = ["expired", "superseded", "dismissed", "confirmed", "did_not_occur"];
const VALID_FEEDBACK = ["useful", "not_useful", "incorrect", "already_known", "acted_on", "dismissed"];
const VALID_OUTCOMES = ["confirmed", "did_not_occur", "action_succeeded", "action_failed", "expired", "superseded", "unresolved"];
const VALID_TIME_HORIZONS = ["current_task", "current_session", "days_7", "days_30", "open_ended"];
const VALID_SCOPES = ["project", "session", "task", "global"];

/**
 * Expiration is derived from the prediction's time horizon, never from a single
 * global constant. `null` means "no time-based expiry" — open-ended predictions
 * are retired by contradiction or retention, not by an arbitrary clock.
 */
const HORIZON_EXPIRY_HOURS = {
  current_task: 4,
  current_session: 12,
  days_7: 24 * 7,
  days_30: 24 * 30,
  open_ended: null,
};

/**
 * Per-type admission requirements. These are the central quality gate: a candidate
 * that fails any check is counted in the rejection summary and never inserted.
 *
 * Rationale for the sequence/failure numbers is documented in docs/predict.md.
 * They are chosen from what deterministic telemetry can actually support, not
 * from what makes a given fixture pass.
 */
const ADMISSION = {
  next_action: { minEvidence: 1, minObservations: 3, minSessions: 2, minProbability: 0.35, minConfidence: "medium", requiresAction: true },
  likely_failure: { minEvidence: 2, minObservations: 3, minSessions: 2, minProbability: 0.35, minConfidence: "medium", requiresAction: true },
  missing_prerequisite: { minEvidence: 2, minObservations: 2, minSessions: 2, minProbability: 0.40, minConfidence: "low", requiresAction: true },
  relevant_context: { minEvidence: 1, minObservations: 1, minSessions: 1, minProbability: 0.50, minConfidence: "medium", requiresAction: false },
  incident_recurrence: { minEvidence: 2, minObservations: 2, minSessions: 1, minProbability: 0.40, minConfidence: "low", requiresAction: false },
  workflow_opportunity: { minEvidence: 1, minObservations: 3, minSessions: 2, minProbability: 0.40, minConfidence: "medium", requiresAction: true },
  stale_or_contradicted: { minEvidence: 1, minObservations: 1, minSessions: 1, minProbability: 0.50, minConfidence: "low", requiresAction: false },
};

// --- Failure detector thresholds ---
// A tool with a couple of failures among many successes is noise, not a prediction.
const MIN_FAILURE_ATTEMPTS = 5;      // need a meaningful denominator
const MIN_FAILURE_COUNT = 3;         // two failures is not a pattern
const MIN_FAILURE_RATE = 0.34;       // roughly one call in three must fail
const MIN_RECENT_FAILURES = 2;       // the pattern must still be live
const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

// --- Prerequisite detector thresholds ---
// `A requires B` demands repeated recovery evidence: A fails -> B succeeds -> A succeeds.
const MIN_PREREQ_RECOVERIES = 2;     // must be reproducible
const PREREQ_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const PREREQ_MAX_STEP_DISTANCE = 5;  // recovery must be nearby in the same segment

// --- Sequence construction ---
const DEFAULT_SEQUENCE_GAP_MINUTES = 30;

// Bounded well under SQLITE_MAX_VARIABLE_NUMBER for both modern and older builds.
const PURGE_CHUNK_SIZE = 200;

// Composite map keys are joined with NUL, which cannot appear in a tool name,
// project, error category or incident title.
const KEY_SEP = String.fromCharCode(0);

// --- Configuration ---

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Retention accepts 0 ("every terminal record is eligible"), so it cannot use
// envInt's strictly-positive rule.
function envNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function getConfig() {
  return {
    retention_days: envNonNegativeInt("SIDEKICK_PREDICT_RETENTION_DAYS", 90),
    sequence_gap_minutes: envInt("SIDEKICK_PREDICT_SEQUENCE_GAP_MINUTES", DEFAULT_SEQUENCE_GAP_MINUTES),
    // Disabled by default: Sidekick has no relevance signal that ties a stored
    // memory to the analysis target, and "recent" is not "relevant".
    enable_relevant_context: envBool("SIDEKICK_PREDICT_ENABLE_RELEVANT_CONTEXT", false),
    // How long a terminal identity suppresses recreation of the same logical prediction.
    identity_cooldown_days: envInt("SIDEKICK_PREDICT_IDENTITY_COOLDOWN_DAYS", 7),
  };
}

// --- Schema management ---

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
 * This never drops or rewrites data. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
 * column evolution is PRAGMA-guarded here rather than in a startup migration file:
 * a repeated ALTER in an auto-applied migration would throw on every boot.
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

// --- Utilities ---

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function jsonText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function clampLimit(value, defaultVal, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(Math.floor(n), max);
}

function hoursFromNow(hours) {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

/**
 * Resolves a retention period. Only a genuine non-negative finite number is
 * accepted: Number(null), Number(""), Number([]) and Number(false) are all 0,
 * and a negative value would move the cutoff into the future and match every
 * terminal record. Anything else falls back to the configured default.
 */
function resolveRetentionDays(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function isValidRetentionDays(value) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function confidenceRank(confidence) {
  const i = CONFIDENCE_LEVELS.indexOf(confidence);
  return i < 0 ? 0 : i;
}

/**
 * Legacy fingerprint. Retained so v1 rows remain addressable and so the
 * diagnostic report can detect historical duplicates.
 */
function makeFingerprint(type, subject, project) {
  const raw = [type, subject || "", project || ""].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Logical prediction identity.
 *
 * Two candidates are the same logical prediction when their rule version, type,
 * canonical relation, and scope match. This is what the lifecycle refreshes,
 * reactivates, or supersedes — instead of appending an equivalent row each run.
 */
function makeIdentityKey(parts) {
  const raw = [
    parts.rule_version || RULE_VERSION,
    parts.type || "",
    parts.relation || "",
    parts.project || "",
    parts.session_id || "",
    parts.task_id || "",
  ].join(KEY_SEP);
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// --- Scoring engine ---

function smoothScore(score, sampleSize, prior) {
  prior = prior || 0.5;
  const alpha = 2;
  const beta = 2;
  return (prior * alpha + score * sampleSize) / (alpha + beta + sampleSize);
}

function calculateBaseRate(matchCount, totalCount) {
  if (totalCount === 0) return 0;
  return matchCount / totalCount;
}

function applyProjectAdjustment(baseRate, sameProject) {
  if (sameProject) return Math.min(baseRate + 0.08, 1.0);
  return baseRate;
}

function applyRecencyAdjustment(baseRate, recentMatches, totalMatches) {
  if (totalMatches === 0) return baseRate;
  const recencyRatio = recentMatches / totalMatches;
  return Math.min(baseRate + recencyRatio * 0.06, 1.0);
}

function applyContradictionPenalty(baseRate, contradictionCount, totalMatches) {
  if (contradictionCount === 0) return baseRate;
  const penalty = (contradictionCount / Math.max(totalMatches, 1)) * 0.15;
  return Math.max(baseRate - penalty, 0.0);
}

function calculateConfidence(score, sampleSize) {
  if (sampleSize >= MIN_OBSERVATIONS_FOR_VERY_HIGH_CONFIDENCE && score >= 0.8) return "very_high";
  if (sampleSize >= MIN_OBSERVATIONS_FOR_HIGH_CONFIDENCE && score >= 0.7) return "high";
  if (sampleSize >= MIN_OBSERVATIONS_FOR_PREDICTION && score >= 0.4) return "medium";
  if (sampleSize >= 1) return "low";
  return "none";
}

function calculateScore(params) {
  let score = params.baseRate || 0;
  score = applyProjectAdjustment(score, params.sameProject);
  score = applyRecencyAdjustment(score, params.recentMatches || 0, params.totalMatches || 0);
  score = applyContradictionPenalty(score, params.contradictions || 0, params.totalMatches || 0);
  score = smoothScore(score, params.sampleSize || 0, 0.5);
  const confidence = params.confidence || calculateConfidence(score, params.sampleSize || 0);
  return {
    probability: Math.round(score * 1000) / 1000,
    confidence,
    breakdown: {
      base_rate: Math.round((params.baseRate || 0) * 1000) / 1000,
      same_project: !!params.sameProject,
      recent_matches: params.recentMatches || 0,
      total_matches: params.totalMatches || 0,
      contradictions: params.contradictions || 0,
      sample_size: params.sampleSize || 0,
      smoothed: Math.round(score * 1000) / 1000
    }
  };
}

// --- Tool-log normalization ---

/**
 * Maps a raw `tool_logs` row onto the shape the detectors consume.
 *
 * The table stores `success INTEGER`; it has no `ok` column. Reading `row.ok`
 * yields undefined, which previously made every call look like a failure and
 * silently disabled the sequence detectors that required a success.
 */
function normalizeToolLog(row) {
  return {
    id: row.id,
    tool_name: row.tool_name,
    ok: row.success === 1 || row.success === true,
    timestamp: row.timestamp,
    time: Date.parse(row.timestamp || "") || 0,
    project: row.project || null,
    session_id: row.session_id || null,
    task_id: row.task_id || null,
    correlation_id: row.correlation_id || null,
    error_category: row.error_category || null,
    arg_fingerprint: row.arg_fingerprint || null,
    result_summary: row.result_summary || row.summary || null,
  };
}

/**
 * Returns the durable correlation identifier for a tool log, or null when the
 * record cannot be placed in a trustworthy execution boundary.
 *
 * Unscoped records are never merged into a synthetic global session: doing so
 * fabricates adjacency between calls that never ran together.
 */
function boundaryId(log) {
  return log.session_id || log.correlation_id || log.task_id || null;
}

/**
 * Builds explicitly ordered, boundary-isolated sequences from tool logs.
 *
 * Guarantees:
 *  - each segment is sorted ascending by (timestamp, id) regardless of SQL order
 *  - records without a durable correlation id are skipped entirely
 *  - different sessions, tasks, correlations and projects are never stitched
 *  - a reused identifier is split when calls are separated by a large time gap
 */
function buildSequences(logs, options) {
  const gapMs = (options && options.gapMinutes ? options.gapMinutes : DEFAULT_SEQUENCE_GAP_MINUTES) * 60 * 1000;
  const groups = new Map();
  let skippedUnscoped = 0;

  for (const log of logs) {
    const boundary = boundaryId(log);
    if (!boundary) { skippedUnscoped++; continue; }
    // Project participates in the key so one identifier spanning projects
    // cannot merge cross-project activity into one sequence.
    const key = [log.project || "", boundary].join(KEY_SEP);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(log);
  }

  const segments = [];
  for (const [key, groupLogs] of groups) {
    // Explicit chronological sort — never rely on the query's incidental ordering.
    groupLogs.sort((a, b) => (a.time - b.time) || (a.id - b.id));

    let current = [];
    for (const log of groupLogs) {
      if (current.length > 0) {
        const gap = log.time - current[current.length - 1].time;
        if (gap > gapMs) {
          segments.push(makeSegment(key, current));
          current = [];
        }
      }
      current.push(log);
    }
    if (current.length > 0) segments.push(makeSegment(key, current));
  }

  return { segments, skippedUnscoped };
}

function makeSegment(key, logs) {
  const first = logs[0];
  return {
    key: [key, first.time].join(KEY_SEP),
    boundary: boundaryId(first),
    project: first.project || null,
    session_id: first.session_id || null,
    task_id: first.task_id || null,
    logs,
  };
}

// --- Scope resolution ---

/**
 * Resolves the analysis scope. A global (all-project) analysis must be selected
 * deliberately — it is never inferred from missing parameters.
 */
function resolveScope(options) {
  const opts = options || {};
  let mode = opts.scope || null;

  if (mode && !VALID_SCOPES.includes(mode)) {
    return { ok: false, error: `scope must be one of: ${VALID_SCOPES.join(", ")}` };
  }

  if (!mode) {
    if (opts.task_id) mode = "task";
    else if (opts.session_id) mode = "session";
    else if (opts.project) mode = "project";
    else {
      return {
        ok: false,
        error: "An analysis scope is required. Pass project, session_id or task_id, " +
          "or request scope='global' explicitly to analyze every project.",
      };
    }
  }

  if (mode === "project" && !opts.project) return { ok: false, error: "scope='project' requires a project" };
  if (mode === "session" && !opts.session_id) return { ok: false, error: "scope='session' requires a session_id" };
  if (mode === "task" && !opts.task_id) return { ok: false, error: "scope='task' requires a task_id" };

  return {
    ok: true,
    scope: {
      mode,
      project: mode === "global" ? null : (opts.project || null),
      session_id: mode === "session" || mode === "task" ? (opts.session_id || null) : null,
      task_id: mode === "task" ? (opts.task_id || null) : null,
      max_age: opts.maxAge || "7d",
    },
  };
}

// --- Context builder ---

function parseMaxAge(maxAge) {
  const d = new Date();
  if (typeof maxAge === "string" && maxAge.endsWith("h")) d.setHours(d.getHours() - parseInt(maxAge, 10));
  else if (typeof maxAge === "string" && maxAge.endsWith("d")) d.setDate(d.getDate() - parseInt(maxAge, 10));
  else d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function buildAnalysisContext(scope, config) {
  const db = dbStore.getDb();
  const since = parseMaxAge(scope.max_age);
  const errors = [];

  const ctx = {
    project: scope.project,
    session_id: scope.session_id,
    task_id: scope.task_id,
    scope,
    config,
    now: nowIso(),
    since,
    db,
    toolLogs: [],
    sequences: [],
    skippedUnscoped: 0,
    memories: [],
    handoffs: [],
    incidents: [],
    capabilities: [],
    activePredictions: [],
    feedbackHistory: [],
    errors,
  };

  // Bounded, redacted diagnostics: a query failure is recorded, not swallowed.
  const guarded = (name, fn) => {
    try { return fn(); } catch (e) {
      errors.push({ source: name, error: redactSensitive(String(e.message || e)).slice(0, 200) });
      return [];
    }
  };

  const where = ["timestamp > ?"];
  const params = [since];
  if (scope.project) { where.push("project = ?"); params.push(scope.project); }
  if (scope.session_id) { where.push("session_id = ?"); params.push(scope.session_id); }
  if (scope.task_id) { where.push("task_id = ?"); params.push(scope.task_id); }

  const rawLogs = guarded("tool_logs", () => db.prepare(
    `SELECT * FROM tool_logs WHERE ${where.join(" AND ")} ORDER BY timestamp DESC, id DESC LIMIT ${MAX_TOOL_LOGS_SCANNED}`
  ).all(...params));

  ctx.toolLogs = rawLogs.map(normalizeToolLog);
  const built = buildSequences(ctx.toolLogs, { gapMinutes: config.sequence_gap_minutes });
  ctx.sequences = built.segments;
  ctx.skippedUnscoped = built.skippedUnscoped;

  ctx.memories = guarded("memories", () => {
    const p = [since];
    let w = "updated_at > ?";
    if (scope.project) { w += " AND project = ?"; p.push(scope.project); }
    return db.prepare(
      `SELECT * FROM memories WHERE ${w} AND enabled = 1 AND state = 'active' ORDER BY updated_at DESC LIMIT 100`
    ).all(...p);
  });

  ctx.handoffs = guarded("memory_handoffs", () => {
    const p = [];
    let w = "1=1";
    if (scope.project) { w += " AND project = ?"; p.push(scope.project); }
    return db.prepare(`SELECT * FROM memory_handoffs WHERE ${w} ORDER BY updated_at DESC LIMIT 20`).all(...p);
  });

  ctx.incidents = guarded("blackbox_incidents", () => {
    const p = [];
    let w = "1=1";
    if (scope.project) { w += " AND project = ?"; p.push(scope.project); }
    return db.prepare(`SELECT * FROM blackbox_incidents WHERE ${w} ORDER BY created_at DESC LIMIT 20`).all(...p);
  });

  ctx.capabilities = guarded("generated_capabilities", () => db.prepare(
    `SELECT * FROM generated_capabilities WHERE state IN ('trial','active') ORDER BY created_at DESC LIMIT 20`
  ).all());

  ctx.activePredictions = guarded("predictions", () => db.prepare(
    `SELECT * FROM predictions WHERE status = 'active' AND enabled = 1 ORDER BY created_at DESC LIMIT ${MAX_ACTIVE_PREDICTIONS_SCANNED}`
  ).all());

  ctx.feedbackHistory = guarded("prediction_feedback", () => db.prepare(
    `SELECT * FROM prediction_feedback ORDER BY created_at DESC LIMIT 200`
  ).all());

  return ctx;
}

// --- Detectors ---

function scopeFieldsFor(ctx, evidenceProject) {
  // Sequence-derived predictions summarize evidence across sessions, so they
  // carry no single session identity. The project comes from the evidence
  // itself, never from the scope: under a global analysis, identical pairs from
  // different projects must stay distinct rather than merging into one
  // project-null record.
  return {
    project: evidenceProject !== undefined ? (evidenceProject || null) : ctx.scope.project,
    session_id: ctx.scope.mode === "session" || ctx.scope.mode === "task" ? ctx.scope.session_id : null,
    task_id: ctx.scope.mode === "task" ? ctx.scope.task_id : null,
  };
}

function detectNextActions(ctx) {
  const candidates = [];
  const pairs = new Map();
  const fromTotals = new Map();

  for (const seg of ctx.sequences) {
    const logs = seg.logs;
    for (let i = 0; i < logs.length - 1; i++) {
      const a = logs[i];
      const b = logs[i + 1];
      if (a.tool_name === b.tool_name) continue;
      // Ascending order guarantees a precedes b in real time.
      const key = [seg.project || "", a.tool_name, b.tool_name].join(KEY_SEP);
      if (!pairs.has(key)) pairs.set(key, { count: 0, sessions: new Set(), lastAt: 0 });
      const entry = pairs.get(key);
      entry.count++;
      entry.sessions.add(seg.key);
      entry.lastAt = Math.max(entry.lastAt, b.time);
      const fromKey = [seg.project || "", a.tool_name].join(KEY_SEP);
      fromTotals.set(fromKey, (fromTotals.get(fromKey) || 0) + 1);
    }
  }

  for (const [key, entry] of pairs) {
    const [proj, toolA, toolB] = key.split(KEY_SEP);
    const total = fromTotals.get([proj, toolA].join(KEY_SEP)) || entry.count;
    const rate = entry.count / total;
    const contradictions = Math.max(0, total - entry.count);

    const score = calculateScore({
      baseRate: rate,
      sameProject: !!proj,
      recentMatches: entry.count,
      totalMatches: total,
      contradictions,
      sampleSize: entry.count,
    });

    candidates.push({
      type: "next_action",
      relation: `${toolA}->${toolB}`,
      subject: `After ${toolA}, ${toolB} commonly follows`,
      explanation: `In ${entry.count} observed sequences across ${entry.sessions.size} session(s), ${toolB} followed ${toolA} (${(rate * 100).toFixed(0)}% of ${total} transitions from ${toolA}).`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: entry.count,
      distinct_sessions: entry.sessions.size,
      time_horizon: "current_session",
      recommended_action: { tool: toolB, action: "use", risk: "read_only", requires_approval: false },
      evidence: [{
        source_type: "tool_call",
        source_id: null,
        summary: `${entry.count} chronological observations of ${toolA} → ${toolB} across ${entry.sessions.size} session(s)`,
      }],
      ...scopeFieldsFor(ctx, proj),
    });
  }

  return candidates;
}

function detectLikelyFailures(ctx) {
  const candidates = [];
  const attempts = new Map();
  const groups = new Map();
  const nowMs = Date.parse(ctx.now) || Date.now();

  for (const log of ctx.toolLogs) {
    attempts.set([log.project || "", log.tool_name].join(KEY_SEP),
      (attempts.get([log.project || "", log.tool_name].join(KEY_SEP)) || 0) + 1);
  }

  for (const log of ctx.toolLogs) {
    if (log.ok) continue;
    const key = [log.project || "", log.tool_name, log.error_category || "unknown"].join(KEY_SEP);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(log);
  }

  for (const [key, fails] of groups) {
    const [proj, tool, errCat] = key.split(KEY_SEP);
    const total = attempts.get([proj, tool].join(KEY_SEP)) || fails.length;
    const rate = fails.length / total;
    const recent = fails.filter(f => nowMs - f.time <= RECENT_FAILURE_WINDOW_MS).length;
    // Unscoped failures collapse into one bucket so they cannot inflate breadth.
    const sessions = new Set(fails.map(f => boundaryId(f) || KEY_SEP + "unscoped"));
    const successes = total - fails.length;

    const score = calculateScore({
      baseRate: rate,
      sameProject: !!proj,
      recentMatches: recent,
      totalMatches: total,
      contradictions: successes,
      sampleSize: fails.length,
    });

    const sorted = fails.slice().sort((a, b) => b.time - a.time);

    candidates.push({
      type: "likely_failure",
      relation: `${tool}:${errCat}`,
      subject: `${tool} is failing with ${errCat} errors`,
      explanation: `${tool} failed ${fails.length} of ${total} calls (${(rate * 100).toFixed(0)}%) with error category "${errCat}"; ${recent} failure(s) in the last 24h across ${sessions.size} session(s).`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: {
        ...score.breakdown,
        attempts: total,
        failures: fails.length,
        successes,
        recent_failures: recent,
        failure_rate: Math.round(rate * 1000) / 1000,
      },
      observation_count: fails.length,
      distinct_sessions: sessions.size,
      // Detector-specific minimum evidence, evaluated before the shared gate.
      detector_ok: fails.length >= MIN_FAILURE_COUNT
        && total >= MIN_FAILURE_ATTEMPTS
        && rate >= MIN_FAILURE_RATE
        && recent >= MIN_RECENT_FAILURES,
      detector_reason: "insufficient_failure_evidence",
      time_horizon: "days_7",
      recommended_action: { tool, action: "inspect", risk: "read_only", requires_approval: false },
      evidence: sorted.slice(0, 5).map(f => ({
        source_type: "tool_call",
        source_id: f.id ? String(f.id) : null,
        source_timestamp: f.timestamp,
        summary: redactSensitive(f.result_summary || `Failed ${tool} call`).slice(0, 200),
      })),
      ...scopeFieldsFor(ctx, proj),
    });
  }

  return candidates;
}

/**
 * `A requires B` is only inferred from repeated recovery evidence:
 * A fails -> B succeeds -> A succeeds, inside one segment, within a bounded
 * window, with compatible arguments where a fingerprint is available.
 *
 * Bare "A failed then B succeeded" adjacency is not evidence of a prerequisite.
 */
function detectMissingPrerequisites(ctx) {
  const recoveries = new Map();

  for (const seg of ctx.sequences) {
    const logs = seg.logs;
    for (let i = 0; i < logs.length; i++) {
      const failed = logs[i];
      if (failed.ok) continue;

      for (let j = i + 1; j < logs.length && j <= i + PREREQ_MAX_STEP_DISTANCE; j++) {
        const middle = logs[j];
        if (!middle.ok) continue;
        if (middle.tool_name === failed.tool_name) break; // A succeeded without help
        if (middle.time - failed.time > PREREQ_RECOVERY_WINDOW_MS) break;

        for (let k = j + 1; k < logs.length && k <= j + PREREQ_MAX_STEP_DISTANCE; k++) {
          const recovered = logs[k];
          if (recovered.tool_name !== failed.tool_name) continue;
          if (!recovered.ok) break; // still failing — not a recovery
          if (recovered.time - middle.time > PREREQ_RECOVERY_WINDOW_MS) break;
          // Compatible arguments where both fingerprints are known.
          if (failed.arg_fingerprint && recovered.arg_fingerprint
            && failed.arg_fingerprint !== recovered.arg_fingerprint) break;

          const key = [seg.project || "", failed.tool_name, middle.tool_name].join(KEY_SEP);
          if (!recoveries.has(key)) {
            recoveries.set(key, { count: 0, sessions: new Set(), samples: [], errorCategories: new Set() });
          }
          const entry = recoveries.get(key);
          entry.count++;
          entry.sessions.add(seg.key);
          if (failed.error_category) entry.errorCategories.add(failed.error_category);
          if (entry.samples.length < 5) {
            entry.samples.push({ failed, middle, recovered, project: seg.project });
          }
          break;
        }
        break; // only the nearest successful intermediate counts
      }
    }
  }

  const candidates = [];
  for (const [key, entry] of recoveries) {
    const [proj, failedTool, prereqTool] = key.split(KEY_SEP);
    const score = calculateScore({
      baseRate: Math.min(0.5 + entry.count * 0.1, 0.9),
      sameProject: !!proj,
      recentMatches: entry.count,
      totalMatches: entry.count,
      sampleSize: entry.count,
    });

    candidates.push({
      type: "missing_prerequisite",
      relation: `${failedTool}<-${prereqTool}`,
      subject: `${failedTool} may require ${prereqTool} first`,
      explanation: `${entry.count} recovery sequence(s) across ${entry.sessions.size} session(s): ${failedTool} failed, ${prereqTool} succeeded, then ${failedTool} succeeded${entry.errorCategories.size ? ` (error categories: ${[...entry.errorCategories].join(", ")})` : ""}.`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: { ...score.breakdown, recoveries: entry.count, distinct_sessions: entry.sessions.size },
      observation_count: entry.count,
      distinct_sessions: entry.sessions.size,
      detector_ok: entry.count >= MIN_PREREQ_RECOVERIES && entry.sessions.size >= 2,
      detector_reason: "insufficient_recovery_evidence",
      time_horizon: "current_task",
      recommended_action: { tool: prereqTool, action: "run_first", risk: "read_only", requires_approval: false },
      evidence: entry.samples.map(s => ({
        source_type: "tool_call",
        source_id: s.failed.id ? String(s.failed.id) : null,
        source_timestamp: s.failed.timestamp,
        summary: redactSensitive(
          `${s.failed.tool_name} failed (${s.failed.error_category || "unknown"}) → ${s.middle.tool_name} succeeded → ${s.recovered.tool_name} succeeded`
        ).slice(0, 200),
      })),
      ...scopeFieldsFor(ctx, proj),
    });
  }

  return candidates;
}

/**
 * Disabled by default.
 *
 * A stored memory is not a prediction. Sidekick has no signal that relates a
 * memory to the current analysis target, and recency, pinning, high confidence
 * or a matching project are not relevance. Generic context retrieval belongs to
 * the memory and context tools, not here.
 *
 * When explicitly enabled, this is restricted to context inside the requested
 * scope that carries an unresolved, actionable condition.
 */
function detectRelevantContext(ctx) {
  if (!ctx.config.enable_relevant_context) return [];
  if (!ctx.scope.project) return []; // never emit context for a global sweep

  const candidates = [];
  for (const mem of ctx.memories) {
    if (mem.project !== ctx.scope.project) continue;
    const unresolved = mem.state === "active" && (mem.type === "blocker" || mem.type === "todo" || mem.type === "decision_pending");
    if (!unresolved) continue;

    const score = calculateScore({
      baseRate: typeof mem.confidence === "number" ? mem.confidence : 0.5,
      sameProject: true,
      sampleSize: mem.times_confirmed || 1,
      totalMatches: mem.times_confirmed || 1,
      recentMatches: 1,
    });

    candidates.push({
      type: "relevant_context",
      relation: `memory:${mem.id}`,
      // Redacted and bounded on every path: this text is copied into the
      // prediction subject, an audit row, and the dashboard.
      subject: redactSensitive(String(mem.summary || mem.content || "")).slice(0, 200) || "Unresolved context",
      explanation: redactSensitive(
        `Unresolved ${mem.type} in ${ctx.scope.project}: ${String(mem.content || "")}`
      ).slice(0, 300),
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: mem.times_confirmed || 1,
      distinct_sessions: 1,
      time_horizon: "current_task",
      recommended_action: { tool: "sidekick_memory", action: "get", risk: "read_only", requires_approval: false },
      evidence: [{
        source_type: "memory",
        source_id: mem.id,
        summary: redactSensitive(String(mem.summary || mem.content || "")).slice(0, 200),
      }],
      ...scopeFieldsFor(ctx),
    });
  }
  return candidates;
}

function detectIncidentRecurrence(ctx) {
  const groups = new Map();
  for (const inc of ctx.incidents) {
    const title = String(inc.title || "").slice(0, 50);
    if (!title) continue;
    const key = [title, inc.project || ""].join(KEY_SEP);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(inc);
  }

  const candidates = [];
  for (const [key, incidents] of groups) {
    const [title, project] = key.split(KEY_SEP);
    const distinct = new Set(incidents.map(i => i.id));
    const score = calculateScore({
      baseRate: 0.7,
      sameProject: !!(ctx.scope.project && project === ctx.scope.project),
      sampleSize: distinct.size,
      totalMatches: distinct.size,
      recentMatches: distinct.size,
    });

    candidates.push({
      type: "incident_recurrence",
      relation: `incident:${title}`,
      subject: `Incident pattern: ${title}`,
      explanation: `${distinct.size} distinct incidents share this signature. Recurrence risk: ${(score.probability * 100).toFixed(0)}%.`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: distinct.size,
      distinct_sessions: 1,
      detector_ok: distinct.size >= 2,
      detector_reason: "single_incident",
      time_horizon: "days_7",
      recommended_action: { tool: "sidekick_black_box", action: "get_incident", risk: "read_only", requires_approval: false },
      evidence: incidents.slice(0, 5).map(inc => ({
        source_type: "incident",
        source_id: inc.id,
        source_timestamp: inc.created_at,
        summary: redactSensitive(`${inc.title} (${inc.lifecycle_state})`).slice(0, 200),
      })),
      project: project || ctx.scope.project,
      session_id: null,
      task_id: null,
    });
  }
  return candidates;
}

function detectWorkflowOpportunities(ctx) {
  const seqCounts = new Map();

  for (const seg of ctx.sequences) {
    const successful = seg.logs.filter(l => l.ok);
    if (successful.length < 3) continue;
    for (let i = 0; i <= successful.length - 3; i++) {
      const window = successful.slice(i, i + 3);
      // Require the window to be contiguous in time within the segment gap.
      const sig = window.map(s => s.tool_name).join("→");
      if (new Set(window.map(s => s.tool_name)).size < 3) continue;
      const key = [seg.project || "", sig].join(KEY_SEP);
      if (!seqCounts.has(key)) seqCounts.set(key, { count: 0, sessions: new Set(), project: seg.project });
      const entry = seqCounts.get(key);
      entry.count++;
      entry.sessions.add(seg.key);
    }
  }

  const candidates = [];
  for (const [key, entry] of seqCounts) {
    const sig = key.split(KEY_SEP)[1];
    const tools = sig.split("→");
    const hasEvolveCandidate = ctx.capabilities.some(cap => {
      const capSteps = parseJson(cap.steps_json, []);
      const capTools = capSteps.map(s => s.tool_name).filter(Boolean);
      return tools.every(t => capTools.includes(t));
    });

    const score = calculateScore({
      baseRate: 0.65,
      sameProject: !!entry.project,
      sampleSize: entry.count,
      totalMatches: entry.count,
      recentMatches: entry.count,
    });

    candidates.push({
      type: "workflow_opportunity",
      relation: `sequence:${sig}`,
      subject: `Repeated sequence: ${sig}`,
      explanation: `Sequence ${sig} completed successfully ${entry.count} times across ${entry.sessions.size} session(s).${hasEvolveCandidate ? " An Evolve candidate already exists." : " No Evolve candidate found."}`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: entry.count,
      distinct_sessions: entry.sessions.size,
      time_horizon: "days_30",
      recommended_action: hasEvolveCandidate
        ? { tool: "sidekick_evolve", action: "inspect", risk: "read_only", requires_approval: false }
        : { tool: "sidekick_evolve", action: "analyze", risk: "read_only", requires_approval: false },
      evidence: [{
        source_type: "tool_call",
        source_id: null,
        summary: `${entry.count} successful ${sig} sequences across ${entry.sessions.size} session(s)`,
      }],
      ...scopeFieldsFor(ctx, entry.project),
    });
  }
  return candidates;
}

const DETECTORS = [
  { name: "next_action", fn: detectNextActions, enabled: () => true },
  { name: "likely_failure", fn: detectLikelyFailures, enabled: () => true },
  { name: "missing_prerequisite", fn: detectMissingPrerequisites, enabled: () => true },
  { name: "relevant_context", fn: detectRelevantContext, enabled: (c) => c.enable_relevant_context },
  { name: "incident_recurrence", fn: detectIncidentRecurrence, enabled: () => true },
  { name: "workflow_opportunity", fn: detectWorkflowOpportunities, enabled: () => true },
];

// --- Candidate admission gate ---

/**
 * The single place a candidate becomes eligible for persistence.
 * Returns { admitted: true } or { admitted: false, reason }.
 */
function admitCandidate(candidate, ctx) {
  if (!candidate || typeof candidate !== "object") return { admitted: false, reason: "malformed_candidate" };
  if (!VALID_TYPES.includes(candidate.type)) return { admitted: false, reason: "unsupported_type" };

  const rules = ADMISSION[candidate.type];
  if (!rules) return { admitted: false, reason: "unsupported_type" };

  if (candidate.detector_ok === false) {
    return { admitted: false, reason: candidate.detector_reason || "detector_threshold" };
  }

  const subject = String(candidate.subject || "").trim();
  const explanation = String(candidate.explanation || "").trim();
  if (!subject) return { admitted: false, reason: "empty_subject" };
  if (!explanation) return { admitted: false, reason: "empty_explanation" };
  if (!candidate.relation) return { admitted: false, reason: "missing_identity_relation" };

  if (!VALID_TIME_HORIZONS.includes(candidate.time_horizon || "open_ended")) {
    return { admitted: false, reason: "invalid_time_horizon" };
  }

  // Scope validity: a scoped analysis must not emit records outside its scope.
  if (ctx.scope.mode !== "global" && ctx.scope.project && candidate.project
    && candidate.project !== ctx.scope.project) {
    return { admitted: false, reason: "out_of_scope_project" };
  }
  if (ctx.scope.mode === "global" && candidate.project === undefined) {
    return { admitted: false, reason: "invalid_scope" };
  }

  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.filter(e => e && e.summary) : [];
  if (evidence.length < rules.minEvidence) return { admitted: false, reason: "insufficient_evidence" };

  if ((candidate.observation_count || 0) < rules.minObservations) {
    return { admitted: false, reason: "insufficient_observations" };
  }
  if ((candidate.distinct_sessions || 0) < rules.minSessions) {
    return { admitted: false, reason: "insufficient_distinct_sessions" };
  }
  if ((candidate.probability || 0) < rules.minProbability) {
    return { admitted: false, reason: "below_probability_threshold" };
  }
  if (confidenceRank(candidate.confidence) < confidenceRank(rules.minConfidence)) {
    return { admitted: false, reason: "below_confidence_threshold" };
  }
  if (rules.requiresAction && !candidate.recommended_action) {
    return { admitted: false, reason: "not_actionable" };
  }

  // Unresolved contradiction: contradicting successes outweigh the evidence.
  const bd = candidate.score_breakdown || {};
  if (typeof bd.contradictions === "number" && typeof bd.sample_size === "number"
    && bd.sample_size > 0 && bd.contradictions > bd.sample_size * 3) {
    return { admitted: false, reason: "contradicted_by_evidence" };
  }

  return { admitted: true };
}

// --- Persistence ---

function normalizePrediction(row) {
  return {
    ...row,
    score_breakdown: parseJson(row.score_breakdown_json, {}),
    recommended_action: parseJson(row.recommended_action_json, null),
    legacy: !!row.legacy,
    enabled: !!row.enabled
  };
}

function getPrediction(id) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM predictions WHERE id = ?").get(id);
  return row ? normalizePrediction(row) : null;
}

function getPredictionEvidence(predictionId) {
  ensureSchema();
  const db = dbStore.getDb();
  return db.prepare("SELECT * FROM prediction_evidence WHERE prediction_id = ? ORDER BY created_at ASC").all(predictionId).map(r => ({
    ...r,
    safe_metadata: parseJson(r.safe_metadata_json, {})
  }));
}

function getPredictionFeedback(predictionId) {
  ensureSchema();
  const db = dbStore.getDb();
  return db.prepare("SELECT * FROM prediction_feedback WHERE prediction_id = ? ORDER BY created_at ASC").all(predictionId);
}

function findActiveByFingerprint(fingerprint) {
  ensureSchema();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM predictions WHERE fingerprint = ? AND status = 'active' AND enabled = 1").get(fingerprint);
  return row ? normalizePrediction(row) : null;
}

/** Most recent row for a logical identity, in any status. */
function findByIdentity(identityKey) {
  const db = dbStore.getDb();
  const row = db.prepare(
    "SELECT * FROM predictions WHERE identity_key = ? ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1"
  ).get(identityKey);
  return row ? normalizePrediction(row) : null;
}

function updatePrediction(id, patch) {
  const db = dbStore.getDb();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === "score_breakdown_json" || k === "recommended_action_json" || k === "score_breakdown" || k === "recommended_action") {
      const dbKey = k === "score_breakdown" ? "score_breakdown_json" : k === "recommended_action" ? "recommended_action_json" : k;
      sets.push(`${dbKey} = ?`);
      vals.push(typeof v === "string" ? v : JSON.stringify(v));
    } else {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  sets.push("updated_at = ?");
  vals.push(nowIso());
  vals.push(id);
  db.prepare(`UPDATE predictions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

function insertAudit(eventType, predictionId, details) {
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(eventType, predictionId || null, JSON.stringify(details || {}), nowIso());
}

function insertFeedback(fb) {
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO prediction_feedback (prediction_id, feedback, project, rule_version, scope_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(fb.prediction_id, fb.feedback, fb.project || null, fb.rule_version || RULE_VERSION, fb.scope_key || null, nowIso());
}

function expiresAtForHorizon(horizon) {
  const hours = HORIZON_EXPIRY_HOURS[horizon];
  return hours === null || hours === undefined ? null : hoursFromNow(hours);
}

/**
 * Inserts a prediction together with its evidence and creation audit atomically.
 * A partial write (prediction without its evidence) is never committed.
 */
function persistPrediction(pred, evidence) {
  const db = dbStore.getDb();
  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO predictions (id, type, subject, explanation, project, session_id, task_id,
        time_horizon, probability, confidence, score_breakdown_json, recommended_action_json,
        status, fingerprint, identity_key, rule_version, observation_count, created_at, expires_at,
        updated_at, last_seen_at, refresh_count, legacy, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pred.id, pred.type, pred.subject, pred.explanation,
      pred.project || null, pred.session_id || null, pred.task_id || null,
      pred.time_horizon || "open_ended", pred.probability, pred.confidence,
      JSON.stringify(pred.score_breakdown || {}),
      pred.recommended_action ? JSON.stringify(pred.recommended_action) : null,
      pred.status || "active", pred.fingerprint || null, pred.identity_key || null,
      pred.rule_version || RULE_VERSION, pred.observation_count || 0,
      pred.created_at, pred.expires_at || null, pred.created_at, pred.created_at, 0,
      pred.legacy ? 1 : 0, 1
    );

    const evStmt = db.prepare(`
      INSERT INTO prediction_evidence (id, prediction_id, source_type, source_id, source_timestamp, summary, safe_metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ev of (evidence || []).slice(0, MAX_EVIDENCE_PER_PREDICTION)) {
      evStmt.run(
        generateId("evi"), pred.id, ev.source_type, ev.source_id || null,
        ev.source_timestamp || null, ev.summary,
        JSON.stringify(ev.safe_metadata || {}), pred.created_at
      );
    }

    db.prepare(`
      INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at)
      VALUES ('created', ?, ?, ?)
    `).run(pred.id, JSON.stringify({ type: pred.type, subject: pred.subject, identity_key: pred.identity_key }), pred.created_at);
  });
  run();
}

function isUniqueViolation(err) {
  const msg = String((err && err.message) || "");
  return msg.includes("UNIQUE constraint failed") || (err && err.code === "SQLITE_CONSTRAINT_UNIQUE");
}

/**
 * Applies lifecycle rules for a logical identity.
 *
 * active     -> refresh in place
 * expired    -> reactivate the same row (never append an equivalent row)
 * superseded -> reactivate the same row
 * dismissed  -> suppress; the user already rejected this identity
 * confirmed / did_not_occur -> preserve history; suppress recreation during the
 *               cooldown, then create a fresh row that supersedes nothing
 */
function applyLifecycle(candidate, pred, config) {
  const existing = findByIdentity(candidate.identity_key);
  if (!existing) return { action: "create" };

  const db = dbStore.getDb();

  if (existing.status === "active") {
    db.transaction(() => {
      updatePrediction(existing.id, {
        probability: pred.probability,
        confidence: pred.confidence,
        score_breakdown: pred.score_breakdown,
        observation_count: Math.max(pred.observation_count, existing.observation_count || 0),
        explanation: pred.explanation,
        expires_at: pred.expires_at,
        last_seen_at: pred.created_at,
        refresh_count: (existing.refresh_count || 0) + 1,
        lifecycle_reason: "refreshed_by_reanalysis",
      });
      insertAudit("refreshed", existing.id, { identity_key: candidate.identity_key });
    })();
    return { action: "refresh", id: existing.id };
  }

  // A prediction retired because evidence or feedback contradicted it must not
  // be resurrected by the same rules that produced it.
  if (existing.status === "superseded" && existing.lifecycle_reason === "contradicted_by_feedback") {
    return { action: "suppress", reason: "contradicted_by_feedback", id: existing.id };
  }

  if (existing.status === "expired" || existing.status === "superseded") {
    db.transaction(() => {
      updatePrediction(existing.id, {
        status: "active",
        probability: pred.probability,
        confidence: pred.confidence,
        score_breakdown: pred.score_breakdown,
        observation_count: Math.max(pred.observation_count, existing.observation_count || 0),
        explanation: pred.explanation,
        expires_at: pred.expires_at,
        last_seen_at: pred.created_at,
        refresh_count: (existing.refresh_count || 0) + 1,
        lifecycle_reason: `reactivated_from_${existing.status}`,
      });
      insertAudit("reactivated", existing.id, { identity_key: candidate.identity_key, from_status: existing.status });
    })();
    return { action: "reactivate", id: existing.id };
  }

  if (existing.status === "dismissed") {
    return { action: "suppress", reason: "dismissed_by_user", id: existing.id };
  }

  // confirmed / did_not_occur — historical outcomes are never rewritten.
  const cutoff = daysAgoIso(config.identity_cooldown_days);
  if ((existing.outcome_at || existing.updated_at || existing.created_at) > cutoff) {
    return { action: "suppress", reason: "recent_recorded_outcome", id: existing.id };
  }
  return { action: "create" };
}

// --- Lifecycle maintenance ---

/**
 * Transitions active predictions whose time horizon has passed.
 * Emits one batched audit row rather than one row per prediction.
 */
function expireOldPredictions() {
  const db = dbStore.getDb();
  const now = nowIso();
  const rows = db.prepare(
    "SELECT id FROM predictions WHERE status = 'active' AND enabled = 1 AND expires_at IS NOT NULL AND expires_at < ?"
  ).all(now);
  if (rows.length === 0) return 0;

  const ids = rows.map(r => r.id);
  const run = db.transaction(() => {
    const stmt = db.prepare("UPDATE predictions SET status = 'expired', lifecycle_reason = 'time_horizon_passed', updated_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(now, id);
    db.prepare(`INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at) VALUES ('expired', NULL, ?, ?)`)
      .run(JSON.stringify({ count: ids.length, reason: "time_horizon_passed", ids: ids.slice(0, 50) }), now);
  });
  run();
  return ids.length;
}

/**
 * Retires predictions that scope or feedback has contradicted.
 *
 * This transitions the original record and records a reason. It never creates a
 * prediction *about* a prediction, which is what produced recursive
 * "Prediction may be stale: Prediction may be stale: ..." chains.
 */
function retireContradictedPredictions(ctx) {
  const db = dbStore.getDb();
  const retired = [];

  for (const row of ctx.activePredictions) {
    const pred = normalizePrediction(row);

    // A scoped analysis only transitions records inside its own scope; it must
    // not mutate another project's predictions as a side effect.
    if (ctx.scope.mode !== "global" && ctx.scope.project && pred.project !== ctx.scope.project) continue;
    if (ctx.scope.session_id && pred.session_id && pred.session_id !== ctx.scope.session_id) continue;

    let reason = null;

    if (pred.outcome && !["unresolved", "confirmed"].includes(pred.outcome)) {
      reason = `outcome_recorded:${pred.outcome}`;
    }

    if (!reason) {
      const fb = ctx.feedbackHistory.filter(f => f.prediction_id === pred.id);
      const negative = fb.filter(f => ["incorrect", "not_useful"].includes(f.feedback)).length;
      const positive = fb.filter(f => ["useful", "acted_on"].includes(f.feedback)).length;
      if (negative > 0 && negative > positive) reason = "contradicted_by_feedback";
    }

    // A session/task-scoped prediction becomes terminal when its scope ends.
    if (!reason && pred.time_horizon === "current_session" && pred.session_id
      && ctx.scope.mode === "session" && ctx.scope.session_id
      && pred.session_id !== ctx.scope.session_id) {
      reason = "session_scope_ended";
    }

    if (reason) retired.push({ id: pred.id, reason });
  }

  if (retired.length === 0) return 0;

  const now = nowIso();
  const run = db.transaction(() => {
    const stmt = db.prepare("UPDATE predictions SET status = 'superseded', lifecycle_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'");
    for (const r of retired) stmt.run(r.reason, now, r.id);
    db.prepare(`INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at) VALUES ('superseded', NULL, ?, ?)`)
      .run(JSON.stringify({ count: retired.length, retired: retired.slice(0, 50) }), now);
  });
  run();
  return retired.length;
}

// --- Feedback weighting ---

/**
 * Feedback adjustment for a specific rule version, project and prediction type.
 *
 * Scope is matched with IS NULL rather than an equality comparison against "%",
 * which previously matched nothing for the no-project case. The adjustment is
 * deliberately small and saturates quickly so repeated feedback on one
 * prediction cannot drive every unrelated candidate.
 */
function feedbackWeight(project, ruleVersion, type) {
  ensureSchema();
  const db = dbStore.getDb();

  const params = [ruleVersion || RULE_VERSION];
  let where = "rule_version = ?";
  if (project === undefined || project === null || project === "") {
    where += " AND project IS NULL";
  } else {
    where += " AND project = ?";
    params.push(project);
  }
  if (type) {
    where += " AND (scope_key IS NULL OR scope_key = ?)";
    params.push(type);
  }

  // Count each prediction once per feedback kind so duplicate submissions on a
  // single prediction cannot compound.
  const rows = db.prepare(
    `SELECT feedback, COUNT(DISTINCT prediction_id) AS cnt
     FROM prediction_feedback WHERE ${where} GROUP BY feedback`
  ).all(...params);

  const weights = { useful: 0.04, not_useful: -0.04, incorrect: -0.08, already_known: -0.02, acted_on: 0.02, dismissed: -0.02 };
  let adjustment = 0;
  for (const r of rows) {
    adjustment += (weights[r.feedback] || 0) * Math.min(r.cnt, 5);
  }
  return Math.max(Math.min(adjustment, 0.1), -0.1);
}

// --- Main analysis orchestrator ---

function analyze(options) {
  ensureSchema();
  const start = Date.now();
  const config = getConfig();

  const resolved = resolveScope(options);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, valid_scopes: VALID_SCOPES };
  }
  const scope = resolved.scope;

  const expired = expireOldPredictions();
  const ctx = buildAnalysisContext(scope, config);
  const superseded = retireContradictedPredictions(ctx);

  const detectorResults = [];
  let allCandidates = [];

  for (const detector of DETECTORS) {
    if (!detector.enabled(config)) {
      detectorResults.push({ name: detector.name, enabled: false, count: 0, ok: true });
      continue;
    }
    try {
      const results = detector.fn(ctx) || [];
      allCandidates = allCandidates.concat(results);
      detectorResults.push({ name: detector.name, enabled: true, count: results.length, ok: true });
    } catch (e) {
      detectorResults.push({
        name: detector.name, enabled: true, count: 0, ok: false,
        error: redactSensitive(String(e.message || e)).slice(0, 200),
      });
    }
  }

  // --- Central admission gate ---
  const rejected = {};
  const admitted = [];
  for (const candidate of allCandidates) {
    const verdict = admitCandidate(candidate, ctx);
    if (!verdict.admitted) {
      rejected[verdict.reason] = (rejected[verdict.reason] || 0) + 1;
      continue;
    }
    admitted.push(candidate);
  }

  // --- Global ranking before the creation limit ---
  // Detector execution order must not decide which candidates survive.
  admitted.sort((a, b) =>
    (confidenceRank(b.confidence) - confidenceRank(a.confidence))
    || (b.probability - a.probability)
    || (b.observation_count - a.observation_count)
    || String(a.subject).localeCompare(String(b.subject))
  );

  const created = [];
  const refreshed = [];
  const reactivated = [];
  const suppressed = [];

  for (const candidate of admitted) {
    if (created.length >= MAX_PREDICTIONS_PER_ANALYZE) {
      rejected.max_created_reached = (rejected.max_created_reached || 0) + 1;
      continue;
    }

    candidate.identity_key = makeIdentityKey({
      rule_version: RULE_VERSION,
      type: candidate.type,
      relation: candidate.relation,
      project: candidate.project,
      session_id: candidate.session_id,
      task_id: candidate.task_id,
    });

    const fbWeight = feedbackWeight(candidate.project, RULE_VERSION, candidate.type);
    const probability = fbWeight === 0
      ? candidate.probability
      : Math.max(0.05, Math.min(0.95, candidate.probability + fbWeight));

    const pred = {
      id: generateId("pred"),
      type: candidate.type,
      subject: candidate.subject,
      explanation: candidate.explanation,
      project: candidate.project || null,
      session_id: candidate.session_id || null,
      task_id: candidate.task_id || null,
      time_horizon: candidate.time_horizon || "open_ended",
      probability,
      confidence: candidate.confidence,
      score_breakdown: candidate.score_breakdown,
      recommended_action: candidate.recommended_action || null,
      observation_count: candidate.observation_count || 0,
      status: "active",
      identity_key: candidate.identity_key,
      fingerprint: makeFingerprint(candidate.type, candidate.relation, candidate.project),
      rule_version: RULE_VERSION,
      created_at: nowIso(),
      expires_at: expiresAtForHorizon(candidate.time_horizon || "open_ended"),
    };

    let decision;
    try {
      decision = applyLifecycle(candidate, pred, config);
    } catch (e) {
      rejected.lifecycle_error = (rejected.lifecycle_error || 0) + 1;
      continue;
    }

    if (decision.action === "refresh") { refreshed.push(decision.id); continue; }
    if (decision.action === "reactivate") { reactivated.push(decision.id); continue; }
    if (decision.action === "suppress") {
      suppressed.push({ id: decision.id, reason: decision.reason });
      rejected[decision.reason] = (rejected[decision.reason] || 0) + 1;
      continue;
    }

    try {
      persistPrediction(pred, candidate.evidence);
      created.push(pred);
    } catch (e) {
      if (isUniqueViolation(e)) {
        // A concurrent analysis created this identity first. Treat as a refresh
        // rather than a failure; the active-identity invariant holds.
        const winner = findByIdentity(candidate.identity_key);
        if (winner) refreshed.push(winner.id);
        rejected.concurrent_duplicate = (rejected.concurrent_duplicate || 0) + 1;
      } else {
        rejected.persistence_error = (rejected.persistence_error || 0) + 1;
        insertAudit("persistence_error", null, {
          type: pred.type,
          error: redactSensitive(String(e.message || e)).slice(0, 200),
        });
      }
    }
  }

  const duration = Date.now() - start;
  const summary = {
    duration_ms: duration,
    scope,
    tool_logs_scanned: ctx.toolLogs.length,
    sequences_built: ctx.sequences.length,
    unscoped_logs_skipped: ctx.skippedUnscoped,
    candidates_considered: allCandidates.length,
    candidates_admitted: admitted.length,
    rejected_by_reason: rejected,
    created: created.length,
    refreshed: refreshed.length,
    reactivated: reactivated.length,
    superseded,
    expired,
    detectors: detectorResults,
    context_errors: ctx.errors,
  };

  insertAudit("analyzed", null, summary);

  try {
    dbStore.getDb().prepare("UPDATE prediction_rules SET last_run_at = ? WHERE rule_version = ?")
      .run(nowIso(), RULE_VERSION);
  } catch { /* rule bookkeeping is non-critical */ }

  return {
    ok: true,
    scope,
    created: created.length,
    refreshed: refreshed.length,
    reactivated: reactivated.length,
    suppressed: suppressed.length,
    superseded,
    expired,
    candidates_considered: allCandidates.length,
    candidates_admitted: admitted.length,
    rejected_by_reason: rejected,
    total_active: countActivePredictions(),
    duration_ms: duration,
    detectors: detectorResults,
    context_errors: ctx.errors,
    predictions: created,
  };
}

function countActivePredictions() {
  const db = dbStore.getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM predictions WHERE status = 'active' AND enabled = 1").get();
  return row ? row.cnt : 0;
}

function listPredictions(filters) {
  ensureSchema();
  const db = dbStore.getDb();
  const f = filters || {};
  const where = ["enabled = 1"];
  const params = [];

  if (f.status) { where.push("status = ?"); params.push(f.status); }
  else { where.push("status = 'active'"); }
  if (f.type) { where.push("type = ?"); params.push(f.type); }
  if (f.project) { where.push("project = ?"); params.push(f.project); }
  if (f.session_id) { where.push("session_id = ?"); params.push(f.session_id); }
  if (f.task_id) { where.push("task_id = ?"); params.push(f.task_id); }
  if (f.confidence) { where.push("confidence = ?"); params.push(f.confidence); }

  const limit = clampLimit(f.limit, 20, 100);
  const offset = Number.isFinite(Number(f.offset)) && Number(f.offset) > 0 ? Math.floor(Number(f.offset)) : 0;

  const rows = db.prepare(
    `SELECT * FROM predictions WHERE ${where.join(" AND ")} ORDER BY probability DESC, created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return rows.map(normalizePrediction);
}

function recordFeedback(predictionId, feedback, project) {
  ensureSchema();
  if (!predictionId) return { ok: false, error: "prediction_id required" };
  if (!feedback || !VALID_FEEDBACK.includes(feedback)) {
    return { ok: false, error: `feedback must be one of: ${VALID_FEEDBACK.join(", ")}` };
  }

  const pred = getPrediction(predictionId);
  if (!pred) return { ok: false, error: `Prediction not found: ${predictionId}` };

  const db = dbStore.getDb();
  // Guard against accidental duplicate submissions of the same verdict.
  const dupe = db.prepare(
    "SELECT id FROM prediction_feedback WHERE prediction_id = ? AND feedback = ? LIMIT 1"
  ).get(predictionId, feedback);
  if (dupe) {
    return { ok: true, prediction_id: predictionId, feedback, duplicate: true, recorded: false };
  }

  const run = db.transaction(() => {
    insertFeedback({
      prediction_id: predictionId,
      feedback,
      project: project || pred.project || null,
      rule_version: pred.rule_version || RULE_VERSION,
      scope_key: pred.type,
    });
    insertAudit("feedback", predictionId, { feedback });
  });
  run();

  return { ok: true, prediction_id: predictionId, feedback, recorded: true };
}

function recordOutcome(predictionId, outcome) {
  ensureSchema();
  if (!predictionId) return { ok: false, error: "prediction_id required" };
  if (!outcome || !VALID_OUTCOMES.includes(outcome)) {
    return { ok: false, error: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}` };
  }

  const pred = getPrediction(predictionId);
  if (!pred) return { ok: false, error: `Prediction not found: ${predictionId}` };

  const newStatus = outcome === "confirmed" ? "confirmed"
    : outcome === "did_not_occur" ? "did_not_occur"
      : pred.status;

  const db = dbStore.getDb();
  const run = db.transaction(() => {
    updatePrediction(predictionId, {
      outcome, outcome_at: nowIso(), status: newStatus, lifecycle_reason: `outcome:${outcome}`,
    });
    insertAudit("outcome", predictionId, { outcome });
  });
  run();

  return { ok: true, prediction_id: predictionId, outcome, status: newStatus };
}

function dismissPrediction(predictionId) {
  ensureSchema();
  if (!predictionId) return { ok: false, error: "prediction_id required" };

  const pred = getPrediction(predictionId);
  if (!pred) return { ok: false, error: `Prediction not found: ${predictionId}` };

  const db = dbStore.getDb();
  const run = db.transaction(() => {
    updatePrediction(predictionId, { status: "dismissed", lifecycle_reason: "dismissed_by_user" });
    insertAudit("dismissed", predictionId, {});
  });
  run();

  return { ok: true, prediction_id: predictionId, status: "dismissed" };
}

// --- Retention and safe cleanup ---

function retentionCounts(db) {
  const byStatus = db.prepare("SELECT status, COUNT(*) AS cnt FROM predictions GROUP BY status").all();
  return {
    predictions: db.prepare("SELECT COUNT(*) AS cnt FROM predictions").get().cnt,
    predictions_by_status: byStatus.reduce((acc, r) => { acc[r.status] = r.cnt; return acc; }, {}),
    prediction_evidence: db.prepare("SELECT COUNT(*) AS cnt FROM prediction_evidence").get().cnt,
    prediction_feedback: db.prepare("SELECT COUNT(*) AS cnt FROM prediction_feedback").get().cnt,
    prediction_audit: db.prepare("SELECT COUNT(*) AS cnt FROM prediction_audit").get().cnt,
  };
}

/**
 * Selects terminal predictions eligible for deletion.
 *
 * Policy — preserved regardless of age:
 *   - status 'confirmed' (verified engine quality signal)
 *   - any prediction that carries feedback (needed to evaluate rule quality)
 *   - legacy rows, unless purge_legacy is explicitly requested
 */
function selectPurgeable(db, retentionDays, opts) {
  const cutoff = daysAgoIso(retentionDays);
  const includeLegacy = !!(opts && opts.purge_legacy);
  const statuses = TERMINAL_STATUSES.filter(s => s !== "confirmed");

  const rows = db.prepare(`
    SELECT p.id, p.status, p.type, p.project, p.legacy, p.updated_at, p.rule_version,
           (SELECT COUNT(*) FROM prediction_feedback f WHERE f.prediction_id = p.id) AS feedback_count
    FROM predictions p
    WHERE p.status IN (${statuses.map(() => "?").join(",")})
      AND COALESCE(p.outcome_at, p.updated_at, p.created_at) < ?
    ORDER BY p.updated_at ASC
  `).all(...statuses, cutoff);

  const purgeable = [];
  const preserved = [];
  for (const r of rows) {
    if (r.feedback_count > 0) { preserved.push({ ...r, reason: "has_feedback" }); continue; }
    if (r.legacy && !includeLegacy) { preserved.push({ ...r, reason: "legacy_record" }); continue; }
    purgeable.push(r);
  }
  return { cutoff, purgeable, preserved };
}

function purgePreview(options) {
  ensureSchema();
  const db = dbStore.getDb();
  const config = getConfig();
  const retentionDays = resolveRetentionDays(options && options.retention_days, config.retention_days);
  const { cutoff, purgeable, preserved } = selectPurgeable(db, retentionDays, options);

  const byStatus = {};
  for (const p of purgeable) byStatus[p.status] = (byStatus[p.status] || 0) + 1;

  // Chunked like purge(): an unbounded IN-clause would exceed SQLite's variable
  // limit and make the read-only preview fail exactly when the backlog is largest.
  let evidenceCount = 0;
  let auditCount = 0;
  const previewIds = purgeable.map(p => p.id);
  for (let i = 0; i < previewIds.length; i += PURGE_CHUNK_SIZE) {
    const chunk = previewIds.slice(i, i + PURGE_CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    evidenceCount += db.prepare(`SELECT COUNT(*) AS cnt FROM prediction_evidence WHERE prediction_id IN (${ph})`).get(...chunk).cnt;
    auditCount += db.prepare(`SELECT COUNT(*) AS cnt FROM prediction_audit WHERE prediction_id IN (${ph})`).get(...chunk).cnt;
  }

  // Read-only: no mutation of any kind.
  return {
    ok: true,
    preview: true,
    retention_days: retentionDays,
    cutoff,
    totals_before: retentionCounts(db),
    would_delete: {
      predictions: purgeable.length,
      predictions_by_status: byStatus,
      prediction_evidence: evidenceCount,
      prediction_audit: auditCount,
      prediction_feedback: 0,
    },
    preserved: {
      count: preserved.length,
      by_reason: preserved.reduce((acc, p) => { acc[p.reason] = (acc[p.reason] || 0) + 1; return acc; }, {}),
      policy: [
        "status 'confirmed' is never purged",
        "predictions with feedback are never purged (rule-quality evidence)",
        "legacy rows require purge_legacy=true",
        "feedback rows are always retained",
      ],
    },
    sample: purgeable.slice(0, 20).map(p => ({ id: p.id, type: p.type, status: p.status, project: p.project, updated_at: p.updated_at })),
  };
}

function purge(options) {
  ensureSchema();
  const opts = options || {};
  if (opts.confirm !== true) {
    return {
      ok: false,
      error: "purge requires confirm=true. Run action='purge_preview' first and review the counts.",
      hint: "predict({ action: 'purge', confirm: true })",
    };
  }

  const db = dbStore.getDb();
  const config = getConfig();
  const retentionDays = resolveRetentionDays(opts.retention_days, config.retention_days);
  const before = retentionCounts(db);
  const { cutoff, purgeable, preserved } = selectPurgeable(db, retentionDays, opts);

  if (purgeable.length === 0) {
    return {
      ok: true,
      retention_days: retentionDays,
      cutoff,
      deleted: { predictions: 0, prediction_evidence: 0, prediction_audit: 0, prediction_feedback: 0 },
      preserved: preserved.length,
      totals_before: before,
      totals_after: before,
    };
  }

  const ids = purgeable.map(p => p.id);
  let deletedEvidence = 0;
  let deletedAudit = 0;
  let deletedPredictions = 0;

  const run = db.transaction(() => {
    // Delete children explicitly: foreign-key enforcement may be off, so we do
    // not rely on ON DELETE CASCADE to keep evidence from being orphaned.
    for (let i = 0; i < ids.length; i += PURGE_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + PURGE_CHUNK_SIZE);
      const ph = chunk.map(() => "?").join(",");
      deletedEvidence += db.prepare(`DELETE FROM prediction_evidence WHERE prediction_id IN (${ph})`).run(...chunk).changes;
      deletedAudit += db.prepare(`DELETE FROM prediction_audit WHERE prediction_id IN (${ph})`).run(...chunk).changes;
      deletedPredictions += db.prepare(`DELETE FROM predictions WHERE id IN (${ph})`).run(...chunk).changes;
    }
    // One audit row for the whole operation — never one per deleted record.
    db.prepare(`INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at) VALUES ('purged', NULL, ?, ?)`)
      .run(JSON.stringify({
        retention_days: retentionDays,
        cutoff,
        deleted_predictions: deletedPredictions,
        deleted_evidence: deletedEvidence,
        deleted_audit: deletedAudit,
        preserved: preserved.length,
      }), nowIso());
  });
  run();

  return {
    ok: true,
    retention_days: retentionDays,
    cutoff,
    deleted: {
      predictions: deletedPredictions,
      prediction_evidence: deletedEvidence,
      prediction_audit: deletedAudit,
      prediction_feedback: 0,
    },
    preserved: preserved.length,
    totals_before: before,
    totals_after: retentionCounts(db),
  };
}

/**
 * One-time diagnostic report over existing Predict data.
 * Read-only: it never modifies or deletes anything.
 */
function diagnose() {
  ensureSchema();
  const db = dbStore.getDb();
  const group = (sql) => db.prepare(sql).all();

  const duplicateIdentities = db.prepare(`
    SELECT fingerprint, COUNT(*) AS cnt, COUNT(DISTINCT status) AS status_count
    FROM predictions WHERE fingerprint IS NOT NULL
    GROUP BY fingerprint HAVING cnt > 1 ORDER BY cnt DESC LIMIT 50
  `).all();

  const recreatedAfterExpiry = db.prepare(`
    SELECT fingerprint, COUNT(*) AS cnt
    FROM predictions WHERE fingerprint IS NOT NULL AND status IN ('expired','superseded')
    GROUP BY fingerprint HAVING cnt > 1 ORDER BY cnt DESC LIMIT 50
  `).all();

  const evidence = db.prepare("SELECT COUNT(*) AS cnt FROM prediction_evidence").get().cnt;
  const audit = db.prepare("SELECT COUNT(*) AS cnt FROM prediction_audit").get().cnt;
  const total = db.prepare("SELECT COUNT(*) AS cnt FROM predictions").get().cnt;

  const lowQuality = db.prepare(`
    SELECT COUNT(*) AS cnt FROM predictions
    WHERE rule_version = ?
      AND (type = 'relevant_context' OR type = 'stale_or_contradicted'
           OR subject LIKE 'Prediction may be stale:%' OR confidence IN ('none','low'))
  `).get(LEGACY_RULE_VERSION).cnt;

  return {
    ok: true,
    generated_at: nowIso(),
    read_only: true,
    totals: { predictions: total, evidence, audit, feedback: db.prepare("SELECT COUNT(*) AS cnt FROM prediction_feedback").get().cnt },
    by_type: group("SELECT type, COUNT(*) AS cnt FROM predictions GROUP BY type ORDER BY cnt DESC"),
    by_status: group("SELECT status, COUNT(*) AS cnt FROM predictions GROUP BY status ORDER BY cnt DESC"),
    by_confidence: group("SELECT confidence, COUNT(*) AS cnt FROM predictions GROUP BY confidence ORDER BY cnt DESC"),
    by_project: group("SELECT COALESCE(project,'(null)') AS project, COUNT(*) AS cnt FROM predictions GROUP BY project ORDER BY cnt DESC LIMIT 50"),
    by_rule_version: group("SELECT rule_version, COUNT(*) AS cnt FROM predictions GROUP BY rule_version ORDER BY cnt DESC"),
    null_scope: {
      null_project: db.prepare("SELECT COUNT(*) AS cnt FROM predictions WHERE project IS NULL").get().cnt,
      null_session: db.prepare("SELECT COUNT(*) AS cnt FROM predictions WHERE session_id IS NULL").get().cnt,
      null_task: db.prepare("SELECT COUNT(*) AS cnt FROM predictions WHERE task_id IS NULL").get().cnt,
      null_identity_key: db.prepare("SELECT COUNT(*) AS cnt FROM predictions WHERE identity_key IS NULL").get().cnt,
    },
    duplicate_fingerprints: duplicateIdentities,
    recreated_after_expiry: recreatedAfterExpiry,
    amplification: {
      evidence_per_prediction: total ? Math.round((evidence / total) * 100) / 100 : 0,
      audit_per_prediction: total ? Math.round((audit / total) * 100) / 100 : 0,
    },
    oldest: db.prepare("SELECT id, type, status, created_at FROM predictions ORDER BY created_at ASC LIMIT 1").get() || null,
    newest: db.prepare("SELECT id, type, status, created_at FROM predictions ORDER BY created_at DESC LIMIT 1").get() || null,
    likely_low_quality_v1_records: lowQuality,
    note: "Read-only report. No records were modified. Use purge_preview then purge to clean up terminal records.",
  };
}

// --- Engine status ---

function engineStatus() {
  ensureSchema();
  const db = dbStore.getDb();
  const config = getConfig();

  const active = db.prepare("SELECT COUNT(*) as cnt FROM predictions WHERE status = 'active' AND enabled = 1").get().cnt;
  const total = db.prepare("SELECT COUNT(*) as cnt FROM predictions").get().cnt;
  const terminal = db.prepare(
    `SELECT COUNT(*) as cnt FROM predictions WHERE status IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`
  ).get(...TERMINAL_STATUSES).cnt;

  const lastAnalysisRow = db.prepare(
    "SELECT details_json, created_at FROM prediction_audit WHERE event_type = 'analyzed' ORDER BY id DESC LIMIT 1"
  ).get();
  const lastDetails = lastAnalysisRow ? parseJson(lastAnalysisRow.details_json, {}) : null;

  const purgedRow = db.prepare(
    "SELECT details_json FROM prediction_audit WHERE event_type = 'purged' ORDER BY id DESC LIMIT 1"
  ).get();
  const lastPurge = purgedRow ? parseJson(purgedRow.details_json, {}) : null;

  const detectors = DETECTORS.map(d => {
    const last = lastDetails && Array.isArray(lastDetails.detectors)
      ? lastDetails.detectors.find(x => x.name === d.name) : null;
    return {
      name: d.name,
      enabled: d.enabled(config),
      last_count: last ? last.count : 0,
      last_ok: last ? last.ok !== false : null,
    };
  });

  return {
    ok: true,
    engine: RULE_VERSION,
    rule_version: RULE_VERSION,

    // Canonical counts
    active,
    terminal,
    total,

    // Documented aliases retained for existing MCP consumers.
    active_predictions: active,
    total_predictions: total,

    total_evidence: db.prepare("SELECT COUNT(*) as cnt FROM prediction_evidence").get().cnt,
    total_feedback: db.prepare("SELECT COUNT(*) as cnt FROM prediction_feedback").get().cnt,

    last_analyzed: lastAnalysisRow ? lastAnalysisRow.created_at : null,
    last_analysis: lastAnalysisRow ? lastAnalysisRow.created_at : null,
    last_analysis_scope: lastDetails ? lastDetails.scope || null : null,
    last_analysis_summary: lastDetails ? {
      candidates_considered: lastDetails.candidates_considered || 0,
      candidates_admitted: lastDetails.candidates_admitted || 0,
      rejected_by_reason: lastDetails.rejected_by_reason || {},
      created: lastDetails.created || 0,
      refreshed: lastDetails.refreshed || 0,
      reactivated: lastDetails.reactivated || 0,
      superseded: lastDetails.superseded || 0,
      expired: lastDetails.expired || 0,
      duration_ms: lastDetails.duration_ms || 0,
    } : null,
    last_purge: lastPurge,

    retention_days: config.retention_days,
    config: {
      retention_days: config.retention_days,
      sequence_gap_minutes: config.sequence_gap_minutes,
      enable_relevant_context: config.enable_relevant_context,
      identity_cooldown_days: config.identity_cooldown_days,
    },

    detectors,
    type_breakdown: db.prepare("SELECT type, COUNT(*) as cnt FROM predictions WHERE status = 'active' GROUP BY type").all(),
    confidence_breakdown: db.prepare("SELECT confidence, COUNT(*) as cnt FROM predictions WHERE status = 'active' GROUP BY confidence").all(),
    rules: db.prepare("SELECT * FROM prediction_rules ORDER BY rule_version").all().map(r => ({ ...r, config: parseJson(r.config_json, {}) })),
    uptime: process.uptime ? Math.round(process.uptime()) : null,
  };
}

// --- Legacy migration ---

function migrateLegacy() {
  ensureSchema();
  const PREDICT_FILE = path.join(DATA_DIR, "predict.json");

  if (!fs.existsSync(PREDICT_FILE)) return { migrated: 0, backed_up: false };

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(PREDICT_FILE, "utf-8"));
  } catch (e) {
    try {
      const backupPath = PREDICT_FILE + ".corrupt." + Date.now() + ".bak";
      fs.copyFileSync(PREDICT_FILE, backupPath);
      fs.unlinkSync(PREDICT_FILE);
      insertAudit("legacy_corrupt_backup", null, { backupPath });
      return { migrated: 0, backed_up: true, corrupt: true, backupPath };
    } catch (inner) {
      return { migrated: 0, backed_up: false, corrupt: true, error: redactSensitive(String(inner.message || inner)).slice(0, 200) };
    }
  }

  let backed_up = false;
  try {
    const backupPath = PREDICT_FILE + ".migrated." + Date.now() + ".bak";
    fs.copyFileSync(PREDICT_FILE, backupPath);
    backed_up = true;
    insertAudit("legacy_backup", null, { backupPath });
  } catch (e) {
    insertAudit("legacy_backup_failed", null, { error: redactSensitive(String(e.message || e)).slice(0, 200) });
  }

  let migrated = 0;
  const errors = [];

  if (legacy.predictions && Array.isArray(legacy.predictions)) {
    for (const old of legacy.predictions) {
      try {
        const type = mapLegacyType(old.type);
        const subject = old.prediction ? String(old.prediction).slice(0, 200) : "Legacy prediction";
        const identity = makeIdentityKey({
          rule_version: "legacy", type, relation: subject, project: old.project || null,
        });
        if (findByIdentity(identity)) continue;

        persistPrediction({
          id: old.id || generateId("pred"),
          type,
          subject,
          explanation: old.prediction || "Imported from legacy predict.json",
          project: old.project || null,
          time_horizon: "days_30",
          probability: typeof old.confidence === "number" ? old.confidence : 0.5,
          confidence: old.confidence >= 0.8 ? "high" : old.confidence >= 0.5 ? "medium" : "low",
          score_breakdown: { legacy: true },
          recommended_action: null,
          observation_count: 1,
          status: "active",
          identity_key: identity,
          fingerprint: makeFingerprint(type, subject, old.project || ""),
          rule_version: "legacy",
          legacy: true,
          created_at: old.created || nowIso(),
          expires_at: expiresAtForHorizon("days_30"),
        }, [{ source_type: "legacy_file", source_id: null, summary: "Imported from legacy predict.json" }]);
        migrated++;
      } catch (e) {
        if (!isUniqueViolation(e)) errors.push(redactSensitive(String(e.message || e)).slice(0, 120));
      }
    }
  }

  if (legacy.feedback && Array.isArray(legacy.feedback)) {
    for (const fb of legacy.feedback) {
      try {
        if (fb.predictionId && (fb.useful === true || fb.useful === false)) {
          insertFeedback({
            prediction_id: fb.predictionId,
            feedback: fb.useful ? "useful" : "not_useful",
            rule_version: "legacy"
          });
        }
      } catch (e) {
        errors.push(redactSensitive(String(e.message || e)).slice(0, 120));
      }
    }
  }

  try {
    fs.renameSync(PREDICT_FILE, PREDICT_FILE + ".archived." + Date.now());
  } catch (e) {
    errors.push(redactSensitive(String(e.message || e)).slice(0, 120));
  }

  insertAudit("legacy_migrated", null, { migrated, errors: errors.slice(0, 10) });
  return { migrated, backed_up, errors: errors.slice(0, 10) };
}

function mapLegacyType(legacyType) {
  const map = {
    "decision_pattern": "relevant_context",
    "unresolved_problems": "likely_failure",
    "frequent_tools": "workflow_opportunity",
    "error_rate": "likely_failure"
  };
  return map[legacyType] || "relevant_context";
}

// --- Exports ---

module.exports = {
  ensureSchema,
  migrateLegacy,
  analyze,
  listPredictions,
  getPrediction,
  getPredictionEvidence,
  getPredictionFeedback,
  recordFeedback,
  recordOutcome,
  dismissPrediction,
  engineStatus,
  purgePreview,
  purge,
  diagnose,
  // Exported for testing
  calculateScore,
  calculateConfidence,
  calculateBaseRate,
  smoothScore,
  makeFingerprint,
  makeIdentityKey,
  feedbackWeight,
  normalizeToolLog,
  persistPrediction,
  buildSequences,
  boundaryId,
  resolveScope,
  resolveRetentionDays,
  isValidRetentionDays,
  admitCandidate,
  expiresAtForHorizon,
  findActiveByFingerprint,
  countActivePredictions,
  VALID_TYPES,
  VALID_STATUSES,
  VALID_FEEDBACK,
  VALID_OUTCOMES,
  VALID_TIME_HORIZONS,
  VALID_SCOPES,
  TERMINAL_STATUSES,
  CONFIDENCE_LEVELS,
  HORIZON_EXPIRY_HOURS,
  ADMISSION,
  RULE_VERSION,
  LEGACY_RULE_VERSION,
  MIN_OBSERVATIONS_FOR_PREDICTION,
  MIN_FAILURE_ATTEMPTS,
  MIN_FAILURE_COUNT,
  MIN_FAILURE_RATE,
  MIN_RECENT_FAILURES,
  MIN_PREREQ_RECOVERIES,
  DEFAULT_EXPIRY_HOURS,
};
