"use strict";

const dbDefault = require("../db");

const STATES = Object.freeze(["created", "ready", "running", "waiting", "paused", "interrupted", "partial", "completed", "failed", "cancelled", "timed_out", "blocked"]);
const TERMINAL = new Set(["partial", "completed", "failed", "cancelled", "timed_out", "blocked"]);

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function getTableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    const columns = new Set(rows.map(row => row.name).filter(Boolean));
    return columns.size ? columns : null;
  } catch {
    return null;
  }
}

function collectReliabilityMetrics({ db = dbDefault, limit = 10000 } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 1000, 10000));
  const tables = new Set(db.getTableList().map(row => row.name));
  if (!tables.has("agent_tasks")) return { schema: "sidekick.reliability.v1", available: false, reason: "agent task schema is unavailable" };
  const taskDb = db.getDb();
  const columns = getTableColumns(taskDb, "agent_tasks");
  const baseColumns = ["state", "created_at", "updated_at", "completed_at", "usage_json", "result_json", "verification_json"];
  const selectedColumns = columns ? baseColumns.filter(column => columns.has(column)) : baseColumns;
  if (columns?.has("last_error_code")) selectedColumns.push("last_error_code");
  const rows = taskDb.prepare(`SELECT ${selectedColumns.join(",")} FROM agent_tasks ORDER BY updated_at DESC LIMIT ?`).all(bounded);
  const usageSupported = !columns || columns.has("usage_json");
  const errorCodeSupported = Boolean(columns?.has("last_error_code"));
  const counts = Object.fromEntries(STATES.map(state => [state, 0]));
  let verified = 0;
  let abandoned = 0;
  let durationMs = 0;
  let durationCount = 0;
  let toolFailures = 0;
  const durations = [];
  const failureClasses = {};
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row.state)) counts[row.state]++;
    try {
      const usage = JSON.parse(row.usage_json || "{}");
      toolFailures += Math.max(0, Math.min(1000000, Number(usage.failures) || 0));
      for (const [key, value] of Object.entries({ retries: usage.retries, recovery: usage.recovery_cycles, ambiguous: usage.ambiguous_operations })) {
        if (Number(value) > 0) failureClasses[key] = (failureClasses[key] || 0) + Number(value);
      }
    } catch {}
    if (errorCodeSupported && row.last_error_code) {
      const key = String(row.last_error_code).slice(0, 80);
      failureClasses[key] = (failureClasses[key] || 0) + 1;
    }
    let verification = null;
    let result = null;
    try { verification = row.verification_json ? JSON.parse(row.verification_json) : null; } catch {}
    try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
    if (row.state === "completed" && result?.status === "verified" && verification?.status !== "failed") verified++;
    if (row.state === "abandoned") abandoned++;
    if (row.completed_at && row.created_at) {
      const elapsed = Date.parse(row.completed_at) - Date.parse(row.created_at);
      if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 86400000 * 30) { durationMs += elapsed; durationCount++; durations.push(elapsed); }
    }
  }
  const terminal = rows.filter(row => TERMINAL.has(row.state) || row.state === "abandoned").length;
  return {
    schema: "sidekick.reliability.v1",
    available: true,
    inspected: rows.length,
    counts,
     completion: { terminal, verified, failed: counts.failed, partial: counts.partial, cancelled: counts.cancelled, timed_out: counts.timed_out, blocked: counts.blocked, abandoned, verified_rate: terminal ? verified / terminal : null },
      failures: {
        tool_failures: toolFailures,
        classes: failureClasses,
        coverage: { usage_json: usageSupported, last_error_code: errorCodeSupported },
      },
     timing: {
       completed_tasks: durationCount,
       mean_completion_ms: durationCount ? Math.round(durationMs / durationCount) : null,
       p50_completion_ms: percentile(durations, 0.5),
       p95_completion_ms: percentile(durations, 0.95),
       max_completion_ms: durations.length ? Math.max(...durations) : null,
     },
  };
}

module.exports = { collectReliabilityMetrics };
