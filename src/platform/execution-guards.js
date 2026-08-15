function createExecutionGuards({ ensureSchema, dbStore, normalizeExecution, terminalStates, checkCapability, getExecution }) {
  function findActiveExecution(query = {}) {
    ensureSchema();
    const conditions = ["state NOT IN ('completed','partial','failed','cancelled','timed_out','rolled_back','rollback_failed')"];
    const params = [];
    if (query.operation_type) { conditions.push("operation_type = ?"); params.push(query.operation_type); }
    if (query.tool_name) { conditions.push("tool_name = ?"); params.push(query.tool_name); }
    if (query.project_id) { conditions.push("project_id = ?"); params.push(query.project_id); }
    if (query.session_id) { conditions.push("session_id = ?"); params.push(query.session_id); }
    if (query.task_id) { conditions.push("task_id = ?"); params.push(query.task_id); }
    if (query.dedupe_key) {
      conditions.push("execution_id IN (SELECT execution_id FROM platform_execution_events WHERE dedupe_key = ?)");
      params.push(query.dedupe_key);
    }
    if (query.metadata_key && query.metadata_value) {
      conditions.push("json_extract(metadata_json, ?) = ?");
      params.push(`$.${query.metadata_key}`, query.metadata_value);
    }
    return dbStore.getDb().prepare(`SELECT * FROM platform_executions WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT 10`).all(...params).map(normalizeExecution);
  }

  function platformGuard(executionId, expectedState, options = {}) {
    ensureSchema();
    if (options.capability && options.actor_id) {
      const cap = checkCapability(options.actor_id, options.capability, options.project_id);
      if (!cap) return { allowed: false, reason: "missing_capability", capability: options.capability, actor_id: options.actor_id };
    }
    if (executionId) {
      const execution = getExecution(executionId);
      if (!execution) return { allowed: false, reason: "execution_not_found", execution: null };
      if (expectedState && execution.state !== expectedState) return { allowed: false, reason: "wrong_state", expected: expectedState, actual: execution.state, execution };
      if (terminalStates.has(execution.state) && !options.allowTerminal) return { allowed: false, reason: "terminal_state", actual: execution.state, execution };
      return { allowed: true, execution };
    }
    if (options.operation_type || options.tool_name) {
      const active = findActiveExecution(options);
      if (active.length > 0 && !options.allowConcurrent) return { allowed: false, reason: "concurrent_execution", active, execution: active[0] };
      return { allowed: true, execution: null, active };
    }
    return { allowed: true, execution: null };
  }

  return { findActiveExecution, platformGuard };
}

module.exports = { createExecutionGuards };
