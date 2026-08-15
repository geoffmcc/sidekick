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
const { TOOLS } = require("./tools/legacy-tool-map");
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
const {
  recordPlatformApprovalQueued,
  transitionPlatformApproval,
  recordPlatformApprovalEvent,
  recordPlatformChangeSet,
} = require("./tools/platform-approval");
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

    // Intersect the DB catalog with the LIVE registry (builtin descriptors,
    // which include active module tools, plus trial/active generated
    // capabilities) the way src/agent.js's Brain allowlist does. The tools
    // table is a mirror synced at startup; between syncs it can hold rows for
    // tools that no longer exist in code, and a stale row must never be
    // advertised to any consumer as callable — the dispatcher would refuse it
    // anyway. Lazy require: the facade is fully initialized by the time this
    // runs, so no load-order cycle. If the live registry cannot be read the
    // filter is skipped (mirror-only behavior, as before) rather than hiding
    // everything.
    let liveNames = null;
    try {
      liveNames = new Set(require("./tools/index").getBuiltinRegistry().toolDefs().map(def => stripSidekickPrefix(def.name)));
      for (const generated of dbStore.listGeneratedCapabilities({ states: ["trial", "active"] })) {
        liveNames.add(stripSidekickPrefix(generated.name));
      }
    } catch { liveNames = null; }

    return tools.filter(tool => !liveNames || liveNames.has(stripSidekickPrefix(tool.name))).map(tool => {
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

const { TOOL_DEFS } = require("./tools/legacy-catalog");

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
