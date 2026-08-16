"use strict";

const crypto = require("crypto");
const { stripSidekickPrefix } = require("../core/tool-name");
const { RISK_LEVELS } = require("./metadata");
const { redactSensitive, redactSensitiveKeysDeep } = require("../redact");
const evolveCommon = require("../evolve/common");
const {
  canonicalizeApprovalValue,
  canonicalApprovalJson,
  approvalArgsHash,
  cloneApprovalArgs,
} = require("../approvals/canonical-json");

function createApprovalCompat({ dbStore, encryptSecret, decryptSecret, getToolPolicyDecision, getToolRisk, getCurrentSource, callTool, generateId, recordPlatformApprovalQueued, transitionPlatformApproval, recordPlatformApprovalEvent, recordPlatformChangeSet }) {
function loadApprovals() {
  return dbStore.loadDocument("approvals", []);
}

function saveApprovals(approvals) {
  dbStore.setDocument("approvals", approvals || []);
}

function generateApprovalId() {
  return "approval_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function approvalPreviewArgs(args) {
  return JSON.stringify(redactSensitiveKeysDeep(args || {}), null, 2).substring(0, 4000);
}

// The secret tool's `value` argument is a raw credential under a key name no
// generic check can flag; withhold it before anything derived from the args
// (previews, change-set snapshots) is persisted.
function withholdSecretToolValue(toolName, args) {
  if (stripSidekickPrefix(String(toolName || "")) === "secret"
    && args && typeof args === "object" && args.value !== undefined) {
    return { ...args, value: "[REDACTED]" };
  }
  return args;
}

// Canonical approval JSON is a VERSIONED WIRE FORMAT and now lives in a shared
// module: docs/adr-approval-continuation.md §3 derives `args_digest`,
// `plan_version` and `idempotency_key` from it and stores them durably, so a
// change to its normalisation would silently invalidate every stored digest.
// Defining it in two places would make that divergence invisible.
function getApprovalTtlSeconds() {
  const configured = parseInt(process.env.SIDEKICK_APPROVAL_TTL_SECONDS || "3600", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 3600;
}

function getApprovalLeaseSeconds() {
  const configured = parseInt(process.env.SIDEKICK_APPROVAL_LEASE_SECONDS || "300", 10);
  if (!Number.isFinite(configured)) return 300;
  return Math.min(Math.max(configured, 30), 3600);
}

function generateOperationId() {
  return "op_" + Date.now().toString(36) + "_" + crypto.randomBytes(8).toString("hex");
}

function generateExecutorId() {
  return `${process.pid || "pid"}_${crypto.randomBytes(6).toString("hex")}`;
}

function leaseExpiresAt(nowMs = Date.now()) {
  return new Date(nowMs + getApprovalLeaseSeconds() * 1000).toISOString();
}

function isLeaseExpired(item, nowMs = Date.now()) {
  const expires = Date.parse(item.lease_expires_at || item.execution_lease_expires_at || "");
  return !Number.isFinite(expires) || expires <= nowMs;
}

function approvalNeedsManualReconciliation(item) {
  const risk = item.risk || getToolRisk(item.tool);
  return risk === "high" || risk === "critical" || !["low", "medium"].includes(risk);
}

function discardApprovalPayload(item) {
  delete item.args;
  delete item.args_encrypted;
  item.payload_discarded_at = new Date().toISOString();
}

/**
 * Terminalise the legacy approval a Brain task step raised, once the durable
 * checkpoint has taken ownership of that action.
 *
 * WHY THIS EXISTS. A Brain tool step reaches the dispatcher through
 * `callAgentTool`, which correctly queues a legacy approval when policy
 * requires one — the dispatcher cannot know the caller is a task. Brain then
 * parks (T1), creating the authoritative approval row in the `approvals` table.
 * Without this, BOTH survive: two near-identical pending approvals appear in
 * the Approvals tab, and approving the legacy one routes to
 * `executeApprovedTool`'s standalone branch, which dispatches the high-risk
 * tool outside the runner and discards its result — verbatim the pre-ADR bug
 * this whole change exists to remove, reachable by clicking the wrong row.
 *
 * The legacy row is superseded rather than deleted: it is still the record that
 * a request was made, and its payload is discarded because the checkpoint now
 * holds the authoritative encrypted copy.
 */
function supersedeLegacyApprovalForTask(approvalId, { taskId = null, replacedBy = null } = {}) {
  if (!approvalId) return { ok: false, code: "missing_id" };
  const approvals = loadApprovals();
  const item = approvals.find(a => a.id === approvalId);
  if (!item) return { ok: false, code: "not_found" };
  if (item.status !== "pending") return { ok: false, code: "not_pending", status: item.status };

  const now = new Date().toISOString();
  item.status = "superseded";
  item.updated_at = now;
  item.completed_at = now;
  item.superseded_by = replacedBy;
  item.task_id = taskId;
  transitionPlatformApproval(item, "cancelled", {
    actor_id: "brain",
    reason: "superseded by a durable task checkpoint",
    result_status: "superseded",
    result_summary: `Approval for ${item.tool} is now tracked on the task checkpoint`,
  });
  recordPlatformApprovalEvent(item, "approval.superseded", {
    superseded_by: replacedBy,
    task_id: taskId,
  }, { actor_id: "brain", severity: "warning" });
  discardApprovalPayload(item);
  saveApprovals(approvals);
  return { ok: true, approvalId, replacedBy };
}

function markApprovalReconciliationRequired(item, reason, reviewer = "system") {
  const now = new Date().toISOString();
  item.status = "reconciliation_required";
  item.reconciliation_status = "manual_review";
  item.failure_reason = reason;
  item.updated_at = now;
  item.completed_at = item.completed_at || now;
  transitionPlatformApproval(item, "failed", {
    actor_id: reviewer,
    reason,
    result_status: "reconciliation_required",
    error_category: "reconciliation_required",
    result_summary: reason,
  });
  recordPlatformApprovalEvent(item, "approval.reconciliation_required", { reason, operation_id: item.operation_id || null }, { actor_id: reviewer, severity: "warning" });
  recordApprovalRecoveryEvent(item, "reconciliation_required", reason);
}

function recordApprovalRecoveryEvent(item, eventType, reason) {
  try {
    const db = dbStore.getDb();
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approval_execution_recovery_events'").get();
    if (!exists) return;
    db.prepare(`
      INSERT INTO approval_execution_recovery_events (
        id, approval_id, operation_id, executor_id, event_type, reconciliation_status, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "aere_" + Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex"),
      item.id,
      item.operation_id || null,
      item.executor_id || null,
      eventType,
      item.reconciliation_status || null,
      reason || null,
      new Date().toISOString()
    );
  } catch {}
}

function expireApprovals(approvals, now = Date.now()) {
  let changed = false;
  for (const item of approvals) {
    if (item.status !== "pending") {
      if (Object.prototype.hasOwnProperty.call(item, "args") || item.args_encrypted) {
        discardApprovalPayload(item);
        changed = true;
      }
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(item, "args") && !item.args_encrypted) {
      try {
        item.args_encrypted = encryptApprovalArgs(item.args);
        delete item.args;
        changed = true;
      } catch {
        item.status = "failed";
        item.error = "Legacy plaintext approval payload discarded because SIDEKICK_SECRET_KEY is unavailable";
        item.completed_at = new Date(now).toISOString();
        item.updated_at = item.completed_at;
        discardApprovalPayload(item);
        changed = true;
        continue;
      }
    }

    if (!item.expires_at) {
      const requestedAt = Date.parse(item.requested_at);
      const baseTime = Number.isFinite(requestedAt) ? requestedAt : now;
      item.expires_at = new Date(baseTime + (getApprovalTtlSeconds() * 1000)).toISOString();
      changed = true;
    }
    const expiresAt = Date.parse(item.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
    item.status = "expired";
    item.expired_at = new Date(now).toISOString();
    item.updated_at = item.expired_at;
    transitionPlatformApproval(item, "timed_out", {
      reason: "approval expired",
      result_status: "expired",
      result_summary: `Approval expired for ${item.tool}`,
    });
    recordPlatformApprovalEvent(item, "approval.expired", { expired_at: item.expired_at }, { severity: "warning" });
    discardApprovalPayload(item);
    changed = true;
  }
  return changed;
}

function encryptApprovalArgs(args) {
  return encryptSecret(canonicalApprovalJson(args || {}));
}

function decryptApprovalArgs(item) {
  if (item.args_encrypted) {
    const args = JSON.parse(decryptSecret(item.args_encrypted));
    if (item.args_hash && approvalArgsHash(args) !== item.args_hash) throw new Error("Approval payload authentication failed");
    return cloneApprovalArgs(args);
  }
  // Backward compatibility for approvals queued before encrypted payloads.
  if (Object.prototype.hasOwnProperty.call(item, "args")) return item.args || {};
  throw new Error("Approval payload is missing");
}

function queueApproval(toolName, args, decision, context = {}) {
  const approvals = loadApprovals();
  const now = new Date().toISOString();
  const storedArgs = cloneApprovalArgs(args || {});
  expireApprovals(approvals);
  const item = {
    id: generateApprovalId(),
    status: "pending",
    tool: toolName,
    risk: decision.risk,
    source: decision.source,
    requester: context.actor || decision.source || null,
    mode: decision.mode,
    reason: decision.reason,
    args_encrypted: encryptApprovalArgs(storedArgs),
    args_hash: approvalArgsHash(storedArgs),
    args_preview: approvalPreviewArgs(withholdSecretToolValue(toolName, storedArgs)),
    session_id: context.sessionId || context.session_id || null,
    project: context.project || null,
    task_id: context.taskId || context.task_id || null,
    timeout_ms: context.timeoutMs || context.timeout_ms || null,
    requested_at: now,
    updated_at: now,
    expires_at: new Date(Date.parse(now) + (getApprovalTtlSeconds() * 1000)).toISOString()
  };
  recordPlatformApprovalQueued(item);
  approvals.unshift(item);
  saveApprovals(approvals.slice(0, 500));
  return item;
}

function publicApproval(item) {
  const copy = { ...item };
  delete copy.args;
  delete copy.args_encrypted;
  copy.args_preview = copy.args_preview || approvalPreviewArgs(withholdSecretToolValue(item.tool, item.args));
  return copy;
}

/**
 * Task-originated approvals live in the `approvals` TABLE (migration 025), not
 * in the legacy JSON document, so they must be surfaced here or a parked Brain
 * task would be invisible in the Approvals tab and impossible to decide on.
 *
 * Shaped to match `publicApproval` so existing consumers need no changes. No
 * argument content is included: previews are no longer persisted, and
 * rendering one requires the decryption key at read time
 * (docs/adr-approval-continuation.md §4.4, I12). A reader sees the tool, risk,
 * digests and timing — and no argument content whatsoever.
 */
function listContinuationApprovals({ status } = {}) {
  try {
    const store = require("../approvals/store");
    store.ensureApprovalContinuationSchema();
    return store.listApprovalRows({ status, limit: 500 })
      .filter(row => row.task_id)
      .map(row => ({
        id: row.approval_id,
        status: row.status,
        tool: row.tool_name,
        risk: row.risk,
        source: row.source,
        mode: row.mode,
        requester: row.requester_identity,
        task_id: row.task_id,
        step_id: row.step_id,
        plan_version: row.plan_version,
        args_hash: row.args_digest,
        args_preview: null,
        // False once the payload has been discarded, so the UI does not offer a
        // "Show arguments" control that can only ever fail.
        args_preview_available: Boolean(row.args_encrypted),
        requested_at: row.requested_at,
        expires_at: row.expires_at,
        updated_at: row.updated_at,
        reviewed_by: row.approver_identity,
        reviewed_at: row.decided_at,
        completed_at: row.completed_at,
        attempt_count: row.attempt_count,
        reconciliation_status: row.reconciliation_status,
        error: row.error_code,
        continuation: true,
      }));
  } catch {
    // A continuation-storage failure must not blank the legacy queue.
    return [];
  }
}

/**
 * Render a task-originated approval's arguments ON DEMAND for an authorized
 * reader (docs/adr-approval-continuation.md §4.4).
 *
 * Persisted previews were removed because `approvalPreviewArgs` redacts by key
 * name and `redactSensitive` matches known credential shapes, so neither can
 * catch a secret passed as an ordinary-looking value under an ordinary-looking
 * key — a stored preview is plaintext of unknown sensitivity. The consequence
 * the ADR accepts is that showing a preview now requires the decryption key at
 * read time, which is what this does.
 *
 * A human being asked to authorize an action must be able to SEE it. Without
 * this, a reviewer approving a critical-risk `bash` step would see a tool name,
 * a risk level, and a hex digest — which is not informed consent, and would
 * make an argument substitution invisible to the one control designed to catch
 * it.
 *
 * The payload is authenticated against `args_digest` before rendering, so a
 * tampered payload reports as such instead of being displayed as genuine.
 * Nothing is written back.
 */
function renderContinuationApprovalPreview(approvalId) {
  let row;
  try {
    const store = require("../approvals/store");
    store.ensureApprovalContinuationSchema();
    row = store.getApproval(approvalId);
  } catch {
    return { ok: false, code: "continuation_storage_unavailable" };
  }
  if (!row || !row.task_id) return { ok: false, code: "not_found" };
  if (!row.args_encrypted) return { ok: false, code: "payload_discarded" };

  const store = require("../approvals/store");
  const { argsDigest } = require("../approvals/keys");
  let args;
  try {
    args = store.decryptJson(row.args_encrypted);
  } catch {
    return { ok: false, code: "payload_unreadable" };
  }
  // Null is not empty. `argsDigest(null || {})` equals `argsDigest({})`, so a
  // payload decrypting to JSON null would otherwise authenticate against an
  // approval whose real arguments were `{}` — the same confusion `verifyClaim`
  // closes on the dispatch path. Display-only here, but a reviewer must not be
  // shown `{}` for a payload that is not `{}`.
  if (args == null) return { ok: false, code: "payload_unreadable" };
  if (argsDigest(args) !== row.args_digest) {
    return { ok: false, code: "payload_authentication_failed" };
  }
  return {
    ok: true,
    approval_id: row.approval_id,
    task_id: row.task_id,
    step_id: row.step_id,
    tool: row.tool_name,
    risk: row.risk,
    args_hash: row.args_digest,
    args_preview: approvalPreviewArgs(args || {}),
  };
}

function listApprovals({ status, limit } = {}) {
  const max = Math.min(parseInt(limit || "100", 10) || 100, 500);
  const approvals = loadApprovals();
  if (expireApprovals(approvals)) saveApprovals(approvals);
  const legacyItems = approvals
    .filter(item => !status || item.status === status)
    .map(publicApproval);
  const combined = legacyItems.concat(listContinuationApprovals({ status }));
  combined.sort((a, b) => String(b.requested_at || "").localeCompare(String(a.requested_at || "")));
  return combined.slice(0, max);
}

async function resolveApproval(id, action, reviewer = "dashboard", options = {}) {
  // Task-originated approvals are decided through the continuation
  // transactions, not the legacy document: approving is T2 (approval approved
  // AND task runnable, atomically) and rejecting is T5 (structured step outcome
  // recorded AND task woken, atomically). Routing them through the legacy path
  // would strand the task, which is the bug the ADR removes.
  const continuationApproval = (() => {
    try {
      const store = require("../approvals/store");
      store.ensureApprovalContinuationSchema();
      const row = store.getApproval(id);
      return row && row.task_id ? row : null;
    } catch {
      return null;
    }
  })();

  if (continuationApproval) {
    if (action === "reject") {
      const { wake } = require("../approvals/continuation");
      const outcome = wake({ approvalId: id, trigger: "deny", actor: reviewer });
      if (!outcome.ok) {
        return { content: [{ type: "text", text: `Approval ${id} could not be denied (${outcome.code})` }], isError: true };
      }
      return { content: [{ type: "text", text: `Denied approval ${id}; task ${outcome.taskId} resumes with a structured refusal.` }] };
    }
    if (action !== "approve") {
      return { content: [{ type: "text", text: "Invalid approval action: " + action }], isError: true };
    }
    return require("./dispatcher").executeApprovedTool({ approvalId: id, reviewer, reviewerPrincipalId: options.reviewerPrincipalId || null, source: reviewer });
  }

  const approvals = loadApprovals();
  if (expireApprovals(approvals)) saveApprovals(approvals);
  const item = approvals.find(a => a.id === id);
  if (!item) {
    return { content: [{ type: "text", text: "Approval not found: " + id }], isError: true };
  }
  if (item.status !== "pending") {
    return { content: [{ type: "text", text: `Approval ${id} is already ${item.status}` }], isError: true };
  }

  if (action === "reject") {
    const now = new Date().toISOString();
    item.reviewed_at = now;
    item.updated_at = now;
    item.reviewed_by = reviewer;
    item.status = "rejected";
    transitionPlatformApproval(item, "cancelled", {
      actor_id: reviewer,
      reason: "approval rejected",
      result_status: "rejected",
      result_summary: `Approval rejected for ${item.tool}`,
    });
    recordPlatformApprovalEvent(item, "approval.rejected", { reviewed_at: now, reviewed_by: reviewer }, { actor_id: reviewer, severity: "warning" });
    recordPlatformChangeSet(item, "rejected", { actor_id: reviewer, reason: "approval rejected", args: {} });
    discardApprovalPayload(item);
    saveApprovals(approvals);
    return { content: [{ type: "text", text: "Rejected approval: " + id }] };
  }

  if (action !== "approve") {
    return { content: [{ type: "text", text: "Invalid approval action: " + action }], isError: true };
  }

  return require("./dispatcher").executeApprovedTool({ approvalId: id, reviewer, reviewerPrincipalId: options.reviewerPrincipalId || null, source: reviewer });
}

function claimApprovalExecution({ approvalId, reviewer = "dashboard", source, allowStaleReclaim = false } = {}) {
  const db = dbStore.getDb();
  return db.transaction(() => {
    const approvals = loadApprovals();
    if (expireApprovals(approvals)) saveApprovals(approvals);
    const item = approvals.find(a => a.id === approvalId);
    if (!item) return { content: [{ type: "text", text: "Approval not found: " + approvalId }], isError: true, code: "approval_not_found" };
    if (item.status === "executing") {
      if (!isLeaseExpired(item)) return { content: [{ type: "text", text: `Approval ${approvalId} is already executing` }], isError: true, code: "approval_lease_active" };
      if (!allowStaleReclaim || approvalNeedsManualReconciliation(item)) {
        markApprovalReconciliationRequired(item, "Approval execution lease expired; outcome requires reconciliation before retry", reviewer);
        saveApprovals(approvals);
        return { content: [{ type: "text", text: `Approval ${approvalId} requires reconciliation before retry` }], isError: true, code: "reconciliation_required" };
      }
      item.status = "pending";
      item.reconciliation_status = "reclaimed_for_retry";
    }
    if (item.status !== "pending") return { content: [{ type: "text", text: `Approval ${approvalId} is already ${item.status}` }], isError: true, code: "approval_not_executable" };

    const expiresAt = Date.parse(item.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      item.status = "expired";
      item.expired_at = new Date().toISOString();
      item.updated_at = item.expired_at;
      discardApprovalPayload(item);
      saveApprovals(approvals);
      return { content: [{ type: "text", text: `Approval ${approvalId} is already expired` }], isError: true, code: "approval_expired" };
    }

    let approvalArgs;
    try {
      approvalArgs = decryptApprovalArgs(item);
    } catch (e) {
      item.status = "failed";
      item.error = "Approval payload could not be authenticated or decrypted";
      item.completed_at = new Date().toISOString();
      item.updated_at = item.completed_at;
      transitionPlatformApproval(item, "failed", {
        actor_id: reviewer,
        reason: item.error,
        result_status: "failure",
        error_category: "approval_payload_decrypt_failed",
        result_summary: item.error,
      });
      recordPlatformApprovalEvent(item, "approval.failed", { error: item.error }, { actor_id: reviewer, severity: "error" });
      discardApprovalPayload(item);
      saveApprovals(approvals);
      return { content: [{ type: "text", text: item.error }], isError: true, code: "approval_payload_invalid" };
    }

    const currentRisk = getToolRisk(item.tool);
    if (!RISK_LEVELS.includes(currentRisk)) {
      item.status = "failed";
      item.error = "Approved tool has invalid risk classification";
      item.completed_at = new Date().toISOString();
      item.updated_at = item.completed_at;
      saveApprovals(approvals);
      return { content: [{ type: "text", text: item.error }], isError: true, code: "risk_unclassified" };
    }

    const now = new Date().toISOString();
    const operationId = item.operation_id || generateOperationId();
    const executorId = generateExecutorId();
    item.reviewed_at = now;
    item.updated_at = now;
    item.reviewed_by = reviewer;
    item.status = "executing";
    item.operation_id = operationId;
    item.executor_id = executorId;
    item.execution_started_at = now;
    item.claimed_at = now;
    item.heartbeat_at = now;
    item.lease_expires_at = leaseExpiresAt(Date.parse(now));
    item.attempt_count = Number(item.attempt_count || 0) + 1;
    item.reconciliation_status = "not_required";
    item.execution_source = source || item.source || "unknown";
    item.execution_args_hash = approvalArgsHash(approvalArgs);
    transitionPlatformApproval(item, "ready", { actor_id: reviewer, reason: "approval granted" });
    transitionPlatformApproval(item, "running", { actor_id: reviewer, reason: "approved tool execution started" });
    recordPlatformApprovalEvent(item, "approval.approved", { reviewed_at: now, reviewed_by: reviewer }, { actor_id: reviewer });
    saveApprovals(approvals);
    return {
      approvalId,
      operationId,
      executorId,
      idempotencyKey: `approval:${approvalId}:${operationId}`,
      tool: item.tool,
      args: approvalArgs,
      argsHash: item.execution_args_hash,
      source: item.source || "unknown",
      requester: item.requester || null,
      sessionId: item.session_id || null,
      project: item.project || null,
      taskId: item.task_id || null,
      parentId: item.platform_execution_id || null,
      rootExecutionId: item.platform_execution_id || null,
      timeoutMs: item.timeout_ms || null,
    };
  })();
}

function renewApprovalLease({ approvalId, operationId, executorId } = {}) {
  const approvals = loadApprovals();
  const item = approvals.find(a => a.id === approvalId);
  if (!item || item.status !== "executing") return { ok: false, reason: "not_executing" };
  if (item.operation_id !== operationId || item.executor_id !== executorId) return { ok: false, reason: "lease_owner_mismatch" };
  const now = new Date().toISOString();
  item.heartbeat_at = now;
  item.lease_expires_at = leaseExpiresAt(Date.parse(now));
  item.updated_at = now;
  recordPlatformApprovalEvent(item, "approval.lease_renewed", { operation_id: operationId, lease_expires_at: item.lease_expires_at }, { actor_id: item.reviewed_by || item.source || "unknown" });
  saveApprovals(approvals);
  return { ok: true, lease_expires_at: item.lease_expires_at };
}

function recoverStaleApprovals({ allowLowRiskRetry = false, now = Date.now() } = {}) {
  const approvals = loadApprovals();
  const recovered = [];
  for (const item of approvals) {
    if (item.status !== "executing" || !isLeaseExpired(item, now)) continue;
    if (allowLowRiskRetry && !approvalNeedsManualReconciliation(item)) {
      item.status = "pending";
      item.reconciliation_status = "safe_to_retry";
      item.updated_at = new Date(now).toISOString();
      recordPlatformApprovalEvent(item, "approval.lease_recovered", { operation_id: item.operation_id || null, status: item.status }, { severity: "warning" });
      recordApprovalRecoveryEvent(item, "lease_recovered", "Stale low-risk approval returned to pending by recovery policy");
    } else {
      markApprovalReconciliationRequired(item, "Stale approval execution lease requires manual reconciliation", "recovery");
    }
    recovered.push(publicApproval(item));
  }
  if (recovered.length > 0) saveApprovals(approvals);
  return recovered;
}

function finalizeApprovalExecution({ approvalId, reviewer = "dashboard", result, args, operationId, executorId } = {}) {
  const approvals = loadApprovals();
  const updated = approvals.find(a => a.id === approvalId);
  if (!updated) return null;
  if (updated.status !== "executing") return publicApproval(updated);
  if (updated.operation_id !== operationId || updated.executor_id !== executorId) {
    recordPlatformApprovalEvent(updated, "approval.finalize_rejected", { reason: "lease_owner_mismatch", operation_id: operationId || null }, { actor_id: reviewer, severity: "error" });
    return { ...publicApproval(updated), finalizeRejected: true, reason: "lease_owner_mismatch" };
  }
  if (isLeaseExpired(updated) && result?.isError && result?.operationMayContinue) {
    markApprovalReconciliationRequired(updated, "Timed out operation may still be running; final outcome unknown", reviewer);
  } else if (result?.isError && result?.operationMayContinue) {
    markApprovalReconciliationRequired(updated, "Timed out operation may still be running; final outcome unknown", reviewer);
  } else {
    updated.status = result?.isError ? "failed" : "approved";
    updated.reconciliation_status = "not_required";
  }
  // Approved secret executions return raw credential values that pattern
  // redaction cannot recognize; never store them in the approval record.
  const previewText = stripSidekickPrefix(String(updated.tool || "")) === "secret"
    ? "(sensitive value withheld)"
    : (result?.content?.[0]?.text || "");
  updated.result_preview = redactSensitive(previewText).substring(0, 1000);
  updated.completed_at = new Date().toISOString();
  updated.updated_at = updated.completed_at;
  transitionPlatformApproval(updated, result?.isError ? "failed" : "completed", {
    actor_id: reviewer,
    reason: result?.isError ? "approved tool execution failed" : "approved tool execution completed",
    result_status: result?.isError ? "failure" : "success",
    error_category: result?.isError ? evolveCommon.errorCategory(updated.result_preview) : null,
    result_summary: updated.result_preview,
  });
  recordPlatformApprovalEvent(updated, result?.isError ? "approval.failed" : "approval.completed", {
    completed_at: updated.completed_at,
    result_preview: updated.result_preview,
  }, { actor_id: reviewer, severity: result?.isError ? "error" : "info" });
  recordPlatformChangeSet(updated, result?.isError ? "failed" : "approved", {
    actor_id: reviewer,
    reason: result?.isError ? "approved tool execution failed" : "approved tool execution completed",
    // The change-set snapshot is persisted unencrypted; sanitize it the same
    // way as the preview. args_hash/args_digest keep raw-args integrity.
    args: redactSensitiveKeysDeep(withholdSecretToolValue(updated.tool, args || {})),
    result_summary: updated.result_preview,
  });
  discardApprovalPayload(updated);
  saveApprovals(approvals);
  return publicApproval(updated);
}

  return { loadApprovals, saveApprovals, generateApprovalId, approvalPreviewArgs, withholdSecretToolValue, getApprovalTtlSeconds, getApprovalLeaseSeconds, generateOperationId, generateExecutorId, leaseExpiresAt, isLeaseExpired, approvalNeedsManualReconciliation, discardApprovalPayload, supersedeLegacyApprovalForTask, markApprovalReconciliationRequired, recordApprovalRecoveryEvent, expireApprovals, encryptApprovalArgs, decryptApprovalArgs, queueApproval, publicApproval, listContinuationApprovals, renderContinuationApprovalPreview, listApprovals, resolveApproval, claimApprovalExecution, renewApprovalLease, recoverStaleApprovals, finalizeApprovalExecution };
}

module.exports = { createApprovalCompat };
