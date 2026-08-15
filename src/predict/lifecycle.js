const dbStore = require("../db");
const { normalizePrediction, findByIdentity, updatePrediction, insertAudit, nowIso } = require("./persistence");

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function applyLifecycle(candidate, pred, config) {
  const existing = findByIdentity(candidate.identity_key);
  if (!existing) return { action: "create" };
  const db = dbStore.getDb();

  if (existing.status === "active") {
    db.transaction(() => {
      updatePrediction(existing.id, {
        probability: pred.probability, confidence: pred.confidence,
        score_breakdown: pred.score_breakdown,
        observation_count: Math.max(pred.observation_count, existing.observation_count || 0),
        explanation: pred.explanation, expires_at: pred.expires_at,
        last_seen_at: pred.created_at, refresh_count: (existing.refresh_count || 0) + 1,
        lifecycle_reason: "refreshed_by_reanalysis",
      });
      insertAudit("refreshed", existing.id, { identity_key: candidate.identity_key });
    })();
    return { action: "refresh", id: existing.id };
  }

  if (existing.status === "superseded" && existing.lifecycle_reason === "contradicted_by_feedback") {
    return { action: "suppress", reason: "contradicted_by_feedback", id: existing.id };
  }

  if (existing.status === "expired" || existing.status === "superseded") {
    db.transaction(() => {
      updatePrediction(existing.id, {
        status: "active", probability: pred.probability, confidence: pred.confidence,
        score_breakdown: pred.score_breakdown,
        observation_count: Math.max(pred.observation_count, existing.observation_count || 0),
        explanation: pred.explanation, expires_at: pred.expires_at,
        last_seen_at: pred.created_at, refresh_count: (existing.refresh_count || 0) + 1,
        lifecycle_reason: `reactivated_from_${existing.status}`,
      });
      insertAudit("reactivated", existing.id, { identity_key: candidate.identity_key, from_status: existing.status });
    })();
    return { action: "reactivate", id: existing.id };
  }

  if (existing.status === "dismissed") return { action: "suppress", reason: "dismissed_by_user", id: existing.id };
  const cutoff = daysAgoIso(config.identity_cooldown_days);
  if ((existing.outcome_at || existing.updated_at || existing.created_at) > cutoff) {
    return { action: "suppress", reason: "recent_recorded_outcome", id: existing.id };
  }
  return { action: "create" };
}

function expireOldPredictions() {
  const db = dbStore.getDb();
  const now = nowIso();
  const rows = db.prepare("SELECT id FROM predictions WHERE status = 'active' AND enabled = 1 AND expires_at IS NOT NULL AND expires_at < ?").all(now);
  if (rows.length === 0) return 0;
  const ids = rows.map(r => r.id);
  const run = db.transaction(() => {
    const stmt = db.prepare("UPDATE predictions SET status = 'expired', lifecycle_reason = 'time_horizon_passed', updated_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(now, id);
    db.prepare("INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at) VALUES ('expired', NULL, ?, ?)")
      .run(JSON.stringify({ count: ids.length, reason: "time_horizon_passed", ids: ids.slice(0, 50) }), now);
  });
  run();
  return ids.length;
}

function retireContradictedPredictions(ctx) {
  const db = dbStore.getDb();
  const retired = [];
  for (const row of ctx.activePredictions) {
    const pred = normalizePrediction(row);
    if (ctx.scope.mode !== "global" && ctx.scope.project && pred.project !== ctx.scope.project) continue;
    if (ctx.scope.session_id && pred.session_id && pred.session_id !== ctx.scope.session_id) continue;
    let reason = null;
    if (pred.outcome && !["unresolved", "confirmed"].includes(pred.outcome)) reason = `outcome_recorded:${pred.outcome}`;
    if (!reason) {
      const fb = ctx.feedbackHistory.filter(f => f.prediction_id === pred.id);
      const negative = fb.filter(f => ["incorrect", "not_useful"].includes(f.feedback)).length;
      const positive = fb.filter(f => ["useful", "acted_on"].includes(f.feedback)).length;
      if (negative > 0 && negative > positive) reason = "contradicted_by_feedback";
    }
    if (!reason && pred.time_horizon === "current_session" && pred.session_id
      && ctx.scope.mode === "session" && ctx.scope.session_id
      && pred.session_id !== ctx.scope.session_id) reason = "session_scope_ended";
    if (reason) retired.push({ id: pred.id, reason });
  }
  if (retired.length === 0) return 0;
  const now = nowIso();
  const run = db.transaction(() => {
    const stmt = db.prepare("UPDATE predictions SET status = 'superseded', lifecycle_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'");
    for (const r of retired) stmt.run(r.reason, now, r.id);
    db.prepare("INSERT INTO prediction_audit (event_type, prediction_id, details_json, created_at) VALUES ('superseded', NULL, ?, ?)")
      .run(JSON.stringify({ count: retired.length, retired: retired.slice(0, 50) }), now);
  });
  run();
  return retired.length;
}

module.exports = { applyLifecycle, expireOldPredictions, retireContradictedPredictions };
