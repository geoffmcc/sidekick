"use strict";

const dbDefault = require("../db");

const STATES = Object.freeze(["completed", "partial", "failed", "cancelled", "timed_out", "blocked", "waiting", "running"]);

function collectReliabilityMetrics({ db = dbDefault, limit = 10000 } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 1000, 10000));
  const tables = new Set(db.getTableList().map(row => row.name));
  if (!tables.has("agent_tasks")) return { schema: "sidekick.reliability.v1", available: false, reason: "agent task schema is unavailable" };
  const rows = db.getDb().prepare("SELECT state,created_at,updated_at,completed_at,usage_json FROM agent_tasks ORDER BY updated_at DESC LIMIT ?").all(bounded);
  const counts = Object.fromEntries(STATES.map(state => [state, 0]));
  let verified = 0;
  let durationMs = 0;
  let durationCount = 0;
  let toolFailures = 0;
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row.state)) counts[row.state]++;
    try {
      const usage = JSON.parse(row.usage_json || "{}");
      toolFailures += Math.max(0, Math.min(1000000, Number(usage.failures) || 0));
    } catch {}
    if (row.state === "completed") verified++;
    if (row.completed_at && row.created_at) {
      const elapsed = Date.parse(row.completed_at) - Date.parse(row.created_at);
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 86400000 * 30) { durationMs += elapsed; durationCount++; }
    }
  }
  const terminal = counts.completed + counts.partial + counts.failed + counts.cancelled + counts.timed_out;
  return {
    schema: "sidekick.reliability.v1",
    available: true,
    inspected: rows.length,
    counts,
    completion: { terminal, verified, failed: counts.failed, partial: counts.partial, cancelled: counts.cancelled, timed_out: counts.timed_out, verified_rate: terminal ? verified / terminal : null },
    failures: { tool_failures: toolFailures },
    timing: { completed_tasks: durationCount, mean_completion_ms: durationCount ? Math.round(durationMs / durationCount) : null },
  };
}

module.exports = { collectReliabilityMetrics };
