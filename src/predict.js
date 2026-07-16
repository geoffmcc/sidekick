/**
 * sidekick_predict — Evidence-backed prediction and decision-support engine.
 *
 * Identifies likely next actions, failure risks, missing prerequisites,
 * relevant prior context, incident recurrence risks, workflow opportunities,
 * and stale/contradicted predictions from Sidekick's structured operational history.
 *
 * Deterministic first implementation — no LLM dependency.
 * All predictions are grounded in inspectable evidence.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dbStore = require("./db");
const { redactSensitive } = require("./redact");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const RULE_VERSION = "predict-v1";

// --- Confidence levels and thresholds ---

const CONFIDENCE_LEVELS = ["none", "low", "medium", "high", "very_high"];
const MIN_OBSERVATIONS_FOR_PREDICTION = 3;
const MIN_OBSERVATIONS_FOR_HIGH_CONFIDENCE = 15;
const MIN_OBSERVATIONS_FOR_VERY_HIGH_CONFIDENCE = 30;
const DEFAULT_EXPIRY_HOURS = 72;
const MAX_EVIDENCE_PER_PREDICTION = 20;
const MAX_PREDICTIONS_PER_ANALYZE = 50;

// --- Valid enums ---

const VALID_TYPES = [
  "next_action", "likely_failure", "missing_prerequisite",
  "relevant_context", "incident_recurrence", "workflow_opportunity",
  "stale_or_contradicted"
];
const VALID_STATUSES = ["active", "expired", "superseded", "dismissed", "confirmed", "did_not_occur"];
const VALID_FEEDBACK = ["useful", "not_useful", "incorrect", "already_known", "acted_on", "dismissed"];
const VALID_OUTCOMES = ["confirmed", "did_not_occur", "action_succeeded", "action_failed", "expired", "superseded", "unresolved"];
const VALID_TIME_HORIZONS = ["current_task", "current_session", "days_7", "days_30", "open_ended"];

// --- Schema management ---

function ensureSchema() {
  const db = dbStore.getDb();
  try {
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
        rule_version TEXT NOT NULL DEFAULT '${RULE_VERSION}',
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

      INSERT OR IGNORE INTO prediction_rules (rule_version, name, description, enabled, config_json)
        VALUES ('${RULE_VERSION}', '${RULE_VERSION}', 'Initial prediction rules', 1, '{}');
    `);
  } catch (e) {
    // Tables may already exist
  }
}

// --- Utilities ---

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function nowIso() {
  return new Date().toISOString();
}

function makeFingerprint(type, subject, project) {
  const raw = [type, subject || "", project || ""].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
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

// --- Database CRUD ---

function insertPrediction(pred) {
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO predictions (id, type, subject, explanation, project, session_id, task_id,
      time_horizon, probability, confidence, score_breakdown_json, recommended_action_json,
      status, fingerprint, rule_version, observation_count, created_at, expires_at, updated_at,
      legacy, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pred.id, pred.type, pred.subject, pred.explanation,
    pred.project || null, pred.session_id || null, pred.task_id || null,
    pred.time_horizon || "open_ended", pred.probability || 0.5, pred.confidence || "low",
    JSON.stringify(pred.score_breakdown || {}),
    pred.recommended_action ? JSON.stringify(pred.recommended_action) : null,
    pred.status || "active", pred.fingerprint || null,
    pred.rule_version || RULE_VERSION, pred.observation_count || 0,
    pred.created_at || nowIso(), pred.expires_at || null,
    pred.updated_at || nowIso(), pred.legacy ? 1 : 0, 1
  );
}

function insertEvidence(ev) {
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO prediction_evidence (id, prediction_id, source_type, source_id, source_timestamp, summary, safe_metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ev.id, ev.prediction_id, ev.source_type, ev.source_id || null,
    ev.source_timestamp || null, ev.summary,
    JSON.stringify(ev.safe_metadata || {}),
    ev.created_at || nowIso()
  );
}

function insertFeedback(fb) {
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO prediction_feedback (prediction_id, feedback, project, rule_version, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(fb.prediction_id, fb.feedback, fb.project || null, fb.rule_version || RULE_VERSION, nowIso());
}

function insertAudit(eventType, predictionId, details) {
  const db = dbStore.getDb();
  db.prepare(`
    INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(eventType, predictionId || null, JSON.stringify(details || {}), nowIso());
}

function getPrediction(id) {
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM predictions WHERE id = ?").get(id);
  if (!row) return null;
  return normalizePrediction(row);
}

function normalizePrediction(row) {
  return {
    ...row,
    score_breakdown: parseJson(row.score_breakdown_json, {}),
    recommended_action: parseJson(row.recommended_action_json, null),
    legacy: !!row.legacy,
    enabled: !!row.enabled
  };
}

function getPredictionEvidence(predictionId) {
  const db = dbStore.getDb();
  return db.prepare("SELECT * FROM prediction_evidence WHERE prediction_id = ? ORDER BY created_at ASC").all(predictionId).map(r => ({
    ...r,
    safe_metadata: parseJson(r.safe_metadata_json, {})
  }));
}

function getPredictionFeedback(predictionId) {
  const db = dbStore.getDb();
  return db.prepare("SELECT * FROM prediction_feedback WHERE prediction_id = ? ORDER BY created_at ASC").all(predictionId);
}

function findActiveByFingerprint(fingerprint) {
  const db = dbStore.getDb();
  const row = db.prepare("SELECT * FROM predictions WHERE fingerprint = ? AND status = 'active' AND enabled = 1").get(fingerprint);
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

function expireOldPredictions() {
  const db = dbStore.getDb();
  const now = nowIso();
  const rows = db.prepare(
    "SELECT id FROM predictions WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?"
  ).all(now);
  const stmt = db.prepare("UPDATE predictions SET status = 'expired', updated_at = ? WHERE id = ?");
  for (const row of rows) {
    stmt.run(now, row.id);
    insertAudit("expired", row.id, { reason: "time_horizon_passed" });
  }
  return rows.length;
}

function feedbackWeight(project, ruleVersion) {
  const db = dbStore.getDb();
  const row = db.prepare(
    "SELECT feedback, COUNT(*) as cnt FROM prediction_feedback WHERE project = ? AND rule_version = ? GROUP BY feedback"
  ).all(project || "%", ruleVersion || RULE_VERSION);
  const weights = { useful: 0.1, not_useful: -0.1, incorrect: -0.2, already_known: -0.05, acted_on: 0.05, dismissed: -0.05 };
  let adjustment = 0;
  for (const r of row) {
    adjustment += (weights[r.feedback] || 0) * Math.min(r.cnt, 10);
  }
  return Math.max(Math.min(adjustment, 0.3), -0.3);
}

// --- Context builder ---

function buildAnalysisContext(options) {
  const db = dbStore.getDb();
  const maxAge = options.maxAge || "7d";
  const sinceDate = new Date();
  if (maxAge.endsWith("d")) {
    sinceDate.setDate(sinceDate.getDate() - parseInt(maxAge));
  } else if (maxAge.endsWith("h")) {
    sinceDate.setHours(sinceDate.getHours() - parseInt(maxAge));
  } else {
    sinceDate.setDate(sinceDate.getDate() - 7);
  }
  const since = sinceDate.toISOString();

  const ctx = {
    project: options.project || null,
    session_id: options.session_id || null,
    task_id: options.task_id || null,
    now: nowIso(),
    since,
    maxAge,
    db,

    // Tool logs
    toolLogs: [],
    // Memories
    memories: [],
    // Handoffs
    handoffs: [],
    // Black box incidents
    incidents: [],
    // Task sessions
    sessions: [],
    // Generated capabilities (evolve)
    capabilities: [],
    // Existing active predictions
    activePredictions: [],
    // Feedback history
    feedbackHistory: [],
  };

  try {
    const where = ["timestamp > ?"];
    const params = [since];
    if (options.project) { where.push("project = ?"); params.push(options.project); }
    ctx.toolLogs = db.prepare(
      `SELECT * FROM tool_logs WHERE ${where.join(" AND ")} ORDER BY timestamp DESC LIMIT 500`
    ).all(...params);
  } catch {}

  try {
    const mParams = [since];
    let mWhere = "updated_at > ?";
    if (options.project) { mWhere += " AND project = ?"; mParams.push(options.project); }
    ctx.memories = db.prepare(
      `SELECT * FROM memories WHERE ${mWhere} AND enabled = 1 AND state = 'active' ORDER BY updated_at DESC LIMIT 100`
    ).all(...mParams);
  } catch {}

  try {
    const hParams = [];
    let hWhere = "1=1";
    if (options.project) { hWhere += " AND project = ?"; hParams.push(options.project); }
    ctx.handoffs = db.prepare(
      `SELECT * FROM memory_handoffs WHERE ${hWhere} ORDER BY updated_at DESC LIMIT 20`
    ).all(...hParams);
  } catch {}

  try {
    const iParams = [];
    let iWhere = "1=1";
    if (options.project) { iWhere += " AND project = ?"; iParams.push(options.project); }
    ctx.incidents = db.prepare(
      `SELECT * FROM blackbox_incidents WHERE ${iWhere} ORDER BY created_at DESC LIMIT 20`
    ).all(...iParams);
  } catch {}

  try {
    const sParams = [];
    let sWhere = "1=1";
    if (options.project) { sWhere += " AND project = ?"; sParams.push(options.project); }
    ctx.sessions = db.prepare(
      `SELECT * FROM memory_task_sessions WHERE ${sWhere} ORDER BY created_at DESC LIMIT 20`
    ).all(...sParams);
  } catch {}

  try {
    ctx.capabilities = db.prepare(
      `SELECT * FROM generated_capabilities WHERE state IN ('trial','active') ORDER BY created_at DESC LIMIT 20`
    ).all();
  } catch {}

  try {
    ctx.activePredictions = db.prepare(
      `SELECT * FROM predictions WHERE status = 'active' AND enabled = 1 ORDER BY created_at DESC LIMIT ${MAX_PREDICTIONS_PER_ANALYZE}`
    ).all();
  } catch {}

  try {
    ctx.feedbackHistory = db.prepare(
      `SELECT * FROM prediction_feedback ORDER BY created_at DESC LIMIT 200`
    ).all();
  } catch {}

  return ctx;
}

// --- Detectors ---

function detectNextActions(ctx) {
  const candidates = [];
  if (ctx.toolLogs.length < MIN_OBSERVATIONS_FOR_PREDICTION) return candidates;

  // Build tool call sequences grouped by session
  const sessionTools = {};
  for (const log of ctx.toolLogs) {
    const key = log.session_id || "_global";
    if (!sessionTools[key]) sessionTools[key] = [];
    sessionTools[key].push(log);
  }

  // Find pairs: after tool A, tool B frequently follows
  const pairCounts = {};
  const pairTotal = {};

  for (const seq of Object.values(sessionTools)) {
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i].tool_name;
      const b = seq[i + 1].tool_name;
      if (a === b) continue;
      const key = `${a}|${b}`;
      pairCounts[key] = (pairCounts[key] || 0) + 1;
      pairTotal[a] = (pairTotal[a] || 0) + 1;
    }
  }

  for (const [pairKey, count] of Object.entries(pairCounts)) {
    if (count < MIN_OBSERVATIONS_FOR_PREDICTION) continue;
    const [toolA, toolB] = pairKey.split("|");
    const total = pairTotal[toolA] || 1;
    const rate = count / total;

    // Check for contradiction (B sometimes follows A, sometimes doesn't)
    const contradictionCount = Math.max(0, total - count);

    const score = calculateScore({
      baseRate: rate,
      sameProject: true,
      recentMatches: count,
      totalMatches: total,
      contradictions: contradictionCount,
      sampleSize: count
    });

    if (score.probability < 0.3) continue;

    candidates.push({
      type: "next_action",
      subject: `After ${toolA}, ${toolB} commonly follows`,
      explanation: `In ${count} observed sequences, ${toolB} followed ${toolA} (${(rate * 100).toFixed(0)}% rate).`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: count,
      time_horizon: "current_session",
      recommended_action: { tool: toolB, action: "use", risk: "read_only", requires_approval: false },
      evidence: [
        { source_type: "tool_call", source_id: null, summary: `${count} observations of ${toolA} → ${toolB} sequences` }
      ],
      fingerprint: makeFingerprint("next_action", `${toolA}→${toolB}`, ctx.project)
    });
  }

  return candidates.sort((a, b) => b.probability - a.probability).slice(0, 10);
}

function detectLikelyFailures(ctx) {
  const candidates = [];
  if (ctx.toolLogs.length < 2) return candidates;

  // Group failures by tool + error category
  const failures = ctx.toolLogs.filter(l => !l.ok);
  if (failures.length === 0) return candidates;

  const failGroups = {};
  for (const log of failures) {
    const key = `${log.tool_name}|${log.error_category || "unknown"}`;
    if (!failGroups[key]) failGroups[key] = [];
    failGroups[key].push(log);
  }

  const toolTotal = {};
  for (const log of ctx.toolLogs) {
    toolTotal[log.tool_name] = (toolTotal[log.tool_name] || 0) + 1;
  }

  for (const [groupKey, fails] of Object.entries(failGroups)) {
    if (fails.length < 2) continue;
    const [tool, errCat] = groupKey.split("|");
    const total = toolTotal[tool] || fails.length;
    const rate = fails.length / total;

    const score = calculateScore({
      baseRate: rate,
      sameProject: true,
      totalMatches: total,
      contradictions: total - fails.length,
      sampleSize: fails.length
    });

    const recentFail = fails[0];
    candidates.push({
      type: "likely_failure",
      subject: `${tool} has ${fails.length} ${errCat} failures`,
      explanation: `${tool} failed ${fails.length} times with category "${errCat}" out of ${total} calls (${(rate * 100).toFixed(0)}% failure rate).`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: fails.length,
      time_horizon: "current_task",
      recommended_action: { tool: tool, action: "inspect", risk: "read_only", requires_approval: false },
      evidence: fails.slice(0, 5).map(f => ({
        source_type: "tool_call",
        source_id: f.id ? String(f.id) : null,
        source_timestamp: f.timestamp,
        summary: redactSensitive(f.result_summary || f.summary || `Failed ${tool} call`).slice(0, 200)
      })),
      fingerprint: makeFingerprint("likely_failure", `${tool}:${errCat}`, ctx.project)
    });
  }

  return candidates.sort((a, b) => b.probability - a.probability).slice(0, 10);
}

function detectMissingPrerequisites(ctx) {
  const candidates = [];
  if (ctx.toolLogs.length < MIN_OBSERVATIONS_FOR_PREDICTION) return candidates;

  // Look for tools that always fail first, then succeed after another tool is called
  const sessionTools = {};
  for (const log of ctx.toolLogs) {
    const key = log.session_id || "_global";
    if (!sessionTools[key]) sessionTools[key] = [];
    sessionTools[key].push(log);
  }

  const prereqPairs = {};

  for (const seq of Object.values(sessionTools)) {
    for (let i = 0; i < seq.length - 1; i++) {
      if (!seq[i].ok && seq[i + 1].ok && seq[i].tool_name !== seq[i + 1].tool_name) {
        const key = `${seq[i + 1].tool_name}|${seq[i].tool_name}`;
        prereqPairs[key] = (prereqPairs[key] || 0) + 1;
      }
    }
  }

  for (const [pairKey, count] of Object.entries(prereqPairs)) {
    if (count < MIN_OBSERVATIONS_FOR_PREDICTION) continue;
    const [prereq, failed] = pairKey.split("|");

    const score = calculateScore({
      baseRate: 0.8,
      sameProject: true,
      sampleSize: count,
      totalMatches: count
    });

    candidates.push({
      type: "missing_prerequisite",
      subject: `${failed} may require ${prereq} first`,
      explanation: `${failed} failed ${count} times before ${prereq} was called successfully.`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: count,
      time_horizon: "current_task",
      recommended_action: { tool: prereq, action: "run_first", risk: "read_only", requires_approval: false },
      evidence: [
        { source_type: "tool_call", source_id: null, summary: `${count} instances of ${failed} failing before ${prereq}` }
      ],
      fingerprint: makeFingerprint("missing_prerequisite", `${failed}:${prereq}`, ctx.project)
    });
  }

  return candidates.sort((a, b) => b.probability - a.probability).slice(0, 5);
}

function detectRelevantContext(ctx) {
  const candidates = [];
  if (ctx.memories.length === 0 && ctx.handoffs.length === 0) return candidates;

  // Score memories by relevance
  for (const mem of ctx.memories.slice(0, 30)) {
    const score = calculateScore({
      baseRate: mem.confidence || 0.5,
      sameProject: ctx.project && mem.project === ctx.project,
      sampleSize: mem.times_confirmed || 1,
      totalMatches: mem.times_confirmed || 1,
      recentMatches: 1
    });

    candidates.push({
      type: "relevant_context",
      subject: mem.summary || mem.content.slice(0, 80),
      explanation: `Memory (${mem.type}, confidence ${(score.probability * 100).toFixed(0)}%) — ${mem.content.slice(0, 150)}`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: mem.times_confirmed || 1,
      time_horizon: "open_ended",
      evidence: [
        { source_type: "memory", source_id: mem.id, summary: (mem.summary || mem.content).slice(0, 200) }
      ],
      fingerprint: makeFingerprint("relevant_context", mem.id, mem.project)
    });
  }

  // Score handoffs
  for (const ho of ctx.handoffs.slice(0, 10)) {
    const score = calculateScore({
      baseRate: 0.6,
      sameProject: ctx.project && ho.project === ctx.project,
      sampleSize: ho.version || 1,
      totalMatches: ho.version || 1
    });

    candidates.push({
      type: "relevant_context",
      subject: ho.title || "Unnamed handoff",
      explanation: `Handoff v${ho.version || 1} — may contain relevant prior decisions and context.`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: ho.version || 1,
      time_horizon: "open_ended",
      evidence: [
        { source_type: "handoff", source_id: ho.id, summary: (ho.title || "handoff").slice(0, 200) }
      ],
      fingerprint: makeFingerprint("relevant_context", `handoff:${ho.id}`, ho.project)
    });
  }

  return candidates.sort((a, b) => b.probability - a.probability).slice(0, 10);
}

function detectIncidentRecurrence(ctx) {
  const candidates = [];
  if (ctx.incidents.length === 0) return candidates;

  // Group incidents by title/project
  const groups = {};
  for (const inc of ctx.incidents) {
    const key = `${(inc.title || "").slice(0, 50)}|${inc.project || ""}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(inc);
  }

  for (const [groupKey, incidents] of Object.entries(groups)) {
    if (incidents.length < 2) continue;
    const [title, project] = groupKey.split("|");

    const score = calculateScore({
      baseRate: 0.7,
      sameProject: ctx.project && project === ctx.project,
      sampleSize: incidents.length,
      totalMatches: incidents.length
    });

    const latest = incidents[0];
    candidates.push({
      type: "incident_recurrence",
      subject: `Incident pattern: ${title}`,
      explanation: `${incidents.length} similar incidents recorded. Recurrence risk: ${(score.probability * 100).toFixed(0)}%.`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: incidents.length,
      time_horizon: "days_7",
      recommended_action: { tool: "sidekick_black_box", action: "get_incident", risk: "read_only", requires_approval: false },
      evidence: incidents.slice(0, 5).map(inc => ({
        source_type: "incident",
        source_id: inc.id,
        source_timestamp: inc.created_at,
        summary: `${inc.title} (${inc.lifecycle_state})`
      })),
      fingerprint: makeFingerprint("incident_recurrence", title, project)
    });
  }

  return candidates.sort((a, b) => b.probability - a.probability).slice(0, 5);
}

function detectWorkflowOpportunities(ctx) {
  const candidates = [];
  if (ctx.toolLogs.length < MIN_OBSERVATIONS_FOR_PREDICTION * 2) return candidates;

  // Find repeated successful tool sequences (3+ tools)
  const sessionTools = {};
  for (const log of ctx.toolLogs) {
    if (!log.ok) continue;
    const key = log.session_id || "_global";
    if (!sessionTools[key]) sessionTools[key] = [];
    sessionTools[key].push(log);
  }

  const seqCounts = {};
  for (const seq of Object.values(sessionTools)) {
    if (seq.length < 3) continue;
    // Extract sequences of 3 consecutive tools
    for (let i = 0; i <= seq.length - 3; i++) {
      const sig = seq.slice(i, i + 3).map(s => s.tool_name).join("→");
      seqCounts[sig] = (seqCounts[sig] || 0) + 1;
    }
  }

  for (const [seq, count] of Object.entries(seqCounts)) {
    if (count < MIN_OBSERVATIONS_FOR_PREDICTION) continue;

    // Check if an Evolve candidate already exists
    const tools = seq.split("→");
    const hasEvolveCandidate = ctx.capabilities.some(cap => {
      const capSteps = parseJson(cap.steps_json, []);
      const capTools = capSteps.map(s => s.tool_name).filter(Boolean);
      return tools.every(t => capTools.includes(t));
    });

    const score = calculateScore({
      baseRate: 0.65,
      sameProject: true,
      sampleSize: count,
      totalMatches: count
    });

    candidates.push({
      type: "workflow_opportunity",
      subject: `Repeated sequence: ${seq}`,
      explanation: `Sequence ${seq} observed ${count} times successfully.${hasEvolveCandidate ? " An Evolve candidate already exists." : " No Evolve candidate found."}`,
      probability: score.probability,
      confidence: score.confidence,
      score_breakdown: score.breakdown,
      observation_count: count,
      time_horizon: "open_ended",
      recommended_action: hasEvolveCandidate
        ? { tool: "sidekick_evolve", action: "inspect", risk: "read_only", requires_approval: false }
        : { tool: "sidekick_evolve", action: "analyze", risk: "read_only", requires_approval: false },
      evidence: [
        { source_type: "tool_call", source_id: null, summary: `${count} successful ${seq} sequences` },
        ...(hasEvolveCandidate ? [{ source_type: "evolve", source_id: null, summary: "Similar Evolve candidate exists" }] : [])
      ],
      fingerprint: makeFingerprint("workflow_opportunity", seq, ctx.project)
    });
  }

  return candidates.sort((a, b) => b.probability - a.probability).slice(0, 5);
}

function detectStaleOrContradicted(ctx) {
  const candidates = [];
  const now = new Date(ctx.now);

  for (const pred of ctx.activePredictions) {
    let stale = false;
    let reason = "";

    // Check expiry
    if (pred.expires_at) {
      const exp = new Date(pred.expires_at);
      if (exp < now) {
        stale = true;
        reason = `Expired at ${pred.expires_at}`;
      }
    }

    // Check if outcome was recorded
    if (pred.outcome && pred.outcome !== "unresolved") {
      stale = true;
      reason = `Outcome recorded: ${pred.outcome}`;
    }

    // Check if prediction was dismissed
    if (pred.status === "dismissed") continue;
    if (pred.status === "expired") continue;

    // Check for contradicting feedback
    const predFeedback = ctx.feedbackHistory.filter(f => f.prediction_id === pred.id);
    const negativeFeedback = predFeedback.filter(f => ["incorrect", "not_useful"].includes(f.feedback));
    if (negativeFeedback.length > predFeedback.filter(f => ["useful", "acted_on"].includes(f.feedback)).length) {
      stale = true;
      reason = `${negativeFeedback.length} negative feedback entries outweigh positive`;
    }

    if (stale) {
      candidates.push({
        type: "stale_or_contradicted",
        subject: `Prediction may be stale: ${pred.subject}`,
        explanation: reason,
        probability: 0.9,
        confidence: "high",
        score_breakdown: { reason },
        observation_count: pred.observation_count,
        time_horizon: "current_task",
        evidence: [
          { source_type: "prediction", source_id: pred.id, summary: reason }
        ],
        fingerprint: makeFingerprint("stale_or_contradicted", pred.id, pred.project)
      });
    }
  }

  return candidates.slice(0, 10);
}

// --- Main analysis orchestrator ---

function analyze(options) {
  ensureSchema();
  const start = Date.now();

  // Expire old predictions first
  const expired = expireOldPredictions();

  const ctx = buildAnalysisContext(options);

  const detectors = [
    detectNextActions,
    detectLikelyFailures,
    detectMissingPrerequisites,
    detectRelevantContext,
    detectIncidentRecurrence,
    detectWorkflowOpportunities,
    detectStaleOrContradicted,
  ];

  let allCandidates = [];
  const detectorResults = [];

  for (const detector of detectors) {
    try {
      const results = detector(ctx);
      allCandidates = allCandidates.concat(results);
      detectorResults.push({ name: detector.name, count: results.length, ok: true });
    } catch (e) {
      detectorResults.push({ name: detector.name, count: 0, ok: false, error: e.message });
    }
  }

  // Deduplicate and merge
  const created = [];
  const deduplicated = [];

  for (const candidate of allCandidates) {
    if (created.length >= MAX_PREDICTIONS_PER_ANALYZE) break;

    const existing = findActiveByFingerprint(candidate.fingerprint);
    if (existing) {
      // Update observation count and score if better
      if (candidate.observation_count > existing.observation_count) {
        updatePrediction(existing.id, {
          probability: candidate.probability,
          confidence: candidate.confidence,
          score_breakdown: candidate.score_breakdown,
          observation_count: candidate.observation_count,
          explanation: candidate.explanation,
        });
      }
      deduplicated.push(existing.id);
      continue;
    }

    // Apply feedback adjustment
    const fbWeight = feedbackWeight(ctx.project, RULE_VERSION);
    if (fbWeight !== 0) {
      candidate.probability = Math.max(0.05, Math.min(0.95, candidate.probability + fbWeight));
    }

    const pred = {
      id: generateId("pred"),
      ...candidate,
      status: "active",
      created_at: ctx.now,
      expires_at: hoursFromNow(DEFAULT_EXPIRY_HOURS),
    };

    try {
      insertPrediction(pred);
      if (candidate.evidence) {
        for (const ev of candidate.evidence.slice(0, MAX_EVIDENCE_PER_PREDICTION)) {
          insertEvidence({
            id: generateId("evi"),
            prediction_id: pred.id,
            ...ev
          });
        }
      }
      insertAudit("created", pred.id, { type: pred.type, subject: pred.subject });
      created.push(pred);
    } catch (e) {
      // Skip on insert error
    }
  }

  const duration = Date.now() - start;
  insertAudit("analyzed", null, {
    duration_ms: duration,
    tool_logs_scanned: ctx.toolLogs.length,
    memories_scanned: ctx.memories.length,
    handoffs_scanned: ctx.handoffs.length,
    incidents_scanned: ctx.incidents.length,
    candidates_generated: allCandidates.length,
    predictions_created: created.length,
    predictions_deduplicated: deduplicated.length,
    predictions_expired: expired,
    detector_results: detectorResults,
    project: ctx.project
  });

  return {
    ok: true,
    created: created.length,
    deduplicated: deduplicated.length,
    expired,
    total_active: countActivePredictions(),
    duration_ms: duration,
    detectors: detectorResults,
    predictions: created
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
  const where = ["enabled = 1"];
  const params = [];

  if (filters.status) { where.push("status = ?"); params.push(filters.status); }
  else { where.push("status = 'active'"); }
  if (filters.type) { where.push("type = ?"); params.push(filters.type); }
  if (filters.project) { where.push("project = ?"); params.push(filters.project); }
  if (filters.session_id) { where.push("session_id = ?"); params.push(filters.session_id); }
  if (filters.task_id) { where.push("task_id = ?"); params.push(filters.task_id); }
  if (filters.confidence) { where.push("confidence = ?"); params.push(filters.confidence); }

  const limit = clampLimit(filters.limit, 20, 100);

  const rows = db.prepare(
    `SELECT * FROM predictions WHERE ${where.join(" AND ")} ORDER BY probability DESC, created_at DESC LIMIT ?`
  ).all(...params, limit);

  return rows.map(normalizePrediction);
}

function recordFeedback(predictionId, feedback, project) {
  ensureSchema();
  if (!predictionId) return { ok: false, error: "prediction_id required" };
  if (!feedback || !VALID_FEEDBACK.includes(feedback)) return { ok: false, error: `feedback must be one of: ${VALID_FEEDBACK.join(", ")}` };

  const pred = getPrediction(predictionId);
  if (!pred) return { ok: false, error: `Prediction not found: ${predictionId}` };

  insertFeedback({ prediction_id: predictionId, feedback, project: project || pred.project });
  insertAudit("feedback", predictionId, { feedback });

  return { ok: true, prediction_id: predictionId, feedback };
}

function recordOutcome(predictionId, outcome) {
  ensureSchema();
  if (!predictionId) return { ok: false, error: "prediction_id required" };
  if (!outcome || !VALID_OUTCOMES.includes(outcome)) return { ok: false, error: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}` };

  const pred = getPrediction(predictionId);
  if (!pred) return { ok: false, error: `Prediction not found: ${predictionId}` };

  const newStatus = outcome === "confirmed" ? "confirmed" :
                    outcome === "did_not_occur" ? "did_not_occur" :
                    pred.status;

  updatePrediction(predictionId, { outcome, outcome_at: nowIso(), status: newStatus });
  insertAudit("outcome", predictionId, { outcome });

  return { ok: true, prediction_id: predictionId, outcome, status: newStatus };
}

function dismissPrediction(predictionId) {
  ensureSchema();
  if (!predictionId) return { ok: false, error: "prediction_id required" };

  const pred = getPrediction(predictionId);
  if (!pred) return { ok: false, error: `Prediction not found: ${predictionId}` };

  updatePrediction(predictionId, { status: "dismissed" });
  insertAudit("dismissed", predictionId, {});

  return { ok: true, prediction_id: predictionId, status: "dismissed" };
}

function engineStatus() {
  ensureSchema();
  const db = dbStore.getDb();

  const activeCount = db.prepare("SELECT COUNT(*) as cnt FROM predictions WHERE status = 'active' AND enabled = 1").get().cnt;
  const totalCount = db.prepare("SELECT COUNT(*) as cnt FROM predictions").get().cnt;
  const feedbackCount = db.prepare("SELECT COUNT(*) as cnt FROM prediction_feedback").get().cnt;
  const evidenceCount = db.prepare("SELECT COUNT(*) as cnt FROM prediction_evidence").get().cnt;

  const typeBreakdown = db.prepare(
    "SELECT type, COUNT(*) as cnt FROM predictions WHERE status = 'active' GROUP BY type"
  ).all();

  const confidenceBreakdown = db.prepare(
    "SELECT confidence, COUNT(*) as cnt FROM predictions WHERE status = 'active' GROUP BY confidence"
  ).all();

  const lastAnalysis = db.prepare(
    "SELECT created_at FROM prediction_audit WHERE event_type = 'analyzed' ORDER BY created_at DESC LIMIT 1"
  ).get();

  const recentAnalysis = db.prepare(
    "SELECT COUNT(*) as cnt FROM prediction_audit WHERE event_type = 'analyzed' AND created_at > datetime('now', '-1 hour')"
  ).get().cnt;

  const rules = db.prepare("SELECT * FROM prediction_rules ORDER BY rule_version").all();

  return {
    ok: true,
    engine: "predict-v1",
    active_predictions: activeCount,
    total_predictions: totalCount,
    total_evidence: evidenceCount,
    total_feedback: feedbackCount,
    type_breakdown: typeBreakdown,
    confidence_breakdown: confidenceBreakdown,
    last_analysis: lastAnalysis ? lastAnalysis.created_at : null,
    recent_analyses: recentAnalysis,
    rules: rules.map(r => ({ ...r, config: parseJson(r.config_json, {}) })),
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
    // Corrupt file — back up and skip
    try {
      const backupPath = PREDICT_FILE + ".corrupt." + Date.now() + ".bak";
      fs.copyFileSync(PREDICT_FILE, backupPath);
      fs.unlinkSync(PREDICT_FILE);
      insertAudit("legacy_corrupt_backup", null, { backupPath });
      return { migrated: 0, backed_up: true, corrupt: true, backupPath };
    } catch {
      return { migrated: 0, backed_up: false, corrupt: true, error: e.message };
    }
  }

  // Backup the file
  let backed_up = false;
  try {
    const backupPath = PREDICT_FILE + ".migrated." + Date.now() + ".bak";
    fs.copyFileSync(PREDICT_FILE, backupPath);
    backed_up = true;
    insertAudit("legacy_backup", null, { backupPath });
  } catch {}

  let migrated = 0;

  // Migrate predictions
  if (legacy.predictions && Array.isArray(legacy.predictions)) {
    for (const old of legacy.predictions) {
      try {
        const pred = {
          id: old.id || generateId("pred"),
          type: mapLegacyType(old.type),
          subject: old.prediction ? old.prediction.slice(0, 200) : "Legacy prediction",
          explanation: old.prediction || "Imported from legacy predict.json",
          project: old.project || null,
          probability: old.confidence || 0.5,
          confidence: old.confidence >= 0.8 ? "high" : old.confidence >= 0.5 ? "medium" : "low",
          observation_count: 1,
          time_horizon: "open_ended",
          status: "active",
          legacy: true,
          created_at: old.created || nowIso(),
          expires_at: hoursFromNow(DEFAULT_EXPIRY_HOURS * 7), // Legacy predictions get longer expiry
          fingerprint: makeFingerprint(mapLegacyType(old.type), old.prediction || "", old.project || ""),
        };
        // Check for duplicate
        const existing = findActiveByFingerprint(pred.fingerprint);
        if (!existing) {
          insertPrediction(pred);
          migrated++;
        }
      } catch {}
    }
  }

  // Migrate feedback
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
      } catch {}
    }
  }

  // Rename old file
  try {
    const archived = PREDICT_FILE + ".archived." + Date.now();
    fs.renameSync(PREDICT_FILE, archived);
  } catch {}

  insertAudit("legacy_migrated", null, { migrated });

  return { migrated, backed_up };
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
  // Exported for testing
  calculateScore,
  calculateConfidence,
  smoothScore,
  makeFingerprint,
  feedbackWeight,
  VALID_TYPES,
  VALID_STATUSES,
  VALID_FEEDBACK,
  VALID_OUTCOMES,
  VALID_TIME_HORIZONS,
  CONFIDENCE_LEVELS,
  RULE_VERSION,
  MIN_OBSERVATIONS_FOR_PREDICTION,
  DEFAULT_EXPIRY_HOURS,
};
