const path = require("path");

function createArtifactStore({ ensureSchema, dbStore, normalizeArtifact, nowIso, newId, json, appendEvent }) {
  function registerArtifact(input = {}) {
    ensureSchema();
    if (!input.storage_ref) throw new Error("storage_ref is required");
    const ref = path.posix.normalize(String(input.storage_ref).replace(/\\/g, "/"));
    if (ref.includes("../") || ref === ".." || path.isAbsolute(ref)) throw new Error("storage_ref must be a safe relative path or opaque storage key");
    const lineage = input.lineage && typeof input.lineage === "object" ? { ...input.lineage } : {};
    const role = lineage.role || (input.supersedes_artifact_id ? "derivative" : "original");
    if (!["original", "derivative"].includes(role)) throw new Error("artifact lineage role must be original or derivative");
    if (role === "original" && input.supersedes_artifact_id) throw new Error("original artifacts cannot supersede another artifact");
    if (role === "derivative" && !input.supersedes_artifact_id) throw new Error("derivative artifacts require supersedes_artifact_id");
    if (input.supersedes_artifact_id) { const parent = dbStore.getDb().prepare("SELECT artifact_id, deleted_at FROM platform_artifacts WHERE artifact_id = ?").get(input.supersedes_artifact_id); if (!parent) throw new Error(`Parent artifact not found: ${input.supersedes_artifact_id}`); if (parent.deleted_at) throw new Error("derivatives cannot be created from deleted artifacts"); }
    if (input.content_hash !== undefined && !/^(?:sha256:)?[a-f0-9]{64}$/i.test(String(input.content_hash))) throw new Error("content_hash must be a SHA-256 digest");
    if (input.byte_size !== undefined && (!Number.isInteger(input.byte_size) || input.byte_size < 0)) throw new Error("byte_size must be a non-negative integer");
    lineage.role = role; const id = input.artifact_id || newId("art"), ts = input.created_at || nowIso();
    dbStore.getDb().prepare("INSERT INTO platform_artifacts (artifact_id, type, name, project_id, execution_id, task_id, session_id, producer, storage_ref, content_type, byte_size, content_hash, created_at, retention_class, sensitivity, redaction_state, schema_version, lineage_json, verification_json, supersedes_artifact_id, metadata_json, owner_principal_id, created_by_principal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)").run(id, input.type || "artifact", input.name || id, input.project_id || null, input.execution_id || null, input.task_id || null, input.session_id || null, input.producer || null, ref, input.content_type || null, Number.isInteger(input.byte_size) ? input.byte_size : null, input.content_hash || null, ts, input.retention_class || "standard", input.sensitivity || "normal", input.redaction_state || "unknown", json(lineage), json(input.verification || {}), input.supersedes_artifact_id || null, json(input.metadata || {}), input.ownerPrincipalId || input.owner_principal_id || null, input.createdByPrincipalId || input.created_by_principal_id || input.actor_principal_id || null);
    if (input.execution_id) dbStore.getDb().prepare("UPDATE platform_executions SET artifact_count = artifact_count + 1, updated_at = ? WHERE execution_id = ?").run(ts, input.execution_id);
    appendEvent({ event_type: "artifact.registered", source: input.source || "platform", actor_id: input.actor_id, execution_id: input.execution_id, task_id: input.task_id, session_id: input.session_id, project_id: input.project_id, subject_type: "artifact", subject_id: id, payload: { type: input.type || "artifact", name: input.name || id, storage_ref: ref }, correlation_id: input.correlation_id });
    return getArtifact(id);
  }
  function getArtifact(id) { ensureSchema(); return normalizeArtifact(dbStore.getDb().prepare("SELECT * FROM platform_artifacts WHERE artifact_id = ?").get(String(id))); }
  function listArtifacts(query = {}) { ensureSchema(); const conditions = ["deleted_at IS NULL"], params = []; if (query.project_id) { conditions.push("project_id = ?"); params.push(String(query.project_id)); } if (query.execution_id) { conditions.push("execution_id = ?"); params.push(String(query.execution_id)); } if (query.custody_role) { if (!["original", "derivative"].includes(query.custody_role)) throw new Error("Invalid custody_role"); conditions.push("json_extract(lineage_json, '$.role') = ?"); params.push(query.custody_role); } const limit = Math.max(1, Math.min(Number(query.limit) || 50, 100)); return dbStore.getDb().prepare(`SELECT * FROM platform_artifacts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...params, limit).map(normalizeArtifact); }
  return { registerArtifact, getArtifact, listArtifacts };
}
module.exports = { createArtifactStore };
