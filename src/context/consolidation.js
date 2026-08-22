"use strict";

const crypto = require("crypto");
const { redactSensitive } = require("../redact");

function digest(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function normalize(value) { return String(value || "").toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim().slice(0, 500); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

function createConsolidator({ dbStore, db = dbStore.getDb(), now = () => Date.now() }) {
  function consolidate({ project, minObservations = 3, limit = 20 } = {}) {
    if (!project) throw new Error("consolidation_project_required");
    const rows = dbStore.searchMemories({ project, type: "all", limit: 500 }).filter(row => row.enabled !== false && !["deleted", "expired"].includes(row.state) && ["observation", "session", "problem", "pattern", "agent_task"].includes(row.type));
    const groups = new Map();
    for (const row of rows) {
      const key = normalize(row.summary || row.content);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const candidates = [];
    for (const [key, items] of groups) {
      const confirmations = items.reduce((sum, item) => sum + Math.max(1, Number(item.times_confirmed) || 1), 0);
      if (items.length < Math.max(2, Number(minObservations) || 3) && confirmations < Math.max(2, Number(minObservations) || 3)) continue;
      const sourceIds = items.map(item => item.id).slice(0, 50);
      const content = redactSensitive(items[0].summary || items[0].content).slice(0, 1000);
      const fingerprint = digest(`${project}|procedure|${key}`);
      const id = `cc_${fingerprint.slice(0, 24)}`;
      const ts = new Date(now()).toISOString();
      db.prepare("INSERT INTO memory_consolidation_candidates (id, project, memory_type, content, source_memory_ids_json, provenance_json, confidence, status, validation_status, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', 'unvalidated', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source_memory_ids_json = excluded.source_memory_ids_json, provenance_json = excluded.provenance_json, confidence = excluded.confidence, updated_at = excluded.updated_at").run(id, project, "procedure", content, JSON.stringify(sourceIds), JSON.stringify({ method: "deterministic_repetition", sourceMemoryIds: sourceIds, sourceTypes: items.map(item => item.type), confirmationCount: confirmations, generatedAt: ts }), Math.min(0.95, 0.5 + confirmations * 0.1), fingerprint, ts, ts);
      candidates.push(getCandidate(id));
      if (candidates.length >= Math.min(100, Number(limit) || 20)) break;
    }
    return candidates;
  }

  function getCandidate(id) {
    const row = db.prepare("SELECT * FROM memory_consolidation_candidates WHERE id = ?").get(id);
    if (!row) return null;
    return { id: row.id, project: row.project, memoryType: row.memory_type, content: row.content, sourceMemoryIds: parseJson(row.source_memory_ids_json, []), provenance: parseJson(row.provenance_json, {}), confidence: row.confidence, status: row.status, validationStatus: row.validation_status, createdAt: row.created_at, updatedAt: row.updated_at, promotedMemoryId: row.promoted_memory_id || null };
  }

  function promote({ id, approver, validationEvidence = null } = {}) {
    if (!id || !approver) throw new Error("candidate_id_and_approver_required");
    const candidate = getCandidate(id);
    if (!candidate) throw new Error("consolidation_candidate_not_found");
    if (candidate.status === "promoted") return candidate;
    const memory = dbStore.upsertMemory({ type: candidate.memoryType, project: candidate.project, content: candidate.content, summary: candidate.content, confidence: candidate.confidence, source: "consolidation", source_ref: candidate.id, metadata: { consolidationCandidateId: candidate.id, sourceMemoryIds: candidate.sourceMemoryIds, approvedBy: String(approver), validationEvidence: validationEvidence || null, authority: "derived_until_confirmed" }, automatic: false, requires_confirmation: true });
    const ts = new Date(now()).toISOString();
    db.prepare("UPDATE memory_consolidation_candidates SET status = 'promoted', validation_status = ?, promoted_memory_id = ?, updated_at = ? WHERE id = ? AND status = 'candidate'").run(validationEvidence ? "validated" : "approved_unvalidated", memory && memory.id || null, ts, id);
    return getCandidate(id);
  }

  return Object.freeze({ consolidate, getCandidate, promote });
}

module.exports = { createConsolidator };
