/**
 * Converts generated execution database rows into the public data shape.
 */
function createGeneratedExecutionRowMappers(parseJson) {
  function executionFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      capabilityId: row.capability_id,
      toolName: row.tool_name,
      state: row.state,
      source: row.source,
      args: parseJson(row.args_json, {}),
      successCriteria: row.success_criteria,
      successCriteriaSatisfied: row.success_criteria_satisfied === null || row.success_criteria_satisfied === undefined ? null : Boolean(row.success_criteria_satisfied),
      finalSummary: row.final_summary,
      errorCategory: row.error_category,
      cancelRequested: Boolean(row.cancel_requested),
      timeoutMs: row.timeout_ms,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      steps: [],
    };
  }

  function executionStepFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      executionId: row.execution_id,
      stepNumber: row.step_number,
      toolName: row.tool_name,
      state: row.state,
      args: parseJson(row.args_json, {}),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      resultSummary: row.result_summary,
      retryCount: row.retry_count || 0,
      errorCategory: row.error_category,
      success: row.success === null || row.success === undefined ? null : Boolean(row.success),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return { executionFromRow, executionStepFromRow };
}

module.exports = { createGeneratedExecutionRowMappers };
