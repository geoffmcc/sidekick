const crypto = require("crypto");
const dbStore = require("../db");
const { ensureSchema, RULE_VERSION } = require("./schema");

const HORIZON_EXPIRY_HOURS = {
  current_task: 4,
  current_session: 12,
  days_7: 24 * 7,
  days_30: 24 * 30,
  open_ended: null,
};
const MAX_EVIDENCE_PER_PREDICTION = 20;

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
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

function getPrediction(id) {
  ensureSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM predictions WHERE id = ?").get(id);
  return row ? normalizePrediction(row) : null;
}

function getPredictionEvidence(predictionId) {
  ensureSchema();
  return dbStore.getDb().prepare("SELECT * FROM prediction_evidence WHERE prediction_id = ? ORDER BY created_at ASC").all(predictionId).map(r => ({
    ...r,
    safe_metadata: parseJson(r.safe_metadata_json, {})
  }));
}

function getPredictionFeedback(predictionId) {
  ensureSchema();
  return dbStore.getDb().prepare("SELECT * FROM prediction_feedback WHERE prediction_id = ? ORDER BY created_at ASC").all(predictionId);
}

function findActiveByFingerprint(fingerprint) {
  ensureSchema();
  const row = dbStore.getDb().prepare("SELECT * FROM predictions WHERE fingerprint = ? AND status = 'active' AND enabled = 1").get(fingerprint);
  return row ? normalizePrediction(row) : null;
}

function findByIdentity(identityKey) {
  const row = dbStore.getDb().prepare(
    "SELECT * FROM predictions WHERE identity_key = ? ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1"
  ).get(identityKey);
  return row ? normalizePrediction(row) : null;
}

function updatePrediction(id, patch) {
  const db = dbStore.getDb();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (["score_breakdown_json", "recommended_action_json", "score_breakdown", "recommended_action"].includes(k)) {
      const dbKey = k === "score_breakdown" ? "score_breakdown_json" : k === "recommended_action" ? "recommended_action_json" : k;
      sets.push(`${dbKey} = ?`);
      vals.push(typeof v === "string" ? v : JSON.stringify(v));
    } else {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  sets.push("updated_at = ?");
  vals.push(nowIso(), id);
  db.prepare(`UPDATE predictions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

function insertAudit(eventType, predictionId, details) {
  dbStore.getDb().prepare(`
    INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(eventType, predictionId || null, JSON.stringify(details || {}), nowIso());
}

function insertFeedback(fb) {
  dbStore.getDb().prepare(`
    INSERT INTO prediction_feedback (prediction_id, feedback, project, rule_version, scope_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(fb.prediction_id, fb.feedback, fb.project || null, fb.rule_version || RULE_VERSION, fb.scope_key || null, nowIso());
}

function expiresAtForHorizon(horizon) {
  const hours = HORIZON_EXPIRY_HOURS[horizon];
  return hours === null || hours === undefined ? null : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

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
      JSON.stringify(pred.score_breakdown || {}), pred.recommended_action ? JSON.stringify(pred.recommended_action) : null,
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
      evStmt.run(generateId("evi"), pred.id, ev.source_type, ev.source_id || null,
        ev.source_timestamp || null, ev.summary, JSON.stringify(ev.safe_metadata || {}), pred.created_at);
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

module.exports = {
  normalizePrediction, getPrediction, getPredictionEvidence, getPredictionFeedback,
  findActiveByFingerprint, findByIdentity, updatePrediction, insertAudit, insertFeedback,
  expiresAtForHorizon, persistPrediction, isUniqueViolation, nowIso,
};
