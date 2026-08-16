/**
 * SQLite-backed tool activity log persistence.
 */
function createToolLogStore({ db, parseJson, nowIso, maxLog }) {
  function appendToolLog(entry) {
    db.prepare(`
      INSERT INTO tool_logs (
        timestamp, tool_name, args_summary, duration_ms, success, summary, source, entry_json,
        session_id, task_id, project, args_shape_json, arg_fingerprint, error_category,
        result_summary, correlation_id, parent_id, retry, generated_procedure,
        requested_by_principal_id, actor_principal_id, acting_for_principal_id,
        approved_by_principal_id, executed_by_principal_id, provenance_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.t || nowIso(), entry.n || "unknown", entry.a || "",
      Number.isFinite(entry.d) ? Math.round(entry.d) : null,
      entry.ok ? 1 : 0, entry.s || "", entry.src || "unknown", JSON.stringify(entry),
      entry.session_id || null, entry.task_id || entry.request_id || null,
      entry.project || null, entry.args_shape ? JSON.stringify(entry.args_shape) : null,
      entry.arg_fingerprint || null, entry.error_category || null,
      entry.result_summary || entry.s || null, entry.correlation_id || null,
      entry.parent_id || null, entry.retry ? 1 : 0, entry.generated_procedure || null,
      entry.requested_by_principal_id || null, entry.actor_principal_id || null,
      entry.acting_for_principal_id || null, entry.approved_by_principal_id || null,
      entry.executed_by_principal_id || null, entry.provenance_json || "{}",
    );

    const count = db.prepare("SELECT COUNT(*) AS count FROM tool_logs").get().count;
    if (count > maxLog) {
      db.prepare(`
        DELETE FROM tool_logs WHERE id IN (
          SELECT id FROM tool_logs ORDER BY timestamp ASC, id ASC LIMIT ?
        )
      `).run(count - maxLog);
    }
  }

  function readToolLogs(limit = maxLog) {
    const rows = db.prepare("SELECT id, entry_json FROM tool_logs ORDER BY timestamp DESC, id DESC LIMIT ?").all(limit);
    return rows.map(row => ({ id: row.id, ...parseJson(row.entry_json, null) })).filter(Boolean);
  }

  function clearToolLogs() {
    db.prepare("DELETE FROM tool_logs").run();
  }

  return { appendToolLog, readToolLogs, clearToolLogs };
}

module.exports = { createToolLogStore };
