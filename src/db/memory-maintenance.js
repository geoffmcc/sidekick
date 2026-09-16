"use strict";

// Project-scoped, bounded memory hygiene.  Planning is deliberately separate
// from mutation so callers can obtain an auditable deterministic preview.
function createMemoryMaintenance({ db, hasTable, nowIso, stableId, auditMemoryEvent }) {
  const MAX_CANDIDATES = 500;
  const PROTECTED_TYPES = new Set(["fact", "decision", "procedure", "open_thread"]);

  function requireProject(project) {
    if (!project || !String(project).trim()) throw new Error("memory maintenance requires an explicit project");
    return String(project).trim();
  }
  function protectedMemory(row) {
    return PROTECTED_TYPES.has(row.type) || row.requires_confirmation === 1 || row.times_confirmed > 0 || row.pinned === 1;
  }
  function score(row) {
    return Number(row.confidence || 0) * 1000000 + Number(row.times_confirmed || 0) * 1000
      + Number(row.source_authority || 0) * 10 + Date.parse(row.updated_at || row.created_at || 0) / 1e12;
  }
  function keyFor(row) {
    // Fingerprints are producer-defined identity.  Fall back to normalized
    // exact content only; maintenance must not make fuzzy semantic guesses.
    return row.fingerprint || `${row.type}\u0000${String(row.content || "").trim().toLowerCase().replace(/\s+/g, " ")}`;
  }
  function plan({ project, maxCandidates = 100, handoffRetentionDays = 30 } = {}) {
    project = requireProject(project);
    const limit = Math.max(1, Math.min(Number(maxCandidates) || 100, MAX_CANDIDATES));
    const active = hasTable("memories") ? db.prepare(`SELECT * FROM memories WHERE project = ? AND enabled = 1 AND COALESCE(current, 1) = 1 AND state = 'active' ORDER BY id ASC`).all(project) : [];
    const groups = new Map();
    for (const row of active) {
      if (protectedMemory(row)) continue;
      const key = keyFor(row);
      if (!key || key.endsWith("\u0000")) continue;
      const group = groups.get(key) || [];
      group.push(row); groups.set(key, group);
    }
    const memoryCandidates = [];
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      rows.sort((a, b) => score(b) - score(a) || String(a.id).localeCompare(String(b.id)));
      memoryCandidates.push({ retain_id: rows[0].id, duplicate_ids: rows.slice(1).map(row => row.id) });
    }
    memoryCandidates.sort((a, b) => a.retain_id.localeCompare(b.retain_id));
    const cutoff = new Date(Date.now() - Math.max(0, Number(handoffRetentionDays) || 0) * 86400000).toISOString();
    const handoffCandidates = hasTable("memory_handoff_versions") ? db.prepare(`
      SELECT v.handoff_id, v.version, v.content_hash, v.created_at
      FROM memory_handoff_versions v JOIN memory_handoffs h ON h.id = v.handoff_id
      WHERE h.project = ? AND v.created_at < ?
        AND EXISTS (SELECT 1 FROM memory_handoff_versions newer WHERE newer.handoff_id = v.handoff_id AND newer.content_hash = v.content_hash AND newer.version > v.version)
      ORDER BY v.handoff_id, v.version
    `).all(project, cutoff).map(row => ({ handoff_id: row.handoff_id, version: row.version, content_hash: row.content_hash })) : [];
    const flattened = memoryCandidates.reduce((n, item) => n + item.duplicate_ids.length, 0) + handoffCandidates.length;
    if (flattened > limit) throw new Error(`maintenance candidate limit exceeded: ${flattened} > ${limit}`);
    return { project, policy: { max_candidates: limit, handoff_retention_days: Math.max(0, Number(handoffRetentionDays) || 0), protected_types: Array.from(PROTECTED_TYPES) }, before: { active_memories: active.length }, candidates: { memories: memoryCandidates, handoff_versions: handoffCandidates }, candidate_count: flattened };
  }
  function saveRun(planValue, state = "previewed", result = null) {
    if (!hasTable("memory_maintenance_runs")) throw new Error("memory maintenance storage is unavailable; run migrations");
    const id = stableId("mm", `${planValue.project}|${JSON.stringify(planValue.candidates)}|${JSON.stringify(planValue.policy)}`);
    db.prepare(`INSERT INTO memory_maintenance_runs (id, project, state, plan_json, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, result_json = excluded.result_json, updated_at = excluded.updated_at`
    ).run(id, planValue.project, state, JSON.stringify(planValue), result ? JSON.stringify(result) : null, nowIso(), nowIso());
    return id;
  }
  function preview(options) { const value = plan(options); const run_id = saveRun(value); return { run_id, state: "previewed", ...value }; }
  function getRun(runId) {
    if (!hasTable("memory_maintenance_runs")) return null;
    const row = db.prepare("SELECT * FROM memory_maintenance_runs WHERE id = ?").get(runId);
    if (!row) return null;
    return { run_id: row.id, project: row.project, state: row.state, plan: JSON.parse(row.plan_json), result: row.result_json ? JSON.parse(row.result_json) : null, created_at: row.created_at, updated_at: row.updated_at };
  }
  function cancel(runId) {
    const run = getRun(runId); if (!run) throw new Error("maintenance run not found");
    if (run.state === "applied") return run;
    db.prepare("UPDATE memory_maintenance_runs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), runId);
    return getRun(runId);
  }
  function apply(runId, { purgeHandoffVersions = false, purgeApproved = false, actor = "system", maxExecutionMs = 5000 } = {}) {
    const run = getRun(runId); if (!run) throw new Error("maintenance run not found");
    if (run.state === "applied") return { ...run.result, idempotent: true };
    if (run.state === "cancelled") throw new Error("maintenance run is cancelled; preview again before applying");
    if (purgeHandoffVersions && !purgeApproved) throw new Error("purging handoff versions requires explicit purge_approved approval");
    const started = Date.now(), planValue = run.plan;
    const mutations = { soft_deleted_memory_ids: [], purged_handoff_versions: [], skipped_handoff_versions: [] };
    try {
      db.transaction(() => {
        for (const candidate of planValue.candidates.memories) {
          if (Date.now() - started > maxExecutionMs) throw new Error("maintenance execution time limit exceeded");
          for (const id of candidate.duplicate_ids) {
            const changed = db.prepare(`UPDATE memories SET enabled = 0, current = 0, state = 'superseded', supersedes_id = ?, updated_at = ?, metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.maintenance_run', ?)
              WHERE id = ? AND project = ? AND enabled = 1 AND COALESCE(current, 1) = 1 AND state = 'active'`).run(candidate.retain_id, nowIso(), runId, id, planValue.project).changes;
            if (changed) mutations.soft_deleted_memory_ids.push(id);
          }
        }
        for (const candidate of planValue.candidates.handoff_versions) {
          if (!purgeHandoffVersions) { mutations.skipped_handoff_versions.push(candidate); continue; }
          if (Date.now() - started > maxExecutionMs) throw new Error("maintenance execution time limit exceeded");
          db.prepare("DELETE FROM memory_handoff_links WHERE handoff_id = ? AND version = ?").run(candidate.handoff_id, candidate.version);
          if (db.prepare("DELETE FROM memory_handoff_versions WHERE handoff_id = ? AND version = ?").run(candidate.handoff_id, candidate.version).changes) mutations.purged_handoff_versions.push(candidate);
        }
      })();
    } catch (error) {
      const failure = { run_id: runId, project: planValue.project, policy: planValue.policy, candidates: planValue.candidates, error: String(error.message || error), elapsed_ms: Date.now() - started };
      saveRun(planValue, "failed", failure);
      auditMemoryEvent("memory_maintenance_failed", "memory_maintenance", runId, failure, actor);
      throw error;
    }
    const result = { run_id: runId, project: planValue.project, policy: planValue.policy, before: planValue.before, after: { active_memories: Math.max(0, planValue.before.active_memories - mutations.soft_deleted_memory_ids.length) }, candidates: planValue.candidates, mutations, elapsed_ms: Date.now() - started };
    saveRun(planValue, "applied", result);
    auditMemoryEvent("memory_maintenance_applied", "memory_maintenance", runId, result, actor);
    return result;
  }
  return { preview, apply, getRun, cancel, MAX_CANDIDATES };
}

module.exports = { createMemoryMaintenance };
