/**
 * Persistence for generated capabilities and their invocation audit trail.
 */
function createGeneratedCapabilityStore({ db, parseJson, nowIso }) {
  function fromRow(row) {
    if (!row) return null;
    const metadata = parseJson(row.metadata_json, {});
    return {
      id: row.id, name: row.name, state: row.state, title: row.title, description: row.description,
      evidence: parseJson(row.evidence_json, []), schema: parseJson(row.schema_json, null),
      parameters: parseJson(row.parameters_json, {}), steps: parseJson(row.steps_json, []), risk: row.risk,
      validation: parseJson(row.validation_json, null), approver: row.approver, version: row.version,
      activationDate: row.activation_date, useCount: row.use_count, successCount: row.success_count,
      failureCount: row.failure_count, estimatedCallsSaved: row.estimated_calls_saved, lastUsedAt: row.last_used_at,
      userFeedback: parseJson(row.user_feedback_json, []), usefulnessScore: row.usefulness_score,
      deprecationReason: row.deprecation_reason, createdAt: row.created_at, updatedAt: row.updated_at,
      ...metadata,
    };
  }

  function saveGeneratedCapability(capability) {
    const now = nowIso();
    const metadata = { ...capability };
    for (const key of [
      "id", "name", "state", "title", "description", "evidence", "schema", "parameters", "steps", "risk",
      "validation", "approver", "version", "activationDate", "useCount", "successCount", "failureCount",
      "estimatedCallsSaved", "lastUsedAt", "userFeedback", "usefulnessScore", "deprecationReason", "createdAt", "updatedAt",
    ]) delete metadata[key];
    db.prepare(`
      INSERT INTO generated_capabilities (
        id, name, state, title, description, evidence_json, schema_json, parameters_json, steps_json,
        risk, validation_json, approver, version, activation_date, use_count, success_count,
        failure_count, estimated_calls_saved, last_used_at, user_feedback_json, usefulness_score,
        deprecation_reason, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, state = excluded.state, title = excluded.title, description = excluded.description,
        evidence_json = excluded.evidence_json, schema_json = excluded.schema_json, parameters_json = excluded.parameters_json,
        steps_json = excluded.steps_json, risk = excluded.risk, validation_json = excluded.validation_json,
        approver = excluded.approver, version = excluded.version, activation_date = excluded.activation_date,
        use_count = excluded.use_count, success_count = excluded.success_count, failure_count = excluded.failure_count,
        estimated_calls_saved = excluded.estimated_calls_saved, last_used_at = excluded.last_used_at,
        user_feedback_json = excluded.user_feedback_json, usefulness_score = excluded.usefulness_score,
        deprecation_reason = excluded.deprecation_reason, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
    `).run(
      capability.id, capability.name, capability.state, capability.title || null,
      capability.description || capability.title || capability.name, JSON.stringify(capability.evidence || []),
      capability.schema ? JSON.stringify(capability.schema) : null, JSON.stringify(capability.parameters || {}),
      JSON.stringify(capability.steps || []), capability.risk || "medium", capability.validation ? JSON.stringify(capability.validation) : null,
      capability.approver || null, capability.version || 1, capability.activationDate || null,
      capability.useCount || 0, capability.successCount || 0, capability.failureCount || 0,
      capability.estimatedCallsSaved || 0, capability.lastUsedAt || null, JSON.stringify(capability.userFeedback || []),
      capability.usefulnessScore || 0, capability.deprecationReason || null, JSON.stringify(metadata),
      capability.createdAt || now, capability.updatedAt || now,
    );
  }

  function getGeneratedCapability(id) {
    return fromRow(db.prepare("SELECT * FROM generated_capabilities WHERE id = ?").get(id));
  }

  function getGeneratedCapabilityByName(name) {
    return fromRow(db.prepare("SELECT * FROM generated_capabilities WHERE name = ?").get(name));
  }

  function listGeneratedCapabilities(options = {}) {
    const states = options.states || null;
    const includeInactive = options.includeInactive !== false;
    let rows;
    if (states && states.length) {
      const placeholders = states.map(() => "?").join(",");
      rows = db.prepare(`SELECT * FROM generated_capabilities WHERE state IN (${placeholders}) ORDER BY updated_at DESC`).all(...states);
    } else if (includeInactive) {
      rows = db.prepare("SELECT * FROM generated_capabilities ORDER BY updated_at DESC").all();
    } else {
      rows = db.prepare("SELECT * FROM generated_capabilities WHERE state IN ('trial', 'active') ORDER BY updated_at DESC").all();
    }
    return rows.map(fromRow);
  }

  function appendGeneratedToolAudit(entry) {
    db.prepare(`
      INSERT INTO generated_tool_audit (capability_id, tool_name, invoked_at, success, args_summary, result_summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.capability_id, entry.tool_name, entry.invoked_at || nowIso(), entry.success ? 1 : 0,
      entry.args ? JSON.stringify(entry.args).substring(0, 500) : "", String(entry.result_summary || "").substring(0, 500));
  }

  function listGeneratedToolAudit(capabilityId, limit = 100) {
    return db.prepare("SELECT * FROM generated_tool_audit WHERE capability_id = ? ORDER BY invoked_at DESC LIMIT ?").all(capabilityId, limit);
  }

  return { saveGeneratedCapability, getGeneratedCapability, getGeneratedCapabilityByName, listGeneratedCapabilities, appendGeneratedToolAudit, listGeneratedToolAudit };
}

module.exports = { createGeneratedCapabilityStore };
