const fs = require("fs");
const path = require("path");

// Deliver a resumed approval task's terminal outcome to the durable transcript
// and platform execution ledger. Dependencies are injected so recovery stays a
// boundary module rather than importing the Agent Bridge's process state.
function createResumedTaskFinalizer({ convDir, emit, platformKernel, redactSensitive, recordAgentTaskMemory }) {
  return function finalizeResumedTask({ taskId, state, outcome, checkpoint }) {
    if (!taskId || !outcome) return { ok: false, reason: "nothing_to_record" };
    const terminalStates = { completed: "completed", failed: "failed", cancelled: "failed", timed_out: "iteration_limit" };
    const mapped = terminalStates[state];
    if (!mapped) return { ok: false, reason: "not_terminal", state };

    const transcriptPath = path.join(convDir, taskId + ".json");
    let record = {};
    try {
      record = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
    } catch {
      return { ok: false, reason: "transcript_unreadable" };
    }

    const resumedSteps = Array.isArray(outcome.steps) ? outcome.steps : [];
    const answer = state === "completed" ? String(outcome.result || "") : "";
    const failure = state === "completed" ? null : redactSensitive(String(outcome.error || outcome.code || state));
    const merged = {
      ...record,
      steps: (Array.isArray(record.steps) ? record.steps : []).concat(resumedSteps),
      status: mapped,
      result: answer,
      error: failure,
      resumed_at: new Date().toISOString(),
      brain: { ...(record.brain || {}), state, resumed: true, awaiting_approval: null, error: failure },
    };

    const temporaryTranscriptPath = `${transcriptPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryTranscriptPath, JSON.stringify(merged), { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(temporaryTranscriptPath, transcriptPath);
    } catch {
      try { fs.unlinkSync(temporaryTranscriptPath); } catch {}
      return { ok: false, reason: "transcript_unwritable" };
    }

    emit(taskId, state === "completed" ? { type: "done", text: answer } : { type: "error", text: failure });
    const executionId = checkpoint && checkpoint.platform_execution_id;
    try {
      if (executionId) {
        platformKernel.appendEvent({
          execution_id: executionId,
          root_execution_id: checkpoint.root_execution_id || null,
          task_id: taskId,
          event_type: state === "completed" ? "brain.resumed_completed" : "brain.resumed_failed",
          payload: { state, evidence_count: outcome.evidenceCount || 0 },
          severity: state === "completed" ? "info" : "error",
          source: "agent",
          actor_id: "task-runner",
        });
      }
    } catch {}

    const terminalState = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : state === "timed_out" ? "timed_out" : "failed";
    try {
      if (executionId) {
        platformKernel.transitionExecution(executionId, terminalState, {
          source: "agent",
          actor_id: "task-runner",
          result_status: state === "completed" ? "success" : terminalState,
          result_summary: state === "completed" ? answer : (failure || terminalState),
          reason: state === "completed" ? "resumed task completed" : (failure || terminalState),
          error_category: state === "completed" ? null : terminalState,
        });
      }
    } catch {}

    if (state === "completed") {
      try { recordAgentTaskMemory({ goal: record.goal, steps: merged.steps, taskId, status: "completed" }); } catch {}
    }
    return { ok: true, taskId, status: mapped };
  };
}

module.exports = { createResumedTaskFinalizer };
