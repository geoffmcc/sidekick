const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { encryptSecret, decryptSecret } = require("./core/secret-cipher");
const { execSync, execFileSync } = require("child_process");
const { redactSensitive, isSensitiveKey, redactSensitiveKeysDeep } = require("./redact");
const evolveCommon = require("./evolve/common");
const dbStore = require("./db");
const { recordToolCallMemory, buildMemoryBrief, recallMemoryForText } = require("./memory");
const dynamicTools = require("./dynamic-tools");
const platformKernel = require("./platform/kernel");
const { stripSidekickPrefix } = require("./core/tool-name");
const computeTools = require("./compute/tools");
const { TOOL_RISK, TOOL_ACTION_RISK, TOOL_CATEGORIES, RISK_LEVELS } = require("./tools/metadata");
const toolContext = require("./tools/context");
const { loadContext: loadSharedContext, findContextItemById: findSharedContextItemById, updateLegacyContextItem: updateSharedLegacyContextItem } = require("./tools/families/context");
const { parsePolicyList, sourceEnvName } = require("./core/policy-env");
const { getPathPolicyDecision, enforcePathPolicy } = require("./tools/path-policy");
const { sidekick_status } = require("./tools/families/observability");
const { sidekick_llm } = require("./tools/families/inference");
const { isDangerous } = require("./tools/families/shell");

const { callTool } = require("./tools/dispatch-seam");
const { generateId } = require("./core/ids");
const { PROCEDURES_FILE, loadProcedures, saveProcedures } = require("./core/procedures-store");
const { SECRETS_FILE, loadSecrets, saveSecrets } = require("./core/secrets-store");
const { createScheduledPlatformExecution, transitionScheduledPlatformExecution, releaseScheduledClaim, startScheduledLeaseRenewal, appendScheduledPlatformEvent, claimScheduledDefinition } = require("./tools/scheduled-execution");
// github/ci_status moved to families/github.js in B-6; re-imported so their
// helper quartet stays on the compatibility-export surface (contract test).
const { parseGithubArgs, getGithubArg, getCiRevisionSelector, buildCiStatusResult, formatCiStatusText } = require("./tools/families/github");
// mission moved to families/operations.js in B-6; missionRoute re-imported to
// stay on the compatibility-export surface (contract test).
const { missionRoute } = require("./tools/families/operations");
// cron/delay/watch moved to families/scheduling.js in B-6; the delay/watch
// stores and recovery helpers are re-imported so src/agent.js and
// src/dashboard.js keep reaching them through the facade.
const { loadDelays, saveDelays, recoverStrandedDelays, pauseWatchForCancel, loadWatches, saveWatches } = require("./tools/families/scheduling");
// runbook moved to families/runbook.js; recoverStrandedRunbooks re-imported
// for src/agent.js restart recovery via the facade.
const { recoverStrandedRunbooks } = require("./tools/families/runbook");
// tools (catalog/policy inspector) moved to families/tool-catalog.js; the
// policy inspection helpers are re-imported for src/dashboard.js via the facade.
const { buildPolicyInspection, summarizePolicyInspection } = require("./tools/families/tool-catalog");
const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

fs.mkdirSync(DATA_DIR, { recursive: true });

const LOG_FILE = path.join(DATA_DIR, "log.jsonl");
const CRON_FILE = path.join(DATA_DIR, "cron.json");
const WEBHOOK_FILE = path.join(DATA_DIR, "webhooks.json");
const MAX_LOG = 1000;

let compatibilitySource = "unknown";

function setSource(source) {
  compatibilitySource = source || "unknown";
  toolContext.setExecutionSource(compatibilitySource);
}

function getCurrentSource() {
  return toolContext.getExecutionSource() || compatibilitySource || "unknown";
}

const RISK_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

// Tool categories - maps tool names to their category
function getToolRisk(name, args = undefined) {
  // Module tools first: the registry wins dispatch for these names, so the
  // enforced risk must be the risk of what actually executes. Lazy require —
  // the loader has no top-level dependency back into this module. Per-action
  // overrides deliberately do NOT apply here: the descriptor's risk is the
  // risk of foreign code, and a caller-supplied action must not lower it.
  const moduleDescriptor = require("./modules/loader").resolveActiveDescriptor(name);
  if (moduleDescriptor) return RISK_LEVELS.includes(moduleDescriptor.risk) ? moduleDescriptor.risk : "critical";
  const generated = dbStore.getGeneratedCapabilityByName(name);
  if (generated) return RISK_LEVELS.includes(generated.risk) ? generated.risk : "critical";
  const canonical = stripSidekickPrefix(name);
  // Own-property lookup only: a prototype-chain name like "__proto__" or
  // "constructor" must fall through to the critical default, never to a
  // truthy inherited value that would make strict/restricted modes fail open.
  const risk = Object.prototype.hasOwnProperty.call(TOOL_RISK, canonical) ? TOOL_RISK[canonical] : null;
  const toolRisk = RISK_LEVELS.includes(risk) ? risk : "critical";
  return resolveActionRisk(canonical, args, toolRisk);
}

/**
 * Applies a per-action risk override, if one is declared for this tool and this
 * exact action. Every unlisted, missing, or malformed case keeps the tool-level
 * risk, so the only reachable outcome of an unrecognised action is the stricter
 * one. Own-property lookups throughout: an inherited `__proto__` value must not
 * be able to lower the risk of a mutating call.
 */
function resolveActionRisk(canonical, args, toolRisk) {
  if (!args || typeof args !== "object") return toolRisk;
  if (!Object.prototype.hasOwnProperty.call(TOOL_ACTION_RISK, canonical)) return toolRisk;
  const action = Object.prototype.hasOwnProperty.call(args, "action") ? args.action : undefined;
  if (typeof action !== "string" || !action) return toolRisk;
  const actionMap = TOOL_ACTION_RISK[canonical];
  if (!Object.prototype.hasOwnProperty.call(actionMap, action)) return toolRisk;
  const actionRisk = actionMap[action];
  return RISK_LEVELS.includes(actionRisk) ? actionRisk : toolRisk;
}

// Canonical names of every built-in tool, including those whose handlers have
// moved to descriptor-owned families under src/tools/families/. Built lazily
// because TOOL_DEFS is declared later in this module, and memoized because
// TOOL_DEFS is immutable for the process lifetime. If built-in tools ever
// become dynamically registerable, this memo must be invalidated.

// Sync tool registry from code to database
// This function is called on server startup to ensure the DB has current tool metadata
function syncToolRegistry() {
  try {
    const db = dbStore.getDb();
    const now = new Date().toISOString();

    // Check if tool_categories table exists (migration may not have run yet)
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_categories'"
    ).get();

    if (!tableExists) {
      console.log('[ToolRegistry] Tables not yet created, skipping sync');
      return;
    }

    // Get all current tools from code. Active module tools count as current
    // so the catalog shows them and does not mark them deprecated; provision
    // modules BEFORE calling this or their tools deprecate until the next sync.
    const moduleDefs = require("./modules/loader").getActiveDescriptors().map(d => ({
      name: d.name,
      description: d.description,
      args: d.args,
      risk: d.risk,
      category: d.category,
    }));
    const dynamicNames = new Set(dbStore.listGeneratedCapabilities({ states: ["trial", "active"] }).map(t => t.name));
    const codeTools = new Set([...TOOL_DEFS.map(t => t.name), ...moduleDefs.map(t => t.name), ...dynamicNames]);

    // Get all tools from database
    const dbTools = db.prepare("SELECT name, deprecated FROM tools").all();
    const dbToolNames = new Set(dbTools.map(t => t.name));

    // Upsert tools from code into database
    const upsertTool = db.prepare(`
      INSERT INTO tools (name, description, args_json, risk, enabled, deprecated, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        args_json = excluded.args_json,
        risk = excluded.risk,
        enabled = 1,
        deprecated = 0,
        updated_at = excluded.updated_at
    `);

    // Map category names to IDs
    const categoryMap = {};
    const categories = db.prepare("SELECT id, name FROM tool_categories").all();
    for (const cat of categories) {
      categoryMap[cat.name] = cat.id;
    }

    // Clear existing tool-category mappings (we'll recreate them)
    db.prepare("DELETE FROM tool_category_map").run();

    // Insert/update each tool (module descriptors carry their own risk and
    // category; legacy defs fall back to the static maps)
    for (const toolDef of [...TOOL_DEFS, ...moduleDefs]) {
      const risk = toolDef.risk || TOOL_RISK[toolDef.name] || "low";
      const argsJson = JSON.stringify(toolDef.args || {});

      upsertTool.run(
        toolDef.name,
        toolDef.description,
        argsJson,
        risk,
        now
      );

      // Get the tool's category
      const categoryName = toolDef.category || TOOL_CATEGORIES[toolDef.name];
      if (categoryName && categoryMap[categoryName]) {
        db.prepare(
          "INSERT INTO tool_category_map (tool_name, category_id) VALUES (?, ?)"
        ).run(toolDef.name, categoryMap[categoryName]);
      }
    }

    // Mark tools that exist in DB but not in code as deprecated
    for (const dbTool of dbTools) {
      if (!codeTools.has(dbTool.name) && !dbTool.deprecated) {
        db.prepare(
          "UPDATE tools SET deprecated = 1, enabled = 0, updated_at = ? WHERE name = ?"
        ).run(now, dbTool.name);
      }
    }

    dbStore.syncGeneratedToolRegistry();
    console.log(`[ToolRegistry] Synced ${TOOL_DEFS.length} built-in tools, ${moduleDefs.length} module tools, and ${dynamicNames.size} generated tools to database`);
  } catch (error) {
    console.error('[ToolRegistry] Error syncing tool registry:', error.message);
  }
}

function getPolicyEntries(source, suffixes) {
  const entries = [];
  for (const suffix of suffixes) {
    entries.push(...parsePolicyList(process.env["SIDEKICK_" + suffix]));
    entries.push(...parsePolicyList(process.env[sourceEnvName(source, suffix)]));
  }
  return entries;
}

function findPolicyListMatch(entries, toolName, risk) {
  // Case-fold the tool name symmetrically with the entries so a mixed-case
  // requested name cannot evade a blocklist entry.
  const canonical = stripSidekickPrefix(String(toolName || "").toLowerCase());
  return entries.find(entry => {
    const normalized = stripSidekickPrefix(entry.toLowerCase());
    return normalized === canonical || normalized === ("risk:" + risk);
  });
}

function getApprovalMode(source = getCurrentSource()) {
  const sourceMode = process.env[sourceEnvName(source, "APPROVAL_MODE")];
  return (sourceMode || process.env.SIDEKICK_APPROVAL_MODE || "off").toLowerCase();
}

function getApprovalEntries(source, suffixes) {
  const entries = [];
  for (const suffix of suffixes) {
    entries.push(...parsePolicyList(process.env["SIDEKICK_APPROVAL_" + suffix]));
    entries.push(...parsePolicyList(process.env[sourceEnvName(source, "APPROVAL_" + suffix)]));
  }
  return entries;
}

function getApprovalDecision(toolName, source = getCurrentSource(), args = undefined) {
  const risk = getToolRisk(toolName, args);
  const mode = getApprovalMode(source);
  const requiredEntries = getApprovalEntries(source, ["REQUIRED_TOOLS"]);
  const exemptEntries = getApprovalEntries(source, ["EXEMPT_TOOLS"]);

  if (mode === "off" || mode === "disabled") {
    return { required: false, source, mode, risk, reason: "approval mode is off" };
  }

  const exemptMatch = findPolicyListMatch(exemptEntries, toolName, risk);
  if (exemptMatch) {
    return { required: false, source, mode, risk, reason: "exempt from approval", matched: exemptMatch, list: "exempt" };
  }

  const requiredMatch = findPolicyListMatch(requiredEntries, toolName, risk);
  if (requiredMatch) {
    return { required: true, source, mode, risk, reason: "matched approval requirement", matched: requiredMatch, list: "required" };
  }

  if (mode === "strict" && RISK_ORDER[risk] >= RISK_ORDER.high) {
    return { required: true, source, mode, risk, reason: "strict mode requires approval for high and critical risk tools", list: "mode" };
  }

  if (mode === "risky" && risk === "critical") {
    return { required: true, source, mode, risk, reason: "risky mode requires approval for critical risk tools", list: "mode" };
  }

  return { required: false, source, mode, risk, reason: "approval not required" };
}

function getToolPolicyDecision(toolName, source = getCurrentSource(), args = undefined) {
  const risk = getToolRisk(toolName, args);
  const sourceMode = process.env[sourceEnvName(source, "TOOL_POLICY")];
  const mode = (sourceMode || process.env.SIDEKICK_TOOL_POLICY || "open").toLowerCase();
  const allowedEntries = getPolicyEntries(source, ["ALLOWED_TOOLS"]);
  const blockedEntries = getPolicyEntries(source, ["DISABLED_TOOLS", "BLOCKED_TOOLS"]);

  const blockedMatch = findPolicyListMatch(blockedEntries, toolName, risk);
  if (blockedMatch) {
    return { allowed: false, source, mode, risk, reason: "blocked by tool policy", matched: blockedMatch, list: "blocked" };
  }

  if (allowedEntries.length > 0) {
    const allowedMatch = findPolicyListMatch(allowedEntries, toolName, risk);
    return {
      allowed: Boolean(allowedMatch),
      source,
      mode,
      risk,
      reason: allowedMatch ? "allowed by explicit allowlist" : "not in explicit allowlist",
      matched: allowedMatch,
      list: "allowed"
    };
  }

  if (mode === "restricted" && RISK_ORDER[risk] >= RISK_ORDER.high) {
    return { allowed: false, source, mode, risk, reason: "restricted policy blocks high and critical risk tools", list: "mode" };
  }

  return { allowed: true, source, mode, risk, reason: "allowed" };
}

function enforceToolPolicy(toolName, source = getCurrentSource(), args = undefined) {
  const decision = getToolPolicyDecision(toolName, source, args);
  if (decision.allowed) return null;
  return {
    content: [{
      type: "text",
      text: `Tool blocked by policy: ${toolName} (${decision.risk} risk, source=${decision.source}, mode=${decision.mode}). ${decision.reason}.`
    }],
    isError: true
  };
}

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
const {
  canonicalizeApprovalValue,
  canonicalApprovalJson,
  approvalArgsHash,
  cloneApprovalArgs,
} = require("./approvals/canonical-json");

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
    const store = require("./approvals/store");
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
    const store = require("./approvals/store");
    store.ensureApprovalContinuationSchema();
    row = store.getApproval(approvalId);
  } catch {
    return { ok: false, code: "continuation_storage_unavailable" };
  }
  if (!row || !row.task_id) return { ok: false, code: "not_found" };
  if (!row.args_encrypted) return { ok: false, code: "payload_discarded" };

  const store = require("./approvals/store");
  const { argsDigest } = require("./approvals/keys");
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

async function resolveApproval(id, action, reviewer = "dashboard") {
  // Task-originated approvals are decided through the continuation
  // transactions, not the legacy document: approving is T2 (approval approved
  // AND task runnable, atomically) and rejecting is T5 (structured step outcome
  // recorded AND task woken, atomically). Routing them through the legacy path
  // would strand the task, which is the bug the ADR removes.
  const continuationApproval = (() => {
    try {
      const store = require("./approvals/store");
      store.ensureApprovalContinuationSchema();
      const row = store.getApproval(id);
      return row && row.task_id ? row : null;
    } catch {
      return null;
    }
  })();

  if (continuationApproval) {
    if (action === "reject") {
      const { wake } = require("./approvals/continuation");
      const outcome = wake({ approvalId: id, trigger: "deny", actor: reviewer });
      if (!outcome.ok) {
        return { content: [{ type: "text", text: `Approval ${id} could not be denied (${outcome.code})` }], isError: true };
      }
      return { content: [{ type: "text", text: `Denied approval ${id}; task ${outcome.taskId} resumes with a structured refusal.` }] };
    }
    if (action !== "approve") {
      return { content: [{ type: "text", text: "Invalid approval action: " + action }], isError: true };
    }
    return require("./tools/dispatcher").executeApprovedTool({ approvalId: id, reviewer, source: reviewer });
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

  return require("./tools/dispatcher").executeApprovedTool({ approvalId: id, reviewer, source: reviewer });
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

function getToolDefsForSource(source = getCurrentSource()) {
  try {
    const db = dbStore.getDb();

    // Check if tools table exists (fallback to in-memory if not)
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tools'"
    ).get();

    if (!tableExists) {
      // Fallback to in-memory TOOL_DEFS if DB not ready
      return TOOL_DEFS.map(def => {
        const policy = getToolPolicyDecision(def.name, source);
        const approval = getApprovalDecision(def.name, source);
        return { ...def, category: def.category || TOOL_CATEGORIES[def.name] || "Uncategorized", risk: policy.risk, enabled: policy.allowed, policy: policy.reason, approval_required: approval.required, approval: approval.reason };
      });
    }

    // Get all enabled, non-deprecated tools from database
    const tools = db.prepare(`
      SELECT t.name, t.description, t.args_json, t.risk, t.enabled,
             tc.name as category
      FROM tools t
      LEFT JOIN tool_category_map tcm ON t.name = tcm.tool_name
      LEFT JOIN tool_categories tc ON tcm.category_id = tc.id
      WHERE t.enabled = 1 AND t.deprecated = 0
      ORDER BY t.name
    `).all();

    return tools.map(tool => {
      const policy = getToolPolicyDecision(tool.name, source);
      const approval = getApprovalDecision(tool.name, source);
      const args = tool.args_json ? JSON.parse(tool.args_json) : {};

      return {
        name: tool.name,
        description: tool.description,
        args: args,
        category: tool.category || TOOL_CATEGORIES[tool.name] || "Uncategorized",
        risk: policy.risk,
        enabled: policy.allowed,
        policy: policy.reason,
        approval_required: approval.required,
        approval: approval.reason
      };
    });
  } catch (error) {
    console.error('[ToolRegistry] Error reading from DB, falling back to in-memory:', error.message);
    // Fallback to in-memory if DB query fails
    return TOOL_DEFS.map(def => {
      const policy = getToolPolicyDecision(def.name, source);
      const approval = getApprovalDecision(def.name, source);
      return { ...def, category: def.category || TOOL_CATEGORIES[def.name] || "Uncategorized", risk: policy.risk, enabled: policy.allowed, policy: policy.reason, approval_required: approval.required, approval: approval.reason };
    });
  }
}

// Get all tool categories with their tools
function getToolCategoriesWithTools(source = getCurrentSource()) {
  try {
    const db = dbStore.getDb();

    // Check if tables exist
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_categories'"
    ).get();

    if (!tableExists) {
      // Return empty if DB not ready
      return [];
    }

    // Get all categories with sort order
    const categories = db.prepare(`
      SELECT id, name, icon, sort_order
      FROM tool_categories
      ORDER BY sort_order
    `).all();

    // Get all tools with their categories
    const tools = db.prepare(`
      SELECT t.name, t.description, t.risk, t.enabled, tc.name as category
      FROM tools t
      LEFT JOIN tool_category_map tcm ON t.name = tcm.tool_name
      LEFT JOIN tool_categories tc ON tcm.category_id = tc.id
      WHERE t.enabled = 1 AND t.deprecated = 0
      ORDER BY t.name
    `).all();

    // Group tools by category
    const categoryMap = {};
    for (const cat of categories) {
      categoryMap[cat.name] = {
        name: cat.name,
        icon: cat.icon,
        sort_order: cat.sort_order,
        tools: []
      };
    }

    for (const tool of tools) {
      const policy = getToolPolicyDecision(tool.name, source);
      const approval = getApprovalDecision(tool.name, source);
      if (tool.category && categoryMap[tool.category]) {
        categoryMap[tool.category].tools.push({
          name: tool.name,
          description: tool.description,
          risk: policy.risk,
          enabled: policy.allowed,
          approval_required: approval.required
        });
      }
    }

    // Return as array, filtering out empty categories
    return Object.values(categoryMap)
      .filter(cat => cat.tools.length > 0)
      .sort((a, b) => a.sort_order - b.sort_order);
  } catch (error) {
    console.error('[ToolRegistry] Error getting categories:', error.message);
    return [];
  }
}


function formatArgs(args) {
  if (typeof args !== "object" || args === null) return "";
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    // redactSensitive only sees the bare value here; a credential under a
    // sensitive key name has no recognizable shape, so check the key first.
    if (isSensitiveKey(key)) {
      parts.push(key + "=[REDACTED]");
      continue;
    }
    // Objects/arrays are sanitized with key context before serialization:
    // String() loses their content and JSON quoting defeats redactSensitive.
    const str = value && typeof value === "object"
      ? JSON.stringify(redactSensitiveKeysDeep(value))
      : String(value);
    const truncated = str.length > 100 ? str.substring(0, 100) + "..." : str;
    parts.push(key + "=" + redactSensitive(truncated));
  }
  return parts.join(", ");
}

function logToolCall(name, args, duration, success, summary, metadata = {}) {
  try {
    // The secret tool's results carry raw credential values (`get` returns the
    // decrypted value, `rotate` echoes the new one) and `store` receives the
    // plaintext in args.value. Pattern redaction cannot recognize arbitrary
    // secret values, so scrub these before any persistence below.
    const canonical = stripSidekickPrefix(String(name || ""));
    if (canonical === "secret") {
      if (args && typeof args === "object" && args.value !== undefined) {
        args = { ...args, value: "[REDACTED]" };
      }
      if (success && ["get", "rotate"].includes(args?.action)) {
        // Phrased without redaction trigger words: summarizeResult re-applies
        // redactSensitive, which would rewrite e.g. "secret value" itself.
        summary = "(sensitive value withheld)";
      }
    }
    const redactedSummary = evolveCommon.summarizeResult(summary);
    const argsShape = evolveCommon.normalizeArgs(args || {});
    dbStore.appendToolLog({
      t: new Date().toISOString(),
      n: name,
      a: formatArgs(args),
      d: Math.round(duration),
      ok: success,
      s: redactedSummary,
      src: getCurrentSource(),
      session_id: metadata.sessionId || metadata.session_id || process.env.SIDEKICK_SESSION_ID || null,
      task_id: metadata.taskId || metadata.task_id || metadata.requestId || metadata.request_id || null,
      project: metadata.project || process.env.SIDEKICK_PROJECT || null,
      args_shape: argsShape,
      arg_fingerprint: evolveCommon.fingerprint(argsShape),
      error_category: success ? null : evolveCommon.errorCategory(redactedSummary),
      result_summary: redactedSummary,
      correlation_id: metadata.correlationId || metadata.correlation_id || null,
      parent_id: metadata.parentId || metadata.parent_id || null,
      execution_id: metadata.executionId || metadata.execution_id || null,
      step_number: metadata.stepNumber || metadata.step_number || null,
      retry: Boolean(metadata.retry),
      generated_procedure: metadata.generatedProcedure || metadata.generated_procedure || null,
      // Persisted via entry_json: attributes module-originated dispatches.
      module: metadata.module || null
    });
    recordPlatformToolCall(name, argsShape, Math.round(duration), success, redactedSummary, metadata);
    recordToolCallMemory({
      name,
      args,
      duration,
      success,
      summary: redactedSummary,
      source: getCurrentSource()
    });
  } catch (e) {}
}

function recordPlatformToolCall(name, argsShape, duration, success, summary, metadata = {}) {
  try {
    const currentSource = getCurrentSource();
    if (!["mcp", "approval"].includes(currentSource)) return;
    if (metadata.generatedProcedure || metadata.generated_procedure) return;
    const execId = metadata.executionId || metadata.execution_id || null;
    const guard = platformKernel.platformGuard(execId, null, {
      operation_type: "tool_call",
      tool_name: name,
      allowConcurrent: true,
    });
    if (guard.execution && execId) {
      platformKernel.transitionExecution(execId, success ? "completed" : "failed", {
        source: currentSource,
        reason: success ? `${currentSource} tool call completed` : `${currentSource} tool call failed`,
        result_status: success ? "success" : "failure",
        error_category: success ? null : evolveCommon.errorCategory(summary),
        result_summary: summary,
        correlation_id: guard.execution.root_execution_id,
      });
      return;
    }
    const startedAt = new Date(Date.now() - Math.max(Number(duration) || 0, 0)).toISOString();
    const execution = platformKernel.createExecution({
      execution_id: execId || undefined,
      parent_execution_id: metadata.parentId || metadata.parent_id || null,
      root_execution_id: metadata.rootExecutionId || metadata.root_execution_id || metadata.correlationId || metadata.correlation_id || metadata.executionId || metadata.execution_id || undefined,
      task_id: metadata.taskId || metadata.task_id || metadata.requestId || metadata.request_id || null,
      session_id: metadata.sessionId || metadata.session_id || process.env.SIDEKICK_SESSION_ID || null,
      project_id: metadata.project || process.env.SIDEKICK_PROJECT || null,
      actor_id: currentSource,
      client_id: currentSource,
      trigger_type: currentSource,
      operation_type: "tool_call",
      tool_name: name,
      tool_action: argsShape && typeof argsShape.action === "string" ? argsShape.action : null,
      risk: getToolRisk(name),
      started_at: startedAt,
      source: currentSource,
      correlation_id: metadata.correlationId || metadata.correlation_id || metadata.executionId || metadata.execution_id || null,
      metadata: {
        args_shape: argsShape,
        duration_ms: duration,
        legacy_tool_log: true,
      },
    });
    platformKernel.transitionExecution(execution.execution_id, "running", { source: currentSource, reason: `${currentSource} tool call started`, correlation_id: execution.root_execution_id });
    platformKernel.transitionExecution(execution.execution_id, success ? "completed" : "failed", {
      source: currentSource,
      reason: success ? `${currentSource} tool call completed` : `${currentSource} tool call failed`,
      result_status: success ? "success" : "failure",
      error_category: success ? null : evolveCommon.errorCategory(summary),
      result_summary: summary,
      correlation_id: execution.root_execution_id,
    });
  } catch (e) {}
}

function recordPlatformApprovalQueued(item) {
  try {
    const execution = platformKernel.createExecution({
      actor_id: item.source || "unknown",
      client_id: item.source || null,
      trigger_type: "approval",
      operation_type: "approval_request",
      tool_name: item.tool,
      risk: item.risk || "unknown",
      approval_state: "pending",
      deadline_at: item.expires_at || null,
      source: "approvals",
      correlation_id: item.id,
      metadata: {
        approval_id: item.id,
        approval_mode: item.mode,
        approval_reason: item.reason,
      },
    });
    item.platform_execution_id = execution.execution_id;
    platformKernel.transitionExecution(execution.execution_id, "awaiting_approval", {
      source: "approvals",
      actor_id: item.source || "unknown",
      reason: "approval requested",
      correlation_id: item.id,
    });
    platformKernel.appendEvent({
      event_type: "approval.requested",
      source: "approvals",
      actor_id: item.source || "unknown",
      subject_type: "approval",
      subject_id: item.id,
      execution_id: execution.execution_id,
      root_execution_id: execution.root_execution_id,
      payload: {
        approval_id: item.id,
        tool: item.tool,
        risk: item.risk,
        source: item.source,
        mode: item.mode,
        reason: item.reason,
        expires_at: item.expires_at,
      },
      correlation_id: item.id,
    });
  } catch (e) {}
}

function transitionPlatformApproval(item, state, details = {}) {
  try {
    if (!item.platform_execution_id) return;
    const guard = platformKernel.platformGuard(item.platform_execution_id, null, { allowTerminal: state === "failed" || state === "timed_out" });
    if (!guard.allowed && guard.reason === "terminal_state") return;
    platformKernel.transitionExecution(item.platform_execution_id, state, {
      source: "approvals",
      actor_id: details.actor_id || item.reviewed_by || item.source || "unknown",
      reason: details.reason,
      result_status: details.result_status,
      error_category: details.error_category,
      result_summary: details.result_summary,
      correlation_id: item.id,
    });
  } catch (e) {}
}

function recordPlatformApprovalEvent(item, eventType, payload = {}, options = {}) {
  try {
    platformKernel.appendEvent({
      event_type: eventType,
      source: "approvals",
      actor_id: options.actor_id || item.reviewed_by || item.source || "unknown",
      subject_type: "approval",
      subject_id: item.id,
      execution_id: item.platform_execution_id || null,
      root_execution_id: item.platform_execution_id || null,
      severity: options.severity || "info",
      payload: {
        approval_id: item.id,
        tool: item.tool,
        status: item.status,
        ...payload,
      },
      correlation_id: item.id,
    });
  } catch (e) {}
}

function recordPlatformChangeSet(item, decision, details = {}) {
  try {
    return platformKernel.createChangeSet({
      execution_id: item.platform_execution_id || null,
      approval_id: item.id,
      tool_name: item.tool,
      tool_action: details.tool_action || null,
      operation_type: "approval",
      state: decision,
      actor_id: details.actor_id || item.reviewed_by || item.source || "unknown",
      decision,
      reason: details.reason || null,
      args: details.args || item.args || {},
      result_summary: details.result_summary || null,
      project_id: details.project || null,
      source: "approvals",
    });
  } catch (e) { return null; }
}



// --- Metrics Tool ---

const TOOLS = {
  compute: computeTools.sidekick_compute,
  compute_nodes: computeTools.sidekick_compute_nodes,
  compute_providers: computeTools.sidekick_compute_providers,
  compute_models: computeTools.sidekick_compute_models,
  compute_jobs: computeTools.sidekick_compute_jobs,
  compute_route: computeTools.sidekick_compute_route,
};

const TOOL_DEFS = [
  { name: "bash", description: "Execute a shell command on the remote machine", args: { command: "string" } },
  { name: "tools", description: "Tool catalog, discovery manifest, and policy inspector. Use for broad questions like 'what Sidekick tools are available?', 'list available tools', 'tool overview', 'tool manifest', or 'why is this tool blocked?'. Lists tools grouped by category, searches by capability, gets exact tool metadata, and inspects effective policy/approval decisions.", args: { action: "string (overview|search|get|policy - default overview)", query: "string (optional, search terms for action=search)", name: "string (optional, tool name for action=get or action=policy)", category: "string (optional, filter by category)", source: "string (optional, comma-separated sources for action=policy; default mcp,dashboard,agent)", format: "string (optional, text|json - default text)", include_disabled: "boolean (optional, include policy-disabled tools - default false; action=policy includes them by default)", limit: "number (optional, max search results - default 100)" } },
  { name: "read", description: "Read a file from the remote filesystem", args: { path: "string" } },
  { name: "write", description: "Write content to a file on the remote machine", args: { path: "string", content: "string" } },
  { name: "list", description: "List files and directories on the remote machine", args: { path: "string" } },
  { name: "store", description: "Store a value persistently in KV storage", args: { key: "string", value: "string", project: "string (optional)" } },
  { name: "get", description: "Retrieve a stored value from KV storage", args: { key: "string" } },
  { name: "delete", description: "Delete a stored value from KV storage by key", args: { key: "string" } },
  { name: "resume", description: "Manage first-class project resume handoffs stored in the resume document. Use to check, set, clear, or list pending work without relying on ad hoc KV keys.", args: { action: "string (check|set|clear|list - default check)", project: "string (required for check/set/clear)", summary: "string (optional, for set)", next_step: "string (optional, for set)", status: "string (optional, for set - default active)", branch: "string (optional, for set)", url: "string (optional, for set)", notes: "string (optional)", plan_name: "string (optional, for set - descriptive handoff plan name)", current_phase: "number (optional, for set - current phase number within the named plan)", include_cleared: "boolean (optional, for list)", format: "string (optional, text|json - default text)" } },
  { name: "web_fetch", description: "Fetch a URL from the remote machine", args: { url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" } },
  { name: "llm", description: "Ask the LLM via Compute (provider and model are chosen by routing; private by default)", args: { prompt: "string", system: "string (optional)", temperature: "number (optional)" } },
  { name: "list_projects", description: "List all unique project names in KV storage", args: {} },
  { name: "get_by_project", description: "Get all keys and values for a specific project", args: { project: "string" } },
  { name: "search", description: "Search file contents using ripgrep or grep", args: { pattern: "string", path: "string (optional)", include: "string (optional)" } },
  { name: "git", description: "Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash)", args: { action: "string", path: "string (optional)", args: "string (optional)" } },
  { name: "notify", description: "Send notifications to Discord, Slack, or email", args: { channel: "string", webhook_url: "string (optional)", recipient: "string (optional)", message: "string", title: "string (optional)" } },
  { name: "process", description: "Manage processes (list, top CPU/memory, kill, tree)", args: { action: "string", filter: "string (optional)", pid: "number (optional)", name: "string (optional)", signal: "string (optional)" } },
  { name: "service", description: "Manage systemd services (start, stop, restart, status, enable, disable, logs)", args: { action: "string", service: "string", lines: "number (optional)" } },
  { name: "archive", description: "Create, extract, or list archives (tar.gz, zip)", args: { action: "string", path: "string", output: "string (optional)", format: "string (optional)" } },
  { name: "cron", description: "Schedule recurring tasks (add, list, remove, run jobs)", args: { action: "string", name: "string (optional)", schedule: "string (optional)", command: "string (optional)", id: "string (optional)" } },
  { name: "github", description: "GitHub API integration (PRs, issues, commits, releases)", args: { action: "string", repo: "string", args: "string (optional)" } },
  { name: "ci_status", description: "Read-only GitHub CI/check-run inspection for a PR head, commit SHA, ref, or branch", args: { repo: "string (owner/repository)", pr: "number|string (optional, PR number)", pull_number: "number|string (optional, PR number)", sha: "string (optional, commit SHA)", commit: "string (optional, commit SHA)", ref: "string (optional, branch/ref/SHA)", branch: "string (optional, branch name)", format: "string (optional, text|json - default text)" } },
  { name: "webhook", description: "Manage received webhooks (list, get, clear)", args: { action: "string", id: "string (optional)", limit: "number (optional)" } },
  { name: "context", description: "Persistent intelligent context management (track projects, decisions, problems, patterns, sessions, automatic memories; recall and suggest based on past context)", args: { action: "string", project: "string (optional)", context: "string (optional)", decision: "string (optional)", reasoning: "string (optional)", problem: "string (optional)", solution: "string (optional)", pattern: "string (optional)", query: "string (optional)", type: "string (optional: decisions|problems|patterns|projects|sessions|memories|all)", limit: "number (optional)" } },
  { name: "session", description: "Explicit task/session memory envelope. Begin, checkpoint, end, abandon, resume, and list scoped work with a purpose-built memory brief.", args: { action: "string (begin|update|checkpoint|end|abandon|resume|status|list)", id: "string (optional task/session id)", goal: "string (required for begin)", project: "string (optional)", source: "string (optional)", working_directory: "string (optional)", repository: "string (optional)", branch: "string (optional)", environment: "string (optional)", tags: "string|array (optional)", current_plan: "string (optional)", completed_steps: "array (optional)", blockers: "array (optional)", next_step: "string (optional)", outcome: "string (optional)", final_summary: "string (optional)", acceptance_state: "string (optional)", verified_facts: "array (optional)", decisions: "array (optional)", failed_approaches: "array (optional)", follow_ups: "array (optional)" } },
  { name: "handoff", description: "First-class handoff storage and ingestion. Preserves full handoff artifacts while extracting redacted, evidence-linked structured memories idempotently. get/inspect require id or key; use list or resume check for project-level queries.", args: { action: "string (create|update|get|list|compare|inspect|reprocess|archive)", id: "string (required for get/inspect, optional for other actions)", key: "string (required for get/inspect when id is omitted, optional for other actions)", project: "string (optional, for create/update/list/compare)", title: "string (optional)", content: "string (for create/update)", source: "string (optional)", task_id: "string (optional)", include_archived: "boolean (optional)", limit: "number (optional)" } },
  { name: "memory", description: "Typed memory operations: remember, query, explain, correct, forget, pin, expire, inspect conflicts/health, and backfill high-semantic sources such as handoffs.", args: { action: "string (remember|query|explain|list|get|confirm|correct|forget|pin|expire|conflicts|health|backfill)", id: "string (optional memory id)", project: "string (optional)", type: "string (optional)", memory_class: "string (optional semantic|episodic|procedural|working|prospective|negative|relational|artifact|observational|capability)", content: "string (for remember)", summary: "string (optional)", scope_type: "string (optional)", scope_id: "string (optional)", source: "string (optional)", evidence: "string (optional)", confidence: "number (optional)", tags: "string|array (optional)", query: "string (for query)", limit: "number (optional)", correct_to: "string (for correct)", fresh_eyes: "boolean (optional)", historical: "boolean (optional)" } },
  { name: "teach", description: "Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows", args: { action: "string", name: "string (optional)", description: "string (optional)", steps: "array (optional)", parameters: "object (optional)", args: "object (optional)", example: "string (optional)", trigger_phrases: "array (optional)", implementation: "string (optional)" } },
  { name: "health", description: "Composite system health checks with scoring and issue detection", args: { check: "string (all|services|processes|disk|network|custom|modules)", services: "string (optional, comma-separated service names)", commands: "string (optional, comma-separated commands for custom check)", threshold: "string (optional, e.g. 'disk>90,mem>80')" } },
  { name: "delay", description: "One-shot task scheduling: run a tool once at a specific time or after a delay", args: { action: "string (add|list|cancel|run)", id: "string (optional, for cancel/run)", when: "string (optional, e.g. 10s, 5m, 2h, 1d, or ISO date)", name: "string (optional, human-readable name)", tool: "string (optional, tool name to execute)", args: "object (optional, arguments for the tool)" } },
  { name: "snapshot", description: "Capture system state and detect drift by comparing snapshots", args: { action: "string (capture|compare|list|delete)", name: "string (snapshot name)", capture: "string (optional, comma-separated: processes,services,disk,packages,network,files:/path)", compare: "string (optional, baseline snapshot name for compare action)" } },
  { name: "watch", description: "Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions", args: { action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, URL, or file path)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" } },
  { name: "secret", description: "Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env)", args: { action: "string (store|get|delete|list|rotate)", key: "string (secret name)", value: "string (optional, for store)", generate: "string (optional, length for rotate, e.g. '32')" } },
  { name: "security_scan", description: "Read-only audit for tracked sensitive files, secret signatures, hardcoded credential settings, runtime .env safety, and sensitive-file permissions. Reports metadata only and never returns secret values.", args: { path: "string (optional, directory to scan - default Sidekick repo)", max_files: "number (optional, bounded 1-10000 - default 2000)", format: "string (optional, text|json - default text)" } },
  { name: "hash", description: "Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification", args: { input: "string (optional, data to hash)", path: "string (optional, file path to hash)", algorithm: "string (optional, md5|sha1|sha256|sha512 - default sha256)", verify: "string (optional, expected hash to verify against)" } },
  { name: "queue", description: "Persistent task queue with priorities", args: { action: "string (add|list|process|remove|clear)", id: "number (optional, task id for remove)", tool: "string (optional, tool name for add)", args: "object (optional, tool args for add)", priority: "number (optional, priority for add, default 0)", status: "string (optional, status filter for list/clear)" } },
  { name: "retry", description: "Retry tool calls with exponential backoff", args: { tool: "string (tool to retry)", args: "object (optional, tool args)", max_attempts: "number (optional, default 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" } },
  { name: "evolve", description: "Evidence-driven workflow learning and generated-tool lifecycle management. Mines successful bounded workflows, validates parameterized procedures, and exposes approved trial/active generated tools through normal discovery.", args: { action: "string (analyze|candidates|inspect|validate|approve|activate_trial|promote|reject|deprecate|feedback|report|cleanup)", id: "string (optional, candidate/generated capability id or name)", approver: "string (optional)", useful: "boolean (optional, for feedback)", notes: "string (optional)", reason: "string (optional)", limit: "number (optional, logs to analyze)" } },
  { name: "orchestrate", description: "Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress", args: { action: "string (create|execute|list|status|cancel)", id: "number (optional, task id for execute/status/cancel)", task_name: "string (optional, task name for create)", subtasks: "array (optional, subtask definitions for create)", dependencies: "object (optional, dependency map for create)", timeout: "number (optional, timeout in ms, default 1800000)" } },
  { name: "predict", description: "Evidence-backed prediction and decision-support engine. Analyzes correlated tool history, incidents, and workflows within an explicit scope to identify likely next actions, failure risks, missing prerequisites, incident recurrence, and workflow opportunities. Every persisted prediction passes an evidence and confidence admission gate.", args: { action: "string (analyze|list|get|feedback|outcome|dismiss|explain|status|suggest|migrate|purge_preview|purge|diagnose)", id: "string (optional, prediction ID)", type: "string (optional, filter by type)", project: "string (optional, project scope)", session_id: "string (optional)", task_id: "string (optional)", feedback: "string (optional, useful|not_useful|incorrect|already_known|acted_on|dismissed)", outcome: "string (optional, confirmed|did_not_occur|action_succeeded|action_failed|expired|superseded|unresolved)", limit: "number (optional, max results - default 20)", status: "string (optional, filter by status)", confidence: "string (optional, filter by confidence)", maxAge: "string (optional, analysis window - default 7d)", scope: "string (optional, project|session|task|global - required for analyze; use global to deliberately analyze every project)", confirm: "boolean (optional, required true to execute purge)", retention_days: "number (optional, override retention for purge_preview/purge)", purge_legacy: "boolean (optional, also purge legacy pre-v2 terminal predictions, preserved by default)" } },
  { name: "debug_tool", description: "Structured debugging cache with persistent storage for cross-session debugging. Store findings, recall past investigations, cleanup old entries.", args: { action: "string (store|recall|cleanup|start|stop|cache|get|status|clear)", session_name: "string (optional, session identifier for legacy actions)", key: "string (optional, cache key for get/cache, or debug key for cleanup)", value: "string (optional, value to cache/store)", service: "string (optional, service name for store/recall)", issue: "string (optional, issue description for store)", redact: "boolean (optional, default true - set false to skip redaction)" } },
  { name: "fresheyes", description: "Get a fresh perspective from Sidekick's LLM (Grok) on a problem. Sends sanitized context for independent analysis", args: { problem: "string (problem description)", context: "string (optional, relevant context)", files: "array (optional, files analyzed)", hypotheses: "array (optional, current hypotheses)", full_response: "boolean (optional, return full response vs key insights)" } },
  { name: "batch", description: "Execute multiple tool calls in one request to reduce API round-trips. Max 20 calls per batch.", args: { calls: "array (array of { tool: string, args: object })" } },
  { name: "cache", description: "Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL.", args: { action: "string (get|set|clear|list)", key: "string (cache key)", ttl: "string (optional, e.g. 30s, 5m, 1h - default 5m)", value: "string (value to cache, for set action)" } },
  { name: "summarize", description: "Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats.", args: { path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" } },
  { name: "filter", description: "Filter file contents or directory listings by pattern, date, or size before returning.", args: { path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" } },
  { name: "project", description: "Get complete project context in one call: KV entries, context tracking, recent logs, procedures.", args: { name: "string (project name)", include: "string (optional, comma-separated: kv,context,logs,procedures - default kv,context)" } },
  { name: "memory_export", description: "Export structured memories to JSON for backup, portability, or machine-to-machine transfer.", args: { project: "string (optional, filter by project)", type: "string (optional, filter by memory type)", include_disabled: "boolean (optional, include disabled memories - default true)", automatic_only: "boolean (optional, only automatic memories - default false)" } },
  { name: "memory_import", description: "Import memories from JSON export. Supports merge (update existing) or skip conflict modes.", args: { data: "string|object (JSON export data or parsed object)", on_conflict: "string (optional, merge|skip - default merge)", preserve_ids: "boolean (optional, preserve original IDs - default false)" } },
  { name: "memory_manage", description: "Manage memory lifecycle: confirm, delete, disable, expire, restore, set auto-expire, list by state, pending confirmations, process auto-expirations. Delete, disable, expire, and restore also support legacy context entry IDs such as sessions.", args: { action: "string (confirm|set_requires_confirmation|delete|disable|expire|restore|set_auto_expire|list_by_state|pending_confirmations|process_auto_expirations)", id: "string (memory/context ID, or state name for list_by_state)", confirmed_by: "string (optional, who confirmed - default 'user')", days: "number (for set_auto_expire)", reason: "string (optional, reason for delete/disable/expire)", limit: "number (optional, for list operations - default 50)", project: "string (optional, filter by project for list operations)" } },
  { name: "sync_identity", description: "Manage machine and user identity for cross-machine sync. Get or set machine_id and user_id.", args: { action: "string (get|set_user)", user_id: "string (required for set_user action)" } },
  { name: "sync_export", description: "Export memories for cross-machine sync. Includes origin tracking and sync metadata.", args: { project: "string (optional, filter by project)", since: "string (optional, ISO timestamp - only export memories updated after this time)", include_disabled: "boolean (optional, include disabled memories - default true)" } },
  { name: "sync_import", description: "Import memories from another machine's sync export. Supports conflict resolution strategies.", args: { data: "string|object (sync export data)", strategy: "string (optional, newest|highest_confidence|most_confirmed|merge|skip - default newest)", preserve_ids: "boolean (optional, preserve original IDs - default false)" } },
  { name: "sync_diff", description: "Get list of memories changed since a given timestamp. Useful for incremental sync.", args: { since: "string (ISO timestamp - get changes after this time)" } },
  { name: "tail", description: "Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file.", args: { source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" } },
  { name: "diff_files", description: "Compare two files directly without reading both into context. Returns unified diff or summary.", args: { path_a: "string (first file path)", path_b: "string (second file path)", format: "string (optional, unified|summary - default unified)" } },
  { name: "find", description: "Advanced file finder: search by name pattern, date range, size range, and content pattern.", args: { path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" } },
  { name: "status", description: "Unified system status: services, disk, memory, load, uptime, top processes, platform modules in one call.", args: { include: "string (optional, comma-separated: services,disk,memory,load,uptime,processes,modules - default services,disk)", services: "string (optional, comma-separated service names - default sidekick-mcp,sidekick-dashboard,sidekick-agent)" } },
  { name: "anonymize", description: "Replace sensitive data with realistic but fake values. Preserves data structure while making it safe to share externally.", args: { action: "string (anonymize|patterns|add_pattern|remove_pattern)", input: "string (optional, text to anonymize)", format: "string (optional, text|json|yaml - default text)", custom_patterns: "array (optional, {pattern, replacement} objects)", consistency: "boolean (optional, same input always maps to same output - default true)" } },
  { name: "sandbox", description: "Execute operations in a tracked context with automatic backup and rollback. Safe experimentation on remote systems.", args: { action: "string (exec|rollback|list|diff|clean)", sandbox_name: "string (optional, sandbox identifier)", command: "string (optional, command to execute)", files: "array (optional, files to auto-backup before exec)", auto_backup: "boolean (optional, default true)", rollback_id: "string (optional, sandbox to rollback)" } },
  { name: "changelog", description: "Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries.", args: { action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" } },
  { name: "netdiag", description: "Unified network diagnostics: DNS, routing, port scanning, connectivity checks, and local listeners.", args: { action: "string (check|dns|route|ports|listeners|connectivity)", target: "string (host, URL, or IP to diagnose)", port_range: "string (optional, port range e.g. '80-443')", timeout: "number (optional, timeout in ms - default 5000)", format: "string (optional, detailed|compact|json - default detailed)" } },
  { name: "timeline", description: "Build chronological timeline from multiple log sources. Correlates events across log.jsonl, journalctl, git, and file modifications.", args: { action: "string (build|filter|export)", since: "string (start time: ISO or relative like 1h, 1d)", until: "string (optional, end time - default now)", sources: "array (optional, log.jsonl|journalctl|git|files|all - default all)", pattern: "string (optional, regex filter)", severity: "string (optional, error|warn|info|all - default all)", format: "string (optional, compact|detailed|json - default compact)", max_events: "number (optional, default 200)" } },
  { name: "circuit", description: "Circuit breaker for tool calls. Prevents cascading failures by fast-failing when a target is down.", args: { action: "string (call|status|reset|configure)", target: "string (circuit target label)", tool: "string (optional, tool name for call action)", args: "object (optional, tool arguments for call action)", failure_threshold: "number (optional, failures before opening - default 5)", cooldown_seconds: "number (optional, seconds before half-open - default 60)", cache_response: "boolean (optional, cache last successful response - default false)" } },
  { name: "baseline", description: "Behavioral baseline and anomaly detection. Learns normal patterns and detects statistical deviations.", args: { action: "string (record|learn|check|status|reset)", metric_name: "string (metric identifier)", value: "number (optional, value to record)", source: "string (optional, health|custom|command)", command: "string (optional, command to collect metric)", window: "string (optional, history window - default 7d)", sensitivity: "string (optional, low|medium|high - default medium)" } },
  { name: "depend", description: "Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis.", args: { action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" } },
  { name: "runbook", description: "Operational runbook executor with autonomous and guided modes. Supports verification, rollback, and step-by-step execution.", args: { action: "string (create|start|next|verify|rollback|abort|list|get|delete)", name: "string (optional, runbook name)", mode: "string (optional, autonomous|guided - default autonomous)", steps: "array (optional, step definitions)", runbook_id: "string (optional, instance or definition ID)", step_index: "number (optional, step index)" } },
  { name: "ops", description: "Packaged Sidekick operations workflows for deploy verification, restart smoke tests, deployments, and incident snapshots.", args: { action: "string (verify_deployed_commit|restart_and_smoke_test|deploy_current_main|incident_snapshot)", repo_path: "string (optional, repository path - default current Sidekick repo)", restart_mcp: "boolean (optional, schedule sidekick-mcp restart for restart_and_smoke_test)" } },
  { name: "mission", description: "Mission Control intent router for Sidekick operations. Profiles, routes, preflights, and executes common intents through safer existing tools before raw shell.", args: { action: "string (profiles|route|preflight|execute - default route)", intent: "string (user goal or operation intent)", profile: "string (read_only_audit|trusted_vps|production|danger_zone - default trusted_vps)", confirm: "boolean (required true for mutating execute routes)", key: "string (optional, KV key for delete missions)", project: "string (optional, project for memory missions)", query: "string (optional, search query for tool discovery)", include: "string (optional, include sections for status/project)", services: "string (optional, services for status)", repo_path: "string (optional, repo for deploy workflows)", limit: "number (optional, result limit)", tool: "string (optional, tool filter for logs)", source: "string (optional, source filter for logs)", format: "string (optional, output format for tool discovery)" } },
  { name: "black_box", description: "Structured Black Box incident evidence system: captures profiled system context, stores searchable incidents/captures/sources/observations, supports live status, evidence-cited analysis, comparison, retention, export, and legacy list/get/delete compatibility.", args: { action: "string (capture|capture_status|cancel_capture|list|list_incidents|get|get_incident|list_captures|get_capture|list_sources|get_source|search|analyze|compare|add_note|update_incident|pin|extend_retention|archive|export|delete|storage_status|purge_preview|purge|profiles)", name: "string (optional, incident title)", profile: "string (optional, quick|standard|deep|network|service|sidekick|repository|custom)", include: "array (optional, legacy sections or collector keys)", incident_id: "string (optional)", capture_id: "string (optional)", source_id: "string (optional)", query: "string (optional)", analyze_with_llm: "boolean (optional)", retention_class: "string (optional)", confirm: "boolean (optional for purge)" } },
  { name: "respond", description: "Return a text response directly without calling other tools. Use this for simple answers or when no tool action is needed.", args: { text: "string (the response text to return)" } },
  { name: "db_schema", description: "Inspect database schema: tables, columns, indexes, foreign keys", args: { table: "string (optional, specific table name)", verbose: "boolean (optional, include row counts and detailed info)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "db_query", description: "Execute raw SQL queries with safety limits (readonly by default)", args: { sql: "string (SQL query)", params: "array (optional, query parameters)", readonly: "boolean (optional, default true - blocks writes)", limit: "number (optional, max rows - default 1000)", timeout: "number (optional, query timeout in ms - default 5000)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "db_stats", description: "Database statistics: size, table sizes, WAL status, cache hit ratio", args: { detailed: "boolean (optional, include per-table stats)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "db_backup", description: "Create timestamped database backup with optional compression", args: { path: "string (optional, output path - default data/backups/)", compress: "boolean (optional, gzip compression - default true)" } },
  { name: "db_restore", description: "Restore database from backup with integrity verification", args: { path: "string (backup file path)", verify: "boolean (optional, check integrity before restore - default true)" } },
  { name: "log_query", description: "Advanced tool_logs filtering by time, tool, source, status", args: { tool: "string (optional, filter by tool name)", source: "string (optional, filter by source: mcp/agent/dashboard)", success: "boolean (optional, filter by success status)", since: "string (optional, ISO timestamp or relative: 1h, 1d)", until: "string (optional, ISO timestamp)", limit: "number (optional, max results - default 100)" } },
  { name: "db_export", description: "Export tables to JSON, CSV, or SQL format", args: { table: "string (optional, specific table - exports all if omitted)", format: "string (optional, json|csv|sql - default json)", path: "string (optional, output file path)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "db_search", description: "Full-text search across all tables", args: { query: "string (search terms)", tables: "string (optional, comma-separated table names)", limit: "number (optional, max results - default 50)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "db_migrate", description: "Schema migrations with versioning and rollback", args: { action: "string (status|list|up)", version: "number (optional, target version)", name: "string (optional, migration filename for up action)" } },
  { name: "db_diff", description: "Compare two database snapshots, show what changed", args: { snapshot_a: "string (optional, path to snapshot A or 'current')", snapshot_b: "string (optional, path to snapshot B or 'current')", table: "string (optional, specific table to compare)" } },
  { name: "redis", description: "Redis operations: get, set, del, keys, ttl, info, flush. Requires sidekick-redis service.", args: { action: "string (get|set|del|keys|ttl|info|flush)", key: "string (optional, Redis key)", value: "string (optional, value for set)", ttl: "string (optional, TTL in seconds for set)", pattern: "string (optional, pattern for keys - default '*')" } },
  { name: "ocr", description: "Extract text from images using Tesseract OCR", args: { path: "string (image file path)", language: "string (optional, language code - default eng)", psm: "number (optional, page segmentation mode)" } },
  { name: "media", description: "Media processing with ffmpeg: convert, extract audio, thumbnails, resize, trim, info", args: { action: "string (info|convert|extract_audio|thumbnail|resize|trim)", input: "string (input file path)", output: "string (optional, output file path)", options: "string (optional, format-specific options)" } },
  { name: "transcribe", description: "Transcribe audio/video to text using Whisper", args: { path: "string (audio/video file path)", model: "string (optional, tiny|base|small|medium - default base)", language: "string (optional, language code)" } },
  { name: "analytics", description: "Fast analytical queries on CSV/JSON/Parquet files using DuckDB", args: { query: "string (SQL query)", file: "string (optional, data file path - CSV, JSON, or Parquet)", format: "string (optional, file format: csv|json|parquet - auto-detected)" } },
  { name: "insight_report", description: "Create a concise, evidence-backed report from text, data, or image file paths", args: { paths: "string|array (file path, comma-separated paths, or array of paths)", title: "string (optional report title)" } },
  { name: "embed", description: "Generate text embeddings via Compute (private by default)", args: { text: "string (text to embed)", model: "string (optional, embedding model - default nomic-embed-text)" } },
  { name: "ollama", description: "Manage Ollama models: list, ps, pull, show", args: { action: "string (list|ps|pull|show)", model: "string (optional, model name for pull/show)" } },
  { name: "tunnel", description: "Manage Cloudflare tunnels: start, stop, list", args: { action: "string (start|stop|list)", port: "number (local port to expose)", name: "string (optional, tunnel name)" } },
  { name: "download", description: "Download videos/audio from YouTube and 1000+ sites using yt-dlp", args: { url: "string (video URL)", output: "string (optional, output path)", format: "string (optional, video format)", audio_only: "boolean (optional, extract audio only)" } },
  { name: "wireguard", description: "Manage WireGuard VPN: status, list_peers, add_peer, remove_peer, generate_keypair", args: { action: "string (status|list_peers|add_peer|remove_peer|generate_keypair)", interface_name: "string (WireGuard interface, e.g. wg0)", peer_name: "string (peer name for add_peer)", public_key: "string (peer public key)", endpoint: "string (optional, peer endpoint IP:port)", allowed_ips: "string (optional, allowed IPs, default 10.0.0.0/24)" } },
  { name: "nginx", description: "Manage Nginx reverse proxy: status, list_sites, add_site, remove_site, test_config, reload", args: { action: "string (status|list_sites|add_site|remove_site|test_config|reload)", site_name: "string (site config name)", domain: "string (domain name for add_site)", upstream_port: "number (local port to proxy to)", ssl_email: "string (optional, email for Let's Encrypt)" } },
  { name: "knowledge", description: "Knowledge base management: search, get, list, add, update, soft-delete, and purge disabled entries", args: { action: "string (search|get|list|add|update|delete|purge)", id: "number (optional, entry ID for get/update/delete/purge)", category: "string (optional, category for list/add/update)", title: "string (optional, title for add/update)", content: "string (optional, content for add/update)", tags: "string (optional, comma-separated tags for add/update)", query: "string (optional, search query for search)", limit: "number (optional, max results for search/list)" } },
  { name: "metrics", description: "Metrics collection and querying with InfluxDB: write metrics, query data, list measurements and fields", args: { action: "string (write|query|list_measurements|list_fields)", measurement: "string (measurement name for write/list_fields)", fields: "object (field values for write)", tags: "object (optional, tags for write)", timestamp: "number (optional, nanosecond timestamp for write)", query: "string (Flux query for query action)", time_range: "string (optional, time range for list_fields, e.g. -30d)" } },
  { name: "compute", description: "Sidekick Compute: provider-neutral inference and compute system. List providers, check health, get system overview.", args: { action: "string (overview|init)" } },
  { name: "compute_nodes", description: "Manage compute worker nodes and enrollment tokens: list, get, heartbeat, revoke, maintenance mode, stats, create/list tokens, enroll", args: { action: "string (list|get|heartbeat|revoke|maintenance|stats|create_token|list_tokens|enroll)", node_id: "string (worker node ID for get/heartbeat/revoke/maintenance/enroll)", worker_id: "string (worker ID for dashboard lifecycle actions)", token: "string (enrollment token for enroll)", display_name: "string (worker or token display name)", platform: "string (worker platform for enroll)", architecture: "string (optional, worker architecture)", reason: "string (optional, revoke reason)", enable: "boolean (optional, maintenance action: true returns worker to enabled service; false places it into maintenance)", state: "string (optional, filter by worker state for list)", hardware_type: "string (optional, filter by hardware_type for list)", provider: "string (optional, filter by provider for list)" } },
  { name: "compute_providers", description: "Manage compute providers (Ollama, OpenAI, vLLM, etc.): list, get, create, update, delete, health check", args: { action: "string (list|get|create|update|delete|health|health_all)", provider_id: "string (provider ID for get/update/delete/health)", name: "string (display name; required for create)", type: "string (provider type; required for create: ollama|openai|vllm|llamacpp|mlx|mock; filters list)", base_url: "string (base URL for create/update)", api_key: "string (optional, recorded but NOT used to authenticate — no adapter reads it; do not paste a live credential)", priority: "number (optional, placement priority; HIGHER wins, default 50)", enabled: "boolean (optional, enable/disable; filters list)", trust_level: "string (optional placement gate: untrusted|limited|trusted|privileged; registry default 'private' ranks equal to trusted)", capabilities: "string[] (optional, descriptive only — placement gates on MODEL capabilities)", mode: "string (optional, direct|worker, default direct)", tls_policy: "string (optional, require|prefer|off, default prefer)", cost_policy: "string (optional, default free)", data_classifications: "string[] (optional placement gate: public|internal|private|sensitive|restricted; default public/internal/private)" } },
  { name: "compute_models", description: "Manage compute models: list, get, create, update, delete, discover from providers. Note: discover only LISTS what a provider currently serves — it does not register anything; use create to add a model to the registry", args: { action: "string (list|get|create|update|delete|discover)", model_id: "string (model ID for get/update/delete)", provider_id: "string (required for create; filters list)", model_name: "string (display name; required for create)", provider_model_name: "string (name on the provider, e.g. qwen3.5:latest; required for create)", family: "string (optional, stored as metadata)", parameter_count: "string (optional, e.g. 7b, 13b, 70b; stored as metadata)", context_length: "number (optional, context window size)", supports_vision: "boolean (optional; filters list)", supports_tools: "boolean (optional)", supports_embedding: "boolean (optional; filters list)", supports_structured_output: "boolean (optional)", min_vram_gb: "number (optional, minimum VRAM in GB)", capabilities: "string[] (optional, e.g. chat, generate, embeddings; placement gates on these — a model advertising none cannot be selected)", capability: "string (optional, filter list by one capability)", preferred_workloads: "string[] (optional)", quantization: "string (optional, e.g. Q4_K_M)", enabled: "boolean (optional; filters list)" } },
  { name: "compute_jobs", description: "Manage allowlisted compute jobs: list, get, create, cancel, retry, recover, view stats and artifacts", args: { action: "string (list|get|create|cancel|retry|recover|stats|artifacts|reconcile_artifact_custody)", job_id: "string (job ID for get/cancel/retry/artifacts)", job_type: "string (canonical job type for create: chat|generate|embeddings|text_embedding)", capability: "string (optional, requested capability for create, preserved exactly, e.g. openvino.text_embedding)", request_payload: "object (optional, structured executor request payload for create; validated by the job contract and executor rules)", capability_requirements: "object (optional, capability requirements for create, e.g. { executor, model })", data_classification: "string (optional, public|internal|private for create; preserved when supplied)", prompt: "string (optional, create convenience mapped to request_payload.prompt)", model: "string (optional, create convenience mapped to request_payload.model)", provider: "string (optional, create convenience mapped to request_payload.provider)", timeout_ms: "number (optional, job timeout ms for create)", max_retries: "number (optional, retries after first attempt for create)", idempotency_key: "string (optional, idempotency key for create)", reason: "string (optional, cancellation/retry reason)", status: "string (optional, filter by status for list)", limit: "number (optional, max results for list)", project: "string (optional, create metadata or list filter)", provider_id: "string (optional, filter by provider for list)", worker_id: "string (optional, filter by worker for list)", confirm: "boolean (optional, execute reconcile_artifact_custody; omitted or false is a dry run)" } },
  { name: "compute_route", description: "Explain routing decisions and manage routing rules for allowlisted compute workloads", args: { action: "string (explain|list_rules|create_rule|delete_rule)", workload_class: "string (chat|generate|embeddings for explain)", capabilities_required: "string (comma-separated capabilities for explain)", data_classification: "string (public|internal|private for explain)", trust_level: "string (untrusted|community|known|trusted|internal for explain)", rule_id: "string (routing rule ID for delete_rule)", rule_name: "string (rule name for create_rule)", priority: "number (rule priority for create_rule, lower=higher)", description: "string (optional, rule description for create_rule)", preferred_providers: "array (preferred provider IDs for create_rule)", preferred_models: "array (preferred model IDs for create_rule)", fallback_providers: "array (optional, fallback provider IDs for create_rule)", max_latency_ms: "number (optional, max latency requirement for create_rule)" } },
  { name: "module", description: "Inspect and operate platform module lifecycle state through the shared policy and approval path", args: { action: "string (list|get|health|status|check|recover|enable|disable - default list)", name: "string (module name for get/health/status/check/recover/enable/disable)" } },
  { name: "project_registry", description: "Canonical project registry: list, inspect, register, and archive projects and their recorded data sources; backfill project sources from existing stores (dry-run by default)", args: { action: "string (list|get|register|archive|sources|backfill)", project: "string (project id; required for get/register/archive/sources)", state: "string (optional, filter by state for list: active|archived)", limit: "number (optional, max results for list)", display_name: "string (optional, for register)", description: "string (optional, for register)", reason: "string (optional, for archive)", confirm: "boolean (required true for backfill with dry_run=false)", dry_run: "boolean (optional, for backfill - default true, report without writing)" } },
  { name: "capability", description: "Manage Sidekick capability packs: list installed and bundled packs, inspect a package, install, configure, enable, disable, check health, upgrade and uninstall. Installing or enabling a pack activates executable module code in the Sidekick process", args: { action: "string (list|available|show|inspect|install|configure|enable|disable|health|upgrade|uninstall - default list)", name: "string (pack name)", path: "string (server-local package path)", config: "object (pack configuration)", enable: "boolean (enable immediately after install)", allow_same_version: "boolean (upgrade: allow same-version replacement)", allow_downgrade: "boolean (upgrade: allow downgrade)", remove_knowledge: "boolean (uninstall: remove knowledge entries, default true)", remove_module_data: "boolean (uninstall: remove module-owned data where permitted)" } },
  { name: "workflow", description: "List, inspect and run registered workflow definitions, including those contributed by capability packs. Each step executes as a governed tool call through the single dispatcher with durable execution state, checkpoints, cancellation and approval continuation", args: { action: "string (list|show|run|resume - default list)", name: "string (workflow definition name)", inputs: "object (workflow inputs)", project: "string (canonical project name)", run_id: "string (run id for resume)", owner: "string (filter by owning pack)", include_evidence: "boolean (include full step evidence)" } },
  { name: "connector", description: "Inspect the platform connector authority: list registered connectors (GitHub, ...), get one by id, or read recent lifecycle events. Read-only; credential references are never exposed (only has_secret_ref)", args: { action: "string (list|get|events - default list)", connector_id: "string (required for get/events)", type: "string (optional, filter by type for list)", state: "string (optional, filter by state for list)", limit: "number (optional, max rows/events)" } },
];

module.exports = {
  TOOLS,
  TOOL_DEFS,
  callTool,
  logToolCall,
  setSource,
  DATA_DIR,
  OLLAMA_URL,
  GROQ_API_KEY,
  GROQ_MODEL,
  loadProcedures,
  loadDelays,
  saveDelays,
  loadWatches,
  saveWatches,
  isDangerous,
  getToolRisk,
  getToolPolicyDecision,
  getApprovalDecision,
  listApprovals,
  renderContinuationApprovalPreview,
  supersedeLegacyApprovalForTask,
  queueApproval,
  resolveApproval,
  claimApprovalExecution,
  renewApprovalLease,
  recoverStaleApprovals,
  finalizeApprovalExecution,
  createScheduledPlatformExecution,
  transitionScheduledPlatformExecution,
  appendScheduledPlatformEvent,
  releaseScheduledClaim,
  startScheduledLeaseRenewal,
  recoverStrandedDelays,
  claimScheduledDefinition,
  pauseWatchForCancel,
  recoverStrandedRunbooks,
  getToolDefsForSource,
  getToolCategoriesWithTools,
  buildPolicyInspection,
  summarizePolicyInspection,
  parseGithubArgs,
  getGithubArg,
  getCiRevisionSelector,
  buildCiStatusResult,
  formatCiStatusText,
  missionRoute,
  enforceToolPolicy,
  syncToolRegistry,
};
