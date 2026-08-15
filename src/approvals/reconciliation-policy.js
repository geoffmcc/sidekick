const RECONCILIATION_SPEC = Object.freeze({
  confirm_executed: { approvalStatus: "completed", stepStatus: "completed", outcome: "reconciled_executed", checkpointState: "runnable", clearBinding: true, recordStep: true, refreshExpiry: false },
  confirm_not_executed: { approvalStatus: "retry_authorized", stepStatus: null, outcome: null, checkpointState: "runnable", clearBinding: false, recordStep: false, refreshExpiry: true },
  abandon_step: { approvalStatus: "superseded", stepStatus: "refused", outcome: "reconciliation_abandoned", checkpointState: "runnable", clearBinding: true, recordStep: true, refreshExpiry: false },
  fail_task: { approvalStatus: "superseded", stepStatus: "refused", outcome: "reconciliation_failed", checkpointState: "failed", clearBinding: true, recordStep: true, refreshExpiry: false },
});
const AUTOMATED_ACTORS = new Set(["agent", "system", "dashboard", "brain", "planner", "runner", "recovery", "mcp", "internal", "approval", "test", "sweeper", "deadline", "task-runner", "automation", "root", "sidekick", "sidekick-agent", "service", "cron", "scheduler"]);
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
function isAuthorizedHuman(identity) { if (typeof identity !== "string") return false; const normalized = identity.normalize("NFKC").replace(INVISIBLE_CHARS, "").trim().toLowerCase(); if (!normalized || normalized.startsWith("unattributed:")) return false; return !AUTOMATED_ACTORS.has(normalized); }
module.exports = { RECONCILIATION_SPEC, isAuthorizedHuman };
