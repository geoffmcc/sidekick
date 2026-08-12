const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync, execFileSync } = require("child_process");
const { redactSensitive } = require("./redact");
const evolveCommon = require("./evolve/common");
const dbStore = require("./db");
const { recordToolCallMemory, buildMemoryBrief, recallMemoryForText } = require("./memory");
const dynamicTools = require("./dynamic-tools");
const platformKernel = require("./platform/kernel");
const { stripSidekickPrefix } = require("./core/tool-name");
const computeTools = require("./compute/tools");
const { TOOL_RISK, TOOL_CATEGORIES, RISK_LEVELS } = require("./tools/metadata");
const toolContext = require("./tools/context");
const { loadContext: loadSharedContext, findContextItemById: findSharedContextItemById, updateLegacyContextItem: updateSharedLegacyContextItem } = require("./tools/families/context");
const { parsePolicyList, sourceEnvName } = require("./core/policy-env");
const { getPathPolicyDecision, enforcePathPolicy } = require("./tools/path-policy");
const { sidekick_status } = require("./tools/families/observability");
const { sidekick_llm } = require("./tools/families/inference");
const { isDangerous } = require("./tools/families/shell");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

fs.mkdirSync(DATA_DIR, { recursive: true });

const LOG_FILE = path.join(DATA_DIR, "log.jsonl");
const CRON_FILE = path.join(DATA_DIR, "cron.json");
const WEBHOOK_FILE = path.join(DATA_DIR, "webhooks.json");
const PROCEDURES_FILE = path.join(DATA_DIR, "procedures.json");
const MAX_LOG = 1000;

const PROJECT_RE = /^[a-z][a-z0-9_]*$/;

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
function getToolRisk(name) {
  // Module tools first: the registry wins dispatch for these names, so the
  // enforced risk must be the risk of what actually executes. Lazy require —
  // the loader has no top-level dependency back into this module.
  const moduleDescriptor = require("./modules/loader").resolveActiveDescriptor(name);
  if (moduleDescriptor) return RISK_LEVELS.includes(moduleDescriptor.risk) ? moduleDescriptor.risk : "critical";
  const generated = dbStore.getGeneratedCapabilityByName(name);
  if (generated) return RISK_LEVELS.includes(generated.risk) ? generated.risk : "critical";
  const canonical = stripSidekickPrefix(name);
  // Own-property lookup only: a prototype-chain name like "__proto__" or
  // "constructor" must fall through to the critical default, never to a
  // truthy inherited value that would make strict/restricted modes fail open.
  const risk = Object.prototype.hasOwnProperty.call(TOOL_RISK, canonical) ? TOOL_RISK[canonical] : null;
  return RISK_LEVELS.includes(risk) ? risk : "critical";
}

// Canonical names of every built-in tool, including those whose handlers have
// moved to descriptor-owned families under src/tools/families/. Built lazily
// because TOOL_DEFS is declared later in this module, and memoized because
// TOOL_DEFS is immutable for the process lifetime. If built-in tools ever
// become dynamically registerable, this memo must be invalidated.
let builtinToolNames = null;
function isBuiltinToolName(name) {
  if (!builtinToolNames) builtinToolNames = new Set(TOOL_DEFS.map(def => stripSidekickPrefix(def.name)));
  // Set membership, so inherited names like "constructor" cannot pass the check.
  return builtinToolNames.has(stripSidekickPrefix(name));
}

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

function getApprovalDecision(toolName, source = getCurrentSource()) {
  const risk = getToolRisk(toolName);
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

function getToolPolicyDecision(toolName, source = getCurrentSource()) {
  const risk = getToolRisk(toolName);
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

function enforceToolPolicy(toolName, source = getCurrentSource()) {
  const decision = getToolPolicyDecision(toolName, source);
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
  function sanitize(value, key = "") {
    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/(password|passwd|passphrase|secret|token|apikey|authorization|cookie|privatekey|credential)/.test(normalizedKey)) {
      return "[REDACTED]";
    }
    if (Array.isArray(value)) return value.map(item => sanitize(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, childKey)
      ]));
    }
    return typeof value === "string" ? redactSensitive(value) : value;
  }

  return JSON.stringify(sanitize(args || {}), null, 2).substring(0, 4000);
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
    args_preview: approvalPreviewArgs(storedArgs),
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
  copy.args_preview = copy.args_preview || approvalPreviewArgs(item.args);
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
  updated.result_preview = redactSensitive(result?.content?.[0]?.text || "").substring(0, 1000);
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
    args: args || {},
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

function getToolRecordsForSource(source = getCurrentSource()) {
  const defs = getToolDefsForSource(source);
  return defs.map(def => ({
    name: def.name,
    description: def.description,
    args: def.args || {},
    category: def.category || TOOL_CATEGORIES[def.name] || "Uncategorized",
    risk: def.risk || getToolRisk(def.name),
    enabled: def.enabled !== false,
    approval_required: def.approval_required === true
  }));
}

function groupToolRecords(records) {
  const grouped = {};
  for (const tool of records) {
    const category = tool.category || "Uncategorized";
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(tool);
  }
  return Object.keys(grouped).sort().map(category => ({
    category,
    tools: grouped[category].sort((a, b) => a.name.localeCompare(b.name))
  }));
}

function formatToolOverview(records) {
  const grouped = groupToolRecords(records);
  const lines = [`Sidekick tools (${records.length} total)`];
  for (const group of grouped) {
    lines.push("", `${group.category} (${group.tools.length})`);
    for (const tool of group.tools) {
      const state = tool.enabled ? "" : " disabled";
      const approval = tool.approval_required ? ", approval required" : "";
      lines.push(`- ${tool.name} [${tool.risk}${approval}${state}]: ${tool.description}`);
    }
  }
  return lines.join("\n");
}

function normalizePolicySources(source) {
  if (!source) return ["mcp", "dashboard", "agent"];
  return String(source).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function inspectToolPolicy(toolInput, source) {
  const toolName = typeof toolInput === "string" ? toolInput : toolInput.name;
  const policy = getToolPolicyDecision(toolName, source);
  const approval = getApprovalDecision(toolName, source);
  return {
    source,
    tool: toolName,
    category: typeof toolInput === "string" ? null : toolInput.category || null,
    description: typeof toolInput === "string" ? null : toolInput.description || null,
    risk: policy.risk,
    allowed: policy.allowed,
    callable: policy.allowed,
    policy: {
      mode: policy.mode,
      allowed: policy.allowed,
      reason: policy.reason,
      matched: policy.matched || null,
      list: policy.list || null
    },
    approval_required: approval.required,
    approval: {
      mode: approval.mode,
      required: approval.required,
      reason: approval.reason,
      matched: approval.matched || null,
      list: approval.list || null
    }
  };
}

function buildPolicyInspection(records, sources) {
  const inspections = [];
  for (const source of sources) {
    for (const tool of records) {
      inspections.push(inspectToolPolicy(tool, source));
    }
  }
  return inspections;
}

function summarizePolicyInspection(inspections) {
  const summary = {
    total: inspections.length,
    sources: {},
    by_risk: {},
    blocked: 0,
    approval_required: 0
  };
  for (const item of inspections) {
    if (!summary.sources[item.source]) {
      summary.sources[item.source] = { total: 0, allowed: 0, blocked: 0, approval_required: 0, high_risk: 0 };
    }
    const sourceSummary = summary.sources[item.source];
    sourceSummary.total += 1;
    if (item.allowed) sourceSummary.allowed += 1;
    else {
      sourceSummary.blocked += 1;
      summary.blocked += 1;
    }
    if (item.approval_required) {
      sourceSummary.approval_required += 1;
      summary.approval_required += 1;
    }
    if (RISK_ORDER[item.risk] >= RISK_ORDER.high) sourceSummary.high_risk += 1;
    summary.by_risk[item.risk] = (summary.by_risk[item.risk] || 0) + 1;
  }
  return summary;
}

function formatPolicyInspection(inspections, summary = summarizePolicyInspection(inspections)) {
  const lines = [`Sidekick tool policy inspection (${inspections.length} decisions)`];
  for (const [source, counts] of Object.entries(summary.sources)) {
    lines.push(`Source ${source}: ${counts.allowed} allowed, ${counts.blocked} blocked, ${counts.approval_required} approval required, ${counts.high_risk} high/critical risk`);
  }
  for (const item of inspections) {
    const policyMatch = item.policy.matched ? `, matched ${item.policy.matched}` : "";
    const approvalMatch = item.approval.matched ? `, matched ${item.approval.matched}` : "";
    const category = item.category ? `${item.category}/` : "";
    lines.push(
      `- ${item.source}/${category}${item.tool} [${item.risk}]: ` +
      `policy ${item.allowed ? "allowed" : "blocked"} (${item.policy.mode}; ${item.policy.reason}${policyMatch}); ` +
      `approval ${item.approval_required ? "required" : "not required"} (${item.approval.mode}; ${item.approval.reason}${approvalMatch})`
    );
  }
  return lines.join("\n");
}

async function sidekick_tools({ action, query, name, category, format, include_disabled, limit, source }) {
  const selectedAction = action || "overview";
  const selectedFormat = format || "text";
  const maxResults = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 100;
  let records = getToolRecordsForSource(getCurrentSource());

  if (selectedAction !== "policy" && !include_disabled) {
    records = records.filter(tool => tool.enabled);
  }

  if (category) {
    const wantedCategory = String(category).toLowerCase();
    records = records.filter(tool => String(tool.category || "").toLowerCase() === wantedCategory);
  }

  if (selectedAction === "policy") {
    if (name) {
      records = records.filter(t => t.name === name);
      if (records.length === 0) {
        return { content: [{ type: "text", text: "Tool not found: " + name }], isError: true };
      }
    } else if (include_disabled === false) {
      records = records.filter(tool => tool.enabled);
    }
    records = records.slice(0, maxResults);
    const sources = normalizePolicySources(source);
    const inspections = buildPolicyInspection(records, sources);
    const summary = summarizePolicyInspection(inspections);
    const payload = { total: inspections.length, sources, summary, decisions: inspections };
    const text = selectedFormat === "json" ? JSON.stringify(payload, null, 2) : formatPolicyInspection(inspections, summary);
    return { content: [{ type: "text", text }] };
  }

  if (selectedAction === "get") {
    if (!name) {
      return { content: [{ type: "text", text: "name is required for action=get" }], isError: true };
    }
    const tool = records.find(t => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: "Tool not found: " + name }], isError: true };
    }
    const text = selectedFormat === "json" ? JSON.stringify(tool, null, 2) : formatToolOverview([tool]);
    return { content: [{ type: "text", text }] };
  }

  if (selectedAction === "search") {
    if (!query) {
      return { content: [{ type: "text", text: "query is required for action=search" }], isError: true };
    }
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    records = records.filter(tool => {
      const haystack = [
        tool.name,
        tool.description,
        tool.category,
        tool.risk,
        Object.keys(tool.args || {}).join(" ")
      ].join(" ").toLowerCase();
      return terms.every(term => haystack.includes(term));
    }).slice(0, maxResults);
  } else if (selectedAction !== "overview") {
    return { content: [{ type: "text", text: "Invalid action. Allowed: overview, search, get, policy" }], isError: true };
  }

  const payload = selectedAction === "overview"
    ? { total: records.length, categories: groupToolRecords(records) }
    : { total: records.length, tools: records };
  const text = selectedFormat === "json" ? JSON.stringify(payload, null, 2) : formatToolOverview(records);
  return { content: [{ type: "text", text }] };
}

function formatArgs(args) {
  if (typeof args !== "object" || args === null) return "";
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    const str = String(value);
    const truncated = str.length > 100 ? str.substring(0, 100) + "..." : str;
    parts.push(key + "=" + redactSensitive(truncated));
  }
  return parts.join(", ");
}

function logToolCall(name, args, duration, success, summary, metadata = {}) {
  try {
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

function createScheduledPlatformExecution(kind, item, options = {}) {
  try {
    if (!options.allowConcurrent) {
      const guard = platformKernel.platformGuard(null, null, {
        operation_type: options.operationType || `${kind}_operation`,
        tool_name: options.toolName || item.tool || item.action_tool || null,
        project_id: options.projectId || null,
        dedupe_key: item.id || null,
        allowConcurrent: false,
      });
      if (!guard.allowed && guard.reason === "concurrent_execution" && guard.execution) {
        if (options.attach !== false) item.platform_execution_id = guard.execution.execution_id;
        return guard.execution;
      }
    }
    const execution = platformKernel.createExecution({
      parent_execution_id: options.parentExecutionId || null,
      root_execution_id: options.rootExecutionId || options.parentExecutionId || undefined,
      actor_id: options.actor || getCurrentSource() || "unknown",
      client_id: options.client || getCurrentSource() || null,
      trigger_type: options.triggerType || kind,
      operation_type: options.operationType || `${kind}_operation`,
      tool_name: options.toolName || item.tool || item.action_tool || null,
      tool_action: options.toolAction || null,
      risk: options.risk || "medium",
      deadline_at: options.deadlineAt || item.when || null,
      source: options.source || kind,
      correlation_id: options.correlationId || item.id,
      metadata: {
        kind,
        id: item.id,
        name: item.name || null,
        status: item.status || null,
        ...options.metadata,
      },
    });
    if (options.attach !== false) item.platform_execution_id = execution.execution_id;
    if (options.state && options.state !== "created") {
      platformKernel.transitionExecution(execution.execution_id, options.state, {
        source: options.source || kind,
        actor_id: options.actor || getCurrentSource() || "unknown",
        reason: options.reason || `${kind} ${options.state}`,
        correlation_id: options.correlationId || item.id,
      });
    }
    return execution;
  } catch (e) {
    return null;
  }
}

function transitionScheduledPlatformExecution(kind, item, state, details = {}) {
  try {
    if (!item.platform_execution_id) return;
    const guard = platformKernel.platformGuard(item.platform_execution_id, null, { allowTerminal: false });
    if (!guard.allowed) return;
    platformKernel.transitionExecution(item.platform_execution_id, state, {
      source: details.source || kind,
      actor_id: details.actor || getCurrentSource() || "unknown",
      reason: details.reason,
      result_status: details.result_status,
      error_category: details.error_category,
      result_summary: details.result_summary,
      correlation_id: details.correlationId || item.id,
    });
  } catch (e) {}
}

function releaseScheduledClaim(executionId, claim) {
  if (!executionId || !claim) return { ok: true };
  try {
    return platformKernel.releaseExecutionClaim({ execution_id: executionId, claimed_by: claim.claimed_by, claim_epoch: claim.claim_epoch });
  } catch (e) {
    return { ok: false, code: "release_error" };
  }
}

// Renew the claim lease on an interval while a scheduled dispatch is in
// flight, so a slow tool call cannot be orphaned out from under a live
// runner. A failed renewal means the claim was superseded; the timer stops
// and the completion write is fenced by releaseScheduledClaim.
function startScheduledLeaseRenewal(executionId, claim) {
  if (!executionId || !claim) return null;
  const timer = setInterval(() => {
    try {
      const renewed = platformKernel.renewExecutionLease({ execution_id: executionId, claimed_by: claim.claimed_by, claim_epoch: claim.claim_epoch });
      if (!renewed.ok) clearInterval(timer);
    } catch (e) {}
  }, 60000);
  if (timer.unref) timer.unref();
  return timer;
}

function appendScheduledPlatformEvent(kind, item, eventType, payload = {}, options = {}) {
  try {
    platformKernel.appendEvent({
      event_type: eventType,
      source: options.source || kind,
      actor_id: options.actor || getCurrentSource() || "unknown",
      subject_type: kind,
      subject_id: item.id,
      execution_id: options.executionId || item.platform_execution_id || null,
      root_execution_id: options.rootExecutionId || item.platform_execution_id || null,
      severity: options.severity || "info",
      payload: {
        kind,
        id: item.id,
        name: item.name || null,
        status: item.status || null,
        ...payload,
      },
      correlation_id: options.correlationId || item.id,
    });
  } catch (e) {}
}

const RESUME_DOCUMENT = "resume";

function loadResumeDocument() {
  const doc = dbStore.loadDocument(RESUME_DOCUMENT, { items: {} });
  if (!doc || typeof doc !== "object") return { items: {} };
  doc.items = doc.items && typeof doc.items === "object" ? doc.items : {};
  return doc;
}

function saveResumeDocument(doc) {
  dbStore.setDocument(RESUME_DOCUMENT, {
    version: 1,
    updated_at: new Date().toISOString(),
    items: doc.items || {}
  });
}

function activeResumeItems(doc, includeCleared = false) {
  const items = Object.values(doc.items || {});
  if (includeCleared) return items;
  return items.filter(item => !["cleared", "done", "complete"].includes(item.status));
}

function formatResumeItem(item) {
  return [
    `Project: ${item.project}`,
    `Status: ${item.status}`,
    item.plan_name ? `Plan: ${item.plan_name}` : null,
    item.current_phase ? `Current phase: ${item.current_phase}` : null,
    `Summary: ${item.summary || "(none)"}`,
    `Next step: ${item.next_step || "(none)"}`,
    item.branch ? `Branch: ${item.branch}` : null,
    item.url ? `URL: ${item.url}` : null,
    item.notes ? `Notes: ${item.notes}` : null,
    `Updated: ${item.updated_at}`
  ].filter(Boolean).join("\n");
}

async function sidekick_resume({ action, project, summary, next_step, status, branch, url, notes, plan_name, current_phase, include_cleared, format }) {
  const selectedAction = action || "check";
  const selectedFormat = format || "text";
  const doc = loadResumeDocument();

  if (selectedAction === "list") {
    const items = activeResumeItems(doc, include_cleared === true)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const payload = { count: items.length, items };
    const text = selectedFormat === "json"
      ? JSON.stringify(payload, null, 2)
      : (items.length ? items.map(formatResumeItem).join("\n\n---\n\n") : "No pending resume items");
    return { content: [{ type: "text", text }] };
  }

  if (!project || !PROJECT_RE.test(project)) {
    return { content: [{ type: "text", text: "project required and must match /^[a-z][a-z0-9_]*$/" }], isError: true };
  }

  if (selectedAction === "check") {
    const item = doc.items[project];
    if (!item || ["cleared", "done", "complete"].includes(item.status)) {
      return { content: [{ type: "text", text: `No pending resume item for project: ${project}` }] };
    }
    const text = selectedFormat === "json" ? JSON.stringify(item, null, 2) : formatResumeItem(item);
    return { content: [{ type: "text", text }] };
  }

  if (selectedAction === "set") {
    if (!summary && !next_step) {
      return { content: [{ type: "text", text: "summary or next_step required for action=set" }], isError: true };
    }
    const now = new Date().toISOString();
    const existing = doc.items[project] || {};
    const item = {
      id: existing.id || generateId("resume"),
      project,
      status: status || "active",
      summary: summary !== undefined ? redactSensitive(summary) : existing.summary || null,
      next_step: next_step !== undefined ? redactSensitive(next_step) : existing.next_step || null,
      branch: branch !== undefined ? redactSensitive(branch) : existing.branch || null,
      url: url !== undefined ? redactSensitive(url) : existing.url || null,
      notes: notes !== undefined ? redactSensitive(notes) : existing.notes || null,
      plan_name: plan_name !== undefined ? redactSensitive(plan_name) : existing.plan_name || null,
      current_phase: current_phase !== undefined ? current_phase : existing.current_phase || null,
      created_at: existing.created_at || now,
      updated_at: now
    };
    doc.items[project] = item;
    saveResumeDocument(doc);
    const text = selectedFormat === "json" ? JSON.stringify(item, null, 2) : `Resume set for project: ${project} (${item.id})`;
    return { content: [{ type: "text", text }] };
  }

  if (selectedAction === "clear") {
    const item = doc.items[project];
    if (!item) {
      return { content: [{ type: "text", text: `No resume item found for project: ${project}` }], isError: true };
    }
    const now = new Date().toISOString();
    item.status = "cleared";
    item.cleared_at = now;
    item.updated_at = now;
    if (notes !== undefined) item.notes = redactSensitive(notes);
    saveResumeDocument(doc);
    const text = selectedFormat === "json" ? JSON.stringify(item, null, 2) : `Resume cleared for project: ${project}`;
    return { content: [{ type: "text", text }] };
  }

  return { content: [{ type: "text", text: "Invalid action. Use: check, set, clear, list" }], isError: true };
}

// --- Cron Tool ---

function loadCronJobs() {
  return dbStore.loadDocument("cron", []);
}

function saveCronJobs(jobs) {
  dbStore.setDocument("cron", jobs);
}

async function sidekick_cron({ action, name, schedule, command, id }) {
  const allowedActions = ["add", "list", "remove", "run"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const jobs = loadCronJobs();

  if (action === "add") {
    if (!name || !schedule || !command) {
      return { content: [{ type: "text", text: "name, schedule, and command required" }], isError: true };
    }
    const newJob = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      schedule,
      command,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastResult: null
    };
    createScheduledPlatformExecution("cron", newJob, {
      operationType: "cron_job",
      state: "queued",
      risk: "high",
      metadata: { schedule: newJob.schedule },
      reason: "cron job scheduled",
    });
    jobs.push(newJob);
    saveCronJobs(jobs);
    syncCrontab(jobs);
    appendScheduledPlatformEvent("cron", newJob, "schedule.cron.added", { schedule: newJob.schedule });
    return { content: [{ type: "text", text: "Added cron job: " + name + " (id: " + newJob.id + ")" }] };
  }

  if (action === "list") {
    if (jobs.length === 0) {
      return { content: [{ type: "text", text: "No cron jobs scheduled" }] };
    }
    const summary = jobs.map(j =>
      j.id + " | " + j.name + " | " + j.schedule + " | " + (j.enabled ? "enabled" : "disabled") + " | last: " + (j.lastRun || "never")
    ).join("\n");
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "remove") {
    if (!id && !name) {
      return { content: [{ type: "text", text: "id or name required" }], isError: true };
    }
    const idx = jobs.findIndex(j => j.id === id || j.name === name);
    if (idx === -1) {
      return { content: [{ type: "text", text: "Job not found" }], isError: true };
    }
    const removed = jobs.splice(idx, 1)[0];
    transitionScheduledPlatformExecution("cron", removed, "cancelled", {
      reason: "cron job removed",
      result_status: "removed",
      result_summary: `Removed cron job ${removed.name}`,
    });
    appendScheduledPlatformEvent("cron", removed, "schedule.cron.removed", {});
    saveCronJobs(jobs);
    syncCrontab(jobs);
    return { content: [{ type: "text", text: "Removed job: " + removed.name }] };
  }

  if (action === "run") {
    if (!id && !name) {
      return { content: [{ type: "text", text: "id or name required" }], isError: true };
    }
    const job = jobs.find(j => j.id === id || j.name === name);
    if (!job) {
      return { content: [{ type: "text", text: "Job not found" }], isError: true };
    }
    // Fenced claim (Phase 4/B): sidekick-initiated runs of the same job are
    // serialized on the job's definition execution; crontab-fired commands
    // bypass sidekick entirely and cannot carry the contract. A cancel
    // request disables the job, which also removes its crontab entry.
    let cronClaim = null;
    if (job.platform_execution_id) {
      const cronClaimRes = claimScheduledDefinition(job, `cron-run:${process.pid}`, "cron");
      if (!cronClaimRes.ok) {
        const detail = cronClaimRes.code === "claim_held" ? `already running (${cronClaimRes.claimed_by})` : `cannot run: execution ${cronClaimRes.code}`;
        return { content: [{ type: "text", text: `Cron job ${job.id} ${detail}` }], isError: true };
      }
      cronClaim = cronClaimRes.claim;
      if (cronClaim.cancel_requested) {
        job.enabled = false;
        transitionScheduledPlatformExecution("cron", job, "blocked", { reason: "cron job disabled by cancel request", result_status: "disabled" });
        appendScheduledPlatformEvent("cron", job, "schedule.cron.disabled", { cancel_requested: true });
        saveCronJobs(jobs);
        syncCrontab(jobs);
        releaseScheduledClaim(job.platform_execution_id, cronClaim);
        return { content: [{ type: "text", text: `Cron job ${job.id} disabled: cancel requested on its execution` }] };
      }
    }
    const cronRenewTimer = startScheduledLeaseRenewal(job.platform_execution_id, cronClaim);
    const execution = createScheduledPlatformExecution("cron", job, {
      attach: false,
      operationType: "cron_run",
      state: "running",
      risk: "high",
      reason: "cron job run started",
      metadata: { cron_job_id: job.id, schedule: job.schedule },
    });
    try {
      const stdout = execSync(job.command, { timeout: 300000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      job.lastRun = new Date().toISOString();
      job.lastResult = "success";
      saveCronJobs(jobs);
      if (execution) platformKernel.transitionExecution(execution.execution_id, "completed", {
        source: "cron",
        actor_id: getCurrentSource() || "unknown",
        reason: "cron job run completed",
        result_status: "success",
        result_summary: stdout || "(empty output)",
        correlation_id: job.id,
      });
      if (cronRenewTimer) clearInterval(cronRenewTimer);
      releaseScheduledClaim(job.platform_execution_id, cronClaim);
      return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
    } catch (e) {
      job.lastRun = new Date().toISOString();
      job.lastResult = "error";
      saveCronJobs(jobs);
      if (execution) platformKernel.transitionExecution(execution.execution_id, "failed", {
        source: "cron",
        actor_id: getCurrentSource() || "unknown",
        reason: "cron job run failed",
        result_status: "failure",
        error_category: evolveCommon.errorCategory(e.message),
        result_summary: e.stderr || e.stdout || e.message,
        correlation_id: job.id,
      });
      if (cronRenewTimer) clearInterval(cronRenewTimer);
      releaseScheduledClaim(job.platform_execution_id, cronClaim);
      return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
    }
  }
}

function syncCrontab(jobs) {
  try {
    const enabledJobs = jobs.filter(j => j.enabled);
    if (enabledJobs.length === 0) {
      try { execFileSync("crontab", ["-r"], { encoding: "utf-8" }); } catch {}
      return;
    }
    const lines = enabledJobs.map(j => {
      const script = `cd /home/sidekick/sidekick && ${j.command} >> ${DATA_DIR}/cron-${j.id}.log 2>&1`;
      return `${j.schedule} ${script} # sidekick:${j.id}`;
    });
    const crontabContent = lines.join("\n") + "\n";
    execFileSync("crontab", ["-"], { input: crontabContent, encoding: "utf-8" });
  } catch (e) {
    // Silently fail if crontab not available
  }
}

// --- GitHub Tool ---

function parseGithubArgs(extraArgs) {
  if (extraArgs === undefined || extraArgs === null || extraArgs === "") return {};
  if (typeof extraArgs === "object") return extraArgs;
  if (typeof extraArgs !== "string") return { value: extraArgs };
  const trimmed = extraArgs.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  } catch (e) {
    return { value: extraArgs };
  }
}

function getGithubArg(args, names) {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null && args[name] !== "") return args[name];
  }
  return args.value;
}

function resolveGithubToken() {
  let token = process.env.GITHUB_TOKEN;
  if (token) return token;

  try {
    const secrets = loadSecrets();
    const secret = secrets["github_token"];
    if (secret) token = decryptSecret(secret);
  } catch (e) {
    // Secret store not available
  }
  return token;
}

function redactGithubError(value, token) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (token) text = text.split(token).join("[REDACTED]");
  return redactSensitive(text);
}

function githubRequest(token, method, endpoint, body) {
  const apiBase = "https://api.github.com";
  return new Promise((resolve) => {
    const url = new URL(apiBase + endpoint);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Sidekick-MCP/1.0"
      }
    };
    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        let parsed = data;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (e) {
          parsed = data;
        }
        resolve({ status: res.statusCode, headers: res.headers || {}, data: parsed });
      });
    });
    req.on("error", (err) => resolve({ status: 0, headers: {}, data: err.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, headers: {}, data: "timeout" }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function parseGithubLinkHeader(linkHeader) {
  const links = {};
  if (!linkHeader) return links;
  for (const part of String(linkHeader).split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function endpointFromGithubUrl(url) {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

async function githubPaginatedRequest(token, endpoint, dataKey) {
  let next = endpoint;
  const items = [];
  let lastResponse = null;

  while (next) {
    const res = await githubRequest(token, "GET", next);
    lastResponse = res;
    if (res.status < 200 || res.status >= 300) return { response: res, items };

    const pageItems = dataKey ? res.data?.[dataKey] : res.data;
    if (Array.isArray(pageItems)) items.push(...pageItems);

    const links = parseGithubLinkHeader(res.headers.link);
    next = links.next ? endpointFromGithubUrl(links.next) : null;
  }

  return { response: lastResponse, items };
}

function validateRepoName(repo) {
  return typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function getCiRevisionSelector(args) {
  const selectors = [
    { type: "pr", aliases: ["pr", "pull_number"] },
    { type: "sha", aliases: ["sha", "commit"] },
    { type: "ref", aliases: ["ref", "branch"] }
  ];
  const found = [];
  for (const selector of selectors) {
    for (const alias of selector.aliases) {
      if (args[alias] !== undefined && args[alias] !== null && args[alias] !== "") {
        found.push({ type: selector.type, alias, value: args[alias] });
        break;
      }
    }
  }
  if (found.length === 0) return { error: "Exactly one revision selector is required: pr/pull_number, sha/commit, or ref/branch" };
  if (found.length > 1) return { error: "Conflicting revision selectors: provide exactly one of pr/pull_number, sha/commit, or ref/branch" };
  return found[0];
}

function ciItemState(kind, item) {
  if (kind === "check") {
    if (item.status !== "completed") return "pending";
    if (["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(item.conclusion)) return "failure";
    if (["success", "neutral", "skipped"].includes(item.conclusion)) return item.conclusion === "skipped" ? "skipped" : "success";
    return "pending";
  }

  if (["failure", "error"].includes(item.state)) return "failure";
  if (item.state === "pending") return "pending";
  if (item.state === "success") return "success";
  return "pending";
}

function buildCiStatusResult(repo, requested, sha, checkRuns, statuses) {
  const summary = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 };
  let sawSuccess = false;
  let sawPending = false;
  let sawFailure = false;

  const normalizedCheckRuns = checkRuns.map(run => {
    const state = ciItemState("check", run);
    summary.total++;
    if (state === "failure") { summary.failed++; sawFailure = true; }
    else if (state === "pending") { summary.pending++; sawPending = true; }
    else if (state === "skipped") { summary.skipped++; }
    else { summary.passed++; sawSuccess = true; }
    return {
      name: run.name || "(unnamed check)",
      head_sha: run.head_sha || null,
      status: run.status || null,
      conclusion: run.conclusion || null,
      details_url: run.details_url || run.html_url || null,
      html_url: run.html_url || null,
      state
    };
  });

  const normalizedStatuses = statuses.map(status => {
    const state = ciItemState("status", status);
    summary.total++;
    if (state === "failure") { summary.failed++; sawFailure = true; }
    else if (state === "pending") { summary.pending++; sawPending = true; }
    else { summary.passed++; sawSuccess = true; }
    return {
      context: status.context || "(no context)",
      state: status.state || null,
      description: status.description || null,
      target_url: status.target_url || null
    };
  });

  let overall = "no_checks";
  if (sawFailure) overall = "failure";
  else if (sawPending) overall = "pending";
  else if (sawSuccess || summary.skipped > 0) overall = "success";

  return {
    repo,
    requested,
    sha,
    overall,
    summary,
    check_runs: normalizedCheckRuns,
    statuses: normalizedStatuses
  };
}

function formatCiStatusText(result) {
  const lines = [
    `CI Status: ${result.overall}`,
    `Repository: ${result.repo}`,
    `${result.requested.type === "pr" ? "PR" : result.requested.type === "sha" ? "Commit" : "Ref"}: ${result.requested.value}`,
    `Resolved SHA: ${result.sha}`,
    "",
    "Check runs:"
  ];

  if (result.check_runs.length === 0) lines.push("- none");
  for (const run of result.check_runs) {
    lines.push(`- ${run.name}: ${run.status || "unknown"} / ${run.conclusion || "none"}`);
    if (run.details_url) lines.push(`  ${run.details_url}`);
  }

  lines.push("", "Legacy statuses:");
  if (result.statuses.length === 0) lines.push("- none");
  for (const status of result.statuses) {
    lines.push(`- ${status.context}: ${status.state || "unknown"}`);
    if (status.target_url) lines.push(`  ${status.target_url}`);
  }

  lines.push("", `Summary: ${result.summary.total} total, ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.pending} pending, ${result.summary.skipped} skipped`);
  return lines.join("\n");
}

async function sidekick_ci_status(args = {}) {
  const format = args.format || "text";
  if (!args.repo) return { content: [{ type: "text", text: "repo is required in owner/repository format" }], isError: true };
  if (!validateRepoName(args.repo)) return { content: [{ type: "text", text: "Invalid repository. Expected owner/repository format" }], isError: true };
  if (!["text", "json"].includes(format)) return { content: [{ type: "text", text: "format must be text or json" }], isError: true };

  const selector = getCiRevisionSelector(args);
  if (selector.error) return { content: [{ type: "text", text: selector.error }], isError: true };

  const token = resolveGithubToken();
  if (!token) return { content: [{ type: "text", text: "github_token not found in secret store" }], isError: true };

  try {
    let ref = String(selector.value);
    let requested = { type: selector.type, value: selector.type === "pr" ? Number(selector.value) : String(selector.value) };
    if (selector.type === "pr") {
      const prRes = await githubRequest(token, "GET", `/repos/${args.repo}/pulls/${encodeURIComponent(selector.value)}`);
      if (prRes.status !== 200) {
        return { content: [{ type: "text", text: redactGithubError(prRes.data, token) }], isError: true };
      }
      ref = prRes.data?.head?.sha;
      if (!ref) return { content: [{ type: "text", text: "GitHub PR response did not include head.sha" }], isError: true };
    }

    const encodedRef = encodeURIComponent(ref);
    const checks = await githubPaginatedRequest(token, `/repos/${args.repo}/commits/${encodedRef}/check-runs?per_page=100`, "check_runs");
    if (checks.response?.status < 200 || checks.response?.status >= 300) {
      return { content: [{ type: "text", text: redactGithubError(checks.response.data, token) }], isError: true };
    }

    const legacy = await githubPaginatedRequest(token, `/repos/${args.repo}/commits/${encodedRef}/status?per_page=100`, "statuses");
    if (legacy.response?.status < 200 || legacy.response?.status >= 300) {
      return { content: [{ type: "text", text: redactGithubError(legacy.response.data, token) }], isError: true };
    }

    const resolvedSha = checks.items.find(run => run.head_sha)?.head_sha || legacy.response?.data?.sha || ref;
    const result = buildCiStatusResult(args.repo, requested, resolvedSha, checks.items, legacy.items);
    const text = format === "json" ? JSON.stringify(result, null, 2) : formatCiStatusText(result);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactGithubError(e.message, token) }], isError: true };
  }
}

async function sidekick_github({ action, repo, args: extraArgs }) {
  const parsedArgs = parseGithubArgs(extraArgs);
  let token = process.env.GITHUB_TOKEN;

  if (!token) {
    try {
      const secrets = loadSecrets();
      const secret = secrets["github_token"];
      if (secret) {
        token = decryptSecret(secret);
      }
    } catch (e) {
      // Secret store not available
    }
  }

  if (!token) {
    return { content: [{ type: "text", text: "github_token not found in secret store" }], isError: true };
  }

  const https = require("https");
  const apiBase = "https://api.github.com";

  function ghRequest(method, endpoint, body) {
    return new Promise((resolve) => {
      const url = new URL(apiBase + endpoint);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          "Authorization": "token " + token,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Sidekick-MCP/1.0"
        }
      };
      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Type"] = "application/json";
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, data: data });
          }
        });
      });
      req.on("error", (err) => resolve({ status: 0, data: err.message }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: "timeout" }); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  const actions = {
    pr_list: async () => {
      const state = parsedArgs.state || "open";
      const res = await ghRequest("GET", `/repos/${repo}/pulls?state=${encodeURIComponent(state)}`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const prs = res.data.map(pr => `#${pr.number} ${pr.title} (${pr.user.login}) - ${pr.html_url}`);
      return { content: [{ type: "text", text: prs.join("\n") || "No open PRs" }] };
    },
    pr_create: async () => {
      const { title, head, base, body } = parsedArgs;
      if (!title || !head) return { content: [{ type: "text", text: "title and head required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/pulls`, { title, head, base: base || "main", body: body || "" });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created PR #${res.data.number}: ${res.data.html_url}` }] };
    },
    pr_get: async () => {
      const num = getGithubArg(parsedArgs, ["number", "pr", "pull", "pull_number"]);
      if (!num) return { content: [{ type: "text", text: "PR number required" }], isError: true };
      const res = await ghRequest("GET", `/repos/${repo}/pulls/${num}`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const pr = res.data;
      return { content: [{ type: "text", text: `#${pr.number} ${pr.title}\nState: ${pr.state}\nAuthor: ${pr.user.login}\nURL: ${pr.html_url}\n${pr.body || ""}` }] };
    },
    pr_merge: async () => {
      const num = getGithubArg(parsedArgs, ["number", "pr", "pull", "pull_number"]);
      if (!num) return { content: [{ type: "text", text: "PR number required" }], isError: true };
      const method = parsedArgs.method || parsedArgs.merge_method || "squash";
      const res = await ghRequest("PUT", `/repos/${repo}/pulls/${num}/merge`, { merge_method: method });
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Merged PR #${num}` }] };
    },
    issue_list: async () => {
      const res = await ghRequest("GET", `/repos/${repo}/issues?state=open`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const issues = res.data.filter(i => !i.pull_request).map(i => `#${i.number} ${i.title} (${i.user.login}) - ${i.html_url}`);
      return { content: [{ type: "text", text: issues.join("\n") || "No open issues" }] };
    },
    issue_create: async () => {
      const { title, body } = parsedArgs;
      if (!title) return { content: [{ type: "text", text: "title required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/issues`, { title, body: body || "" });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created issue #${res.data.number}: ${res.data.html_url}` }] };
    },
    issue_close: async () => {
      const num = getGithubArg(parsedArgs, ["number", "issue", "issue_number"]);
      if (!num) return { content: [{ type: "text", text: "issue number required" }], isError: true };
      const res = await ghRequest("PATCH", `/repos/${repo}/issues/${num}`, { state: "closed" });
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Closed issue #${num}` }] };
    },
    commit_status: async () => {
      const sha = getGithubArg(parsedArgs, ["sha", "ref", "commit", "commit_sha"]);
      if (!sha) return { content: [{ type: "text", text: "commit SHA required" }], isError: true };
      const res = await ghRequest("GET", `/repos/${repo}/commits/${sha}/status`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const statuses = res.data.statuses.map(s => `${s.context}: ${s.state} - ${s.description || ""}`);
      return { content: [{ type: "text", text: `Overall: ${res.data.state}\n${statuses.join("\n") || "No statuses"}` }] };
    },
    release_create: async () => {
      const { tag_name, name, body, draft, prerelease } = parsedArgs;
      if (!tag_name) return { content: [{ type: "text", text: "tag_name required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/releases`, { tag_name, name: name || tag_name, body: body || "", draft: draft || false, prerelease: prerelease || false });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created release ${res.data.name}: ${res.data.html_url}` }] };
    },
    repo_info: async () => {
      const res = await ghRequest("GET", `/repos/${repo}`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const r = res.data;
      return { content: [{ type: "text", text: `${r.full_name}\nStars: ${r.stargazers_count} | Forks: ${r.forks_count} | Issues: ${r.open_issues_count}\nDefault branch: ${r.default_branch}\n${r.description || ""}` }] };
    }
  };

  if (!actions[action]) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + Object.keys(actions).join(", ") }], isError: true };
  }

  return actions[action]();
}

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// --- Teach Tool ---

function loadProcedures() {
  if (!fs.existsSync(PROCEDURES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROCEDURES_FILE, "utf-8"));
  } catch (e) {
    return {};
  }
}

function saveProcedures(procedures) {
  fs.writeFileSync(PROCEDURES_FILE, JSON.stringify(procedures, null, 2));
}

function substituteParams(obj, params) {
  if (typeof obj === "string") {
    if (!params) return obj;
    return obj.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return params[key] !== undefined ? String(params[key]) : match;
    });
  }
  if (!params || typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => substituteParams(item, params));
  }
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = substituteParams(v, params);
  }
  return result;
}

async function sidekick_teach({ action, name, description, steps, example, trigger_phrases, implementation, parameters, args }) {
  const allowedActions = ["teach_procedure", "generate_tool", "learn_from_example", "execute", "list", "remove"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const procedures = loadProcedures();
  const now = new Date().toISOString();

  if (action === "teach_procedure") {
    if (!name || !description || !steps) {
      return { content: [{ type: "text", text: "name, description, and steps required" }], isError: true };
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return { content: [{ type: "text", text: "steps must be a non-empty array" }], isError: true };
    }
    for (const step of steps) {
      if (!step.tool || !step.args) {
        return { content: [{ type: "text", text: "Each step must have 'tool' and 'args' properties" }], isError: true };
      }
    }
    procedures[name] = {
      name,
      description,
      parameters: parameters || {},
      steps,
      triggerPhrases: trigger_phrases || [],
      createdAt: now,
      lastUsed: null,
      useCount: 0
    };
    saveProcedures(procedures);
    const paramCount = Object.keys(parameters || {}).length;
    return { content: [{ type: "text", text: `Taught procedure: ${name} (${steps.length} steps, ${paramCount} parameters)` }] };
  }

  if (action === "generate_tool") {
    if (!name || !description) {
      return { content: [{ type: "text", text: "name and description required" }], isError: true };
    }
    const toolSchemas = `
Tool parameter schemas:
- sidekick_bash: { "command": "shell command to run" }
- sidekick_read: { "path": "absolute file path" }
- sidekick_write: { "path": "absolute file path", "content": "file content" }
- sidekick_list: { "path": "/home/sidekick" } (optional path)
- sidekick_search: { "pattern": "regex", "path": "optional dir", "include": "optional file pattern" }
- sidekick_git: { "action": "status|diff|log|add|commit|push|pull|branch|checkout|stash", "args": "optional string" }
- sidekick_notify: { "channel": "discord|slack|email", "message": "text", "webhook_url": "for discord/slack", "recipient": "for email" }
- sidekick_process: { "action": "list|top|kill|tree", "filter": "optional name", "pid": "optional number", "name": "optional name" }
- sidekick_service: { "action": "start|stop|restart|status|enable|disable|logs", "service": "service name" }
- sidekick_archive: { "action": "create|extract|list", "path": "source path", "output": "output path for create", "format": "tar.gz|zip" }
- sidekick_store: { "key": "storage key", "value": "value to store", "project": "optional project name" }
- sidekick_get: { "key": "storage key" }
- sidekick_web_fetch: { "url": "URL to fetch", "method": "GET|POST", "body": "optional", "headers": "optional JSON" }
- sidekick_llm: { "prompt": "question", "system": "optional system prompt", "temperature": "optional 0-2" }
`;
    const prompt = `Generate a procedure definition for "${name}" based on this description: "${description}".

Return a JSON object with two properties:
1. "parameters": an object defining input parameters, where each key is a param name and value has "type" (string|number|boolean), "description", and optional "required" (boolean, default false)
2. "steps": a JSON array of steps, where each step has "tool" and "args" properties. Use {{paramName}} in arg values to reference parameters.

${toolSchemas}
Example format:
{
  "parameters": { "path": { "type": "string", "description": "Directory to check", "required": true } },
  "steps": [
    {"tool": "sidekick_bash", "args": {"command": "df -h {{path}}"}},
    {"tool": "sidekick_bash", "args": {"command": "du -sh {{path}}"}}
  ]
}

If the procedure takes no parameters, return an empty "parameters" object.
IMPORTANT: Use ONLY the parameters shown in the schemas above. Do not invent tool parameters.
Return ONLY the JSON object, no other text.`;

    const llmResult = await sidekick_llm({ prompt, system: "You are a helpful assistant that generates tool procedures with parameters. Return only valid JSON." });
    if (llmResult.isError) {
      return { content: [{ type: "text", text: "Failed to generate tool: " + llmResult.content[0].text }], isError: true };
    }

    let generated;
    try {
      const text = llmResult.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        generated = JSON.parse(jsonMatch[0]);
      } else {
        generated = JSON.parse(text);
      }
    } catch (e) {
      return { content: [{ type: "text", text: "Failed to parse generated definition: " + e.message }], isError: true };
    }

    const generatedSteps = generated.steps;
    const generatedParams = generated.parameters || {};

    if (!Array.isArray(generatedSteps) || generatedSteps.length === 0) {
      return { content: [{ type: "text", text: "Generated steps are invalid" }], isError: true };
    }

    procedures[name] = {
      name,
      description,
      parameters: generatedParams,
      steps: generatedSteps,
      triggerPhrases: [],
      createdAt: now,
      lastUsed: null,
      useCount: 0,
      generated: true
    };
    saveProcedures(procedures);
    const paramNames = Object.keys(generatedParams);
    return { content: [{ type: "text", text: `Generated tool: ${name} (${generatedSteps.length} steps, parameters: ${paramNames.length > 0 ? paramNames.join(", ") : "none"})\nSteps:\n${JSON.stringify(generatedSteps, null, 2)}` }] };
  }

  if (action === "learn_from_example") {
    if (!name || !example) {
      return { content: [{ type: "text", text: "name and example required" }], isError: true };
    }
    const toolSchemas = `
Tool parameter schemas:
- sidekick_bash: { "command": "shell command to run" }
- sidekick_read: { "path": "absolute file path" }
- sidekick_write: { "path": "absolute file path", "content": "file content" }
- sidekick_list: { "path": "/home/sidekick" } (optional path)
- sidekick_search: { "pattern": "regex", "path": "optional dir", "include": "optional file pattern" }
- sidekick_git: { "action": "status|diff|log|add|commit|push|pull|branch|checkout|stash", "args": "optional string" }
- sidekick_notify: { "channel": "discord|slack|email", "message": "text", "webhook_url": "for discord/slack", "recipient": "for email" }
- sidekick_process: { "action": "list|top|kill|tree", "filter": "optional name", "pid": "optional number", "name": "optional name" }
- sidekick_service: { "action": "start|stop|restart|status|enable|disable|logs", "service": "service name" }
- sidekick_archive: { "action": "create|extract|list", "path": "source path", "output": "output path for create", "format": "tar.gz|zip" }
- sidekick_store: { "key": "storage key", "value": "value to store", "project": "optional project name" }
- sidekick_get: { "key": "storage key" }
- sidekick_web_fetch: { "url": "URL to fetch", "method": "GET|POST", "body": "optional", "headers": "optional JSON" }
- sidekick_llm: { "prompt": "question", "system": "optional system prompt", "temperature": "optional 0-2" }
`;
    const prompt = `Parse this example and extract a procedure definition:
"${example}"

Return a JSON object with two properties:
1. "parameters": an object defining input parameters (use {{paramName}} references in steps). If nothing varies, use empty {}.
2. "steps": a JSON array of steps, where each step has "tool" and "args" properties.

${toolSchemas}
IMPORTANT: Use ONLY the parameters shown in the schemas above. Do not invent tool parameters.
Return ONLY the JSON object, no other text.`;

    const llmResult = await sidekick_llm({ prompt, system: "You are a helpful assistant that extracts procedures from examples. Return only valid JSON." });
    if (llmResult.isError) {
      return { content: [{ type: "text", text: "Failed to parse example: " + llmResult.content[0].text }], isError: true };
    }

    let parsed;
    try {
      const text = llmResult.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(text);
      }
    } catch (e) {
      return { content: [{ type: "text", text: "Failed to parse steps from example: " + e.message }], isError: true };
    }

    const parsedSteps = parsed.steps || parsed;
    const parsedParams = parsed.parameters || {};

    procedures[name] = {
      name,
      description: example,
      parameters: parsedParams,
      steps: Array.isArray(parsedSteps) ? parsedSteps : [],
      triggerPhrases: trigger_phrases || [],
      createdAt: now,
      lastUsed: null,
      useCount: 0,
      learned: true
    };
    saveProcedures(procedures);
    return { content: [{ type: "text", text: `Learned procedure: ${name} (${(Array.isArray(parsedSteps) ? parsedSteps.length : 0)} steps)` }] };
  }

  if (action === "execute") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    const procedure = procedures[name];
    if (!procedure) {
      return { content: [{ type: "text", text: `Procedure not found: ${name}` }], isError: true };
    }

    const params = args || {};
    const requiredParams = Object.entries(procedure.parameters || {})
      .filter(([, def]) => def.required)
      .map(([k]) => k);
    const missing = requiredParams.filter(k => params[k] === undefined);
    if (missing.length > 0) {
      return { content: [{ type: "text", text: `Missing required parameters: ${missing.join(", ")}` }], isError: true };
    }

    procedure.lastUsed = now;
    procedure.useCount++;
    saveProcedures(procedures);

    const results = [];
    for (let i = 0; i < procedure.steps.length; i++) {
      const step = procedure.steps[i];
      const resolvedArgs = substituteParams(step.args, params);
      try {
        const result = await callTool(step.tool, resolvedArgs);
        results.push({
          step: i + 1,
          tool: step.tool,
          success: !result.isError,
          output: result.content[0].text.substring(0, 200)
        });
        if (result.isError) {
          return { content: [{ type: "text", text: `Procedure '${name}' failed at step ${i + 1} (${step.tool}):\n${result.content[0].text}` }], isError: true };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Procedure '${name}' failed at step ${i + 1} (${step.tool}): ${e.message}` }], isError: true };
      }
    }

    const summary = results.map(r => `Step ${r.step} (${r.tool}): ${r.success ? "✓" : "✗"} ${r.output}`).join("\n");
    return { content: [{ type: "text", text: `Executed procedure '${name}' (${procedure.steps.length} steps)\n\n${summary}` }] };
  }

  if (action === "list") {
    const procNames = Object.keys(procedures);
    if (procNames.length === 0) {
      return { content: [{ type: "text", text: "No procedures taught yet" }] };
    }
    const summary = procNames.map(name => {
      const proc = procedures[name];
      const tags = [];
      if (proc.generated) tags.push("generated");
      if (proc.learned) tags.push("learned");
      const paramNames = Object.keys(proc.parameters || {});
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      const paramStr = paramNames.length > 0 ? ` params: {${paramNames.join(", ")}}` : "";
      return `${name}${tagStr} - ${proc.description} (${proc.steps.length} steps, used ${proc.useCount} times${paramStr})`;
    }).join("\n");
    return { content: [{ type: "text", text: `Taught procedures (${procNames.length}):\n\n${summary}` }] };
  }

  if (action === "remove") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    if (!procedures[name]) {
      return { content: [{ type: "text", text: `Procedure not found: ${name}` }], isError: true };
    }
    delete procedures[name];
    saveProcedures(procedures);
    return { content: [{ type: "text", text: `Removed procedure: ${name}` }] };
  }
}

// --- Health Tool ---

// --- Delay Tool ---

const DELAYS_FILE = path.join(DATA_DIR, "delays.json");

function loadDelays() {
  if (!fs.existsSync(DELAYS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DELAYS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveDelays(delays) {
  fs.writeFileSync(DELAYS_FILE, JSON.stringify(delays, null, 2));
}

// Phase 4/B restart recovery: a delay that was `running` when its runner died
// used to be stranded forever. The kernel recovery scan orphans executions
// whose claim lease expired; any such delay is re-queued to `pending` exactly
// once (fenced by the orphaned->queued transition, which a concurrent
// recoverer would lose). Called by the agent on startup.
function recoverStrandedDelays(details = {}) {
  try {
    platformKernel.recoverOrphanedExecutions({ source: details.source || "delay", actor_id: details.actor || null });
  } catch (e) {}
  const delays = loadDelays();
  let requeued = 0;
  for (const d of delays) {
    if (d.status !== "running" || !d.platform_execution_id) continue;
    try {
      const claim = platformKernel.getExecutionClaim(d.platform_execution_id);
      if (claim && claim.claimed_by) continue; // actively leased by a live runner
      const exec = platformKernel.getExecution(d.platform_execution_id);
      if (!exec || exec.state !== "orphaned") continue;
      platformKernel.transitionExecution(d.platform_execution_id, "queued", { source: details.source || "delay", actor_id: details.actor || null, reason: "delay re-queued after orphan recovery" });
      d.status = "pending";
      d.startedAt = null;
      requeued++;
    } catch (e) {}
  }
  if (requeued > 0) saveDelays(delays);
  return { requeued };
}

// Phase 4/B: scheduled work is serialized per item by claiming the item's
// long-lived definition execution for the duration of a dispatch (watch
// check, cron run) — two runners cannot both dispatch the same item. A crash
// mid-dispatch leaves an expired lease that the recovery scan flips to
// `orphaned`; the next dispatch re-queues it before claiming.
function claimScheduledDefinition(item, claimedBy, source) {
  if (!item.platform_execution_id) return { ok: true, claim: null };
  try {
    const exec = platformKernel.getExecution(item.platform_execution_id);
    if (exec && exec.state === "orphaned") {
      platformKernel.transitionExecution(item.platform_execution_id, "queued", { source, reason: `${source} definition re-queued after orphan recovery`, correlation_id: item.id });
    }
  } catch (e) {}
  return platformKernel.claimExecution({ execution_id: item.platform_execution_id, claimed_by: claimedBy });
}

// A cancel request on the definition execution permanently stops the watch:
// cancel_requested is not clearable, so every future claimant re-pauses it.
// Normal operational stop/resume stays with the watch pause/remove actions.
function pauseWatchForCancel(watch, claim, options = {}) {
  // Re-load before the lifecycle write: claims fence per watch, but
  // watches.json is global — an entry snapshot could clobber concurrent
  // changes to other watches.
  const watches = loadWatches();
  const fresh = watches.find(w => w.id === watch.id) || watch;
  fresh.status = "paused";
  transitionScheduledPlatformExecution("watch", fresh, "blocked", { source: options.source, actor: options.actor, reason: "watch paused by cancel request", result_status: "paused" });
  appendScheduledPlatformEvent("watch", fresh, "schedule.watch.paused", { cancel_requested: true }, { source: options.source, actor: options.actor });
  saveWatches(watches);
  releaseScheduledClaim(watch.platform_execution_id, claim);
}

function parseWhen(when) {
  if (!when) return null;

  const match = when.match(/^(\d+)(s|m|h|d)$/);
  if (match) {
    const amount = parseInt(match[1]);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(Date.now() + amount * multipliers[unit]);
  }

  const date = new Date(when);
  if (!isNaN(date.getTime())) {
    return date;
  }

  return null;
}

async function sidekick_delay({ action, id, when, name, tool, args }) {
  const delays = loadDelays();
  const now = new Date().toISOString();

  if (action === "add") {
    if (!when || !tool) {
      return { content: [{ type: "text", text: "when and tool required" }], isError: true };
    }

    const executeAt = parseWhen(when);
    if (!executeAt) {
      return { content: [{ type: "text", text: "Invalid when format. Use: 10s, 5m, 2h, 1d, or ISO date" }], isError: true };
    }

    if (executeAt.getTime() <= Date.now()) {
      return { content: [{ type: "text", text: "Time must be in the future" }], isError: true };
    }

    const delay = {
      id: generateId("delay"),
      name: name || `${tool} at ${executeAt.toISOString()}`,
      when: executeAt.toISOString(),
      tool,
      args: args || {},
      created: now,
      status: "pending"
    };
    createScheduledPlatformExecution("delay", delay, {
      operationType: "delay_task",
      state: "queued",
      risk: getToolRisk(tool),
      deadlineAt: delay.when,
      metadata: { target_tool: tool },
      reason: "delay scheduled",
    });

    delays.push(delay);
    saveDelays(delays);
    appendScheduledPlatformEvent("delay", delay, "schedule.delay.added", { when: delay.when, tool: delay.tool });

    const msUntil = executeAt.getTime() - Date.now();
    const minutes = Math.round(msUntil / 60000);

    try {
      const http = require("http");
      const req = http.request({
        hostname: "127.0.0.1",
        port: 4099,
        path: "/api/delays/reload",
        method: "POST"
      });
      req.on("error", () => {});
      req.end();
    } catch {}

    return { content: [{ type: "text", text: `Scheduled delay: ${delay.id}\nWill execute ${tool} in ${minutes} minutes (${executeAt.toISOString()})` }] };
  }

  if (action === "list") {
    const pending = delays.filter(d => d.status === "pending");
    const completed = delays.filter(d => d.status === "completed");
    const cancelled = delays.filter(d => d.status === "cancelled");

    let output = `# Scheduled Delays\n\n`;
    output += `**Pending: ${pending.length}**\n`;
    output += `**Completed: ${completed.length}**\n`;
    output += `**Cancelled: ${cancelled.length}**\n\n`;

    if (pending.length > 0) {
      output += `## Pending\n`;
      for (const d of pending) {
        const when = new Date(d.when);
        const msUntil = when.getTime() - Date.now();
        const minutes = Math.round(msUntil / 60000);
        output += `- **${d.id}**: ${d.name}\n`;
        output += `  - Tool: ${d.tool}\n`;
        output += `  - Executes in: ${minutes} minutes (${d.when})\n`;
      }
    }

    if (completed.length > 0) {
      output += `\n## Completed (last 5)\n`;
      for (const d of completed.slice(-5)) {
        output += `- ${d.id}: ${d.name} (completed ${d.completedAt})\n`;
      }
    }

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "cancel") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const delay = delays.find(d => d.id === id);
    if (!delay) {
      return { content: [{ type: "text", text: `Delay not found: ${id}` }], isError: true };
    }

    if (delay.status !== "pending") {
      return { content: [{ type: "text", text: `Delay ${id} is not pending (status: ${delay.status})` }], isError: true };
    }

    delay.status = "cancelled";
    delay.cancelledAt = now;
    transitionScheduledPlatformExecution("delay", delay, "cancelled", {
      reason: "delay cancelled",
      result_status: "cancelled",
      result_summary: `Cancelled delay ${id}`,
    });
    appendScheduledPlatformEvent("delay", delay, "schedule.delay.cancelled", { cancelled_at: delay.cancelledAt });
    saveDelays(delays);

    return { content: [{ type: "text", text: `Cancelled delay: ${id}` }] };
  }

  if (action === "run") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const delay = delays.find(d => d.id === id);
    if (!delay) {
      return { content: [{ type: "text", text: `Delay not found: ${id}` }], isError: true };
    }

    if (delay.status !== "pending") {
      return { content: [{ type: "text", text: `Delay ${id} is not pending (status: ${delay.status})` }], isError: true };
    }

    // Fenced claim (Phase 4/B): of the agent timer and any MCP-side run, only
    // one claimant dispatches. Any claim failure refuses dispatch — a terminal
    // or missing execution means the ledger disagrees with delays.json, and
    // running unfenced would bypass the contract entirely.
    let runClaim = null;
    if (delay.platform_execution_id) {
      const claimRes = platformKernel.claimExecution({ execution_id: delay.platform_execution_id, claimed_by: `delay-run:${process.pid}` });
      if (!claimRes.ok) {
        const detail = claimRes.code === "claim_held" ? `already being executed by another runner (${claimRes.claimed_by})` : `cannot run: execution ${claimRes.code}`;
        return { content: [{ type: "text", text: `Delay ${id} ${detail}` }], isError: true };
      }
      runClaim = claimRes.claim;
      if (runClaim.cancel_requested) {
        delay.status = "cancelled";
        delay.cancelledAt = now;
        transitionScheduledPlatformExecution("delay", delay, "cancelled", { reason: "cancel requested before dispatch", result_status: "cancelled", result_summary: `Cancelled delay ${id}` });
        appendScheduledPlatformEvent("delay", delay, "schedule.delay.cancelled", { cancelled_at: delay.cancelledAt });
        saveDelays(delays);
        releaseScheduledClaim(delay.platform_execution_id, runClaim);
        return { content: [{ type: "text", text: `Delay ${id} was cancelled before dispatch` }] };
      }
    }

    delay.status = "running";
    delay.startedAt = now;
    transitionScheduledPlatformExecution("delay", delay, "running", { reason: "delay execution started" });
    saveDelays(delays);
    let renewTimer = startScheduledLeaseRenewal(delay.platform_execution_id, runClaim);

    try {
      const result = await callTool(delay.tool, delay.args, {
        parentId: delay.platform_execution_id || null,
        rootExecutionId: delay.platform_execution_id || null,
        correlationId: delay.id,
      });
      if (renewTimer) clearInterval(renewTimer);
      // Release before the completion write: a rejected release means this
      // runner was superseded mid-dispatch, and its stale snapshot must not
      // clobber the current claimant's state.
      const release = releaseScheduledClaim(delay.platform_execution_id, runClaim);
      if (runClaim && !release.ok && release.code === "release_rejected") {
        return { content: [{ type: "text", text: `Delay ${id} finished but its claim was superseded; state is owned by the current claimant` }], isError: true };
      }
      const delaysAfter = loadDelays();
      const fresh = delaysAfter.find(d => d.id === id) || delay;
      fresh.status = result.isError ? "failed" : "completed";
      fresh.completedAt = new Date().toISOString();
      fresh.result = result.content?.[0]?.text?.substring(0, 200) || "ok";
      transitionScheduledPlatformExecution("delay", fresh, result.isError ? "failed" : "completed", {
        reason: result.isError ? "delay execution failed" : "delay execution completed",
        result_status: result.isError ? "failure" : "success",
        error_category: result.isError ? evolveCommon.errorCategory(fresh.result) : null,
        result_summary: fresh.result,
      });
      appendScheduledPlatformEvent("delay", fresh, result.isError ? "schedule.delay.failed" : "schedule.delay.completed", { completed_at: fresh.completedAt }, { severity: result.isError ? "error" : "info" });
      saveDelays(delaysAfter);
      if (result.isError) return { content: [{ type: "text", text: `Delay ${id} failed:\n\n${result.content?.[0]?.text || "error"}` }], isError: true };
      return { content: [{ type: "text", text: `Executed delay ${id}:\n\n${result.content?.[0]?.text || "ok"}` }] };
    } catch (e) {
      if (renewTimer) clearInterval(renewTimer);
      const release = releaseScheduledClaim(delay.platform_execution_id, runClaim);
      if (runClaim && !release.ok && release.code === "release_rejected") {
        return { content: [{ type: "text", text: `Delay ${id} threw (${e.message}) but its claim was superseded; state is owned by the current claimant` }], isError: true };
      }
      const delaysAfter = loadDelays();
      const fresh = delaysAfter.find(d => d.id === id) || delay;
      fresh.status = "failed";
      fresh.completedAt = new Date().toISOString();
      fresh.error = e.message;
      transitionScheduledPlatformExecution("delay", fresh, "failed", {
        reason: "delay execution threw",
        result_status: "failure",
        error_category: evolveCommon.errorCategory(e.message),
        result_summary: e.message,
      });
      appendScheduledPlatformEvent("delay", fresh, "schedule.delay.failed", { error: e.message }, { severity: "error" });
      saveDelays(delaysAfter);

      return { content: [{ type: "text", text: `Delay ${id} failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: add, list, cancel, run" }], isError: true };
}

// --- Watch Tool ---

const WATCHES_FILE = path.join(DATA_DIR, "watches.json");

function loadWatches() {
  if (!fs.existsSync(WATCHES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WATCHES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveWatches(watches) {
  fs.writeFileSync(WATCHES_FILE, JSON.stringify(watches, null, 2));
}

function checkService(serviceName) {
  try {
    const output = execFileSync("systemctl", ["is-active", serviceName], { encoding: "utf-8" }).trim();
    return { status: output, active: output === "active" };
  } catch {
    return { status: "unknown", active: false };
  }
}

function checkProcess(processName) {
  try {
    const output = execFileSync("pgrep", ["-f", processName], { encoding: "utf-8" }).trim();
    return { running: output.length > 0, pids: output.split("\n").filter(Boolean) };
  } catch {
    return { running: false, pids: [] };
  }
}

function checkEndpoint(url) {
  try {
    const output = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url], { encoding: "utf-8" }).trim();
    return { status: parseInt(output), ok: output.startsWith("2") };
  } catch {
    return { status: 0, ok: false };
  }
}

function checkFile(filePath, pattern) {
  try {
    const output = fs.readFileSync(filePath, "utf-8");
    const matches = pattern ? output.includes(pattern) : true;
    return { exists: true, matches, content: output.substring(0, 200) };
  } catch {
    return { exists: false, matches: false };
  }
}

function evaluateCondition(watch, checkResult) {
  const { source, condition, value } = watch;

  if (source === "service") {
    if (condition === "status!=active") return !checkResult.active;
    if (condition === "status=active") return checkResult.active;
  }

  if (source === "process") {
    if (condition === "not_running") return !checkResult.running;
    if (condition === "running") return checkResult.running;
  }

  if (source === "endpoint") {
    if (condition === "status!=200") return checkResult.status !== 200;
    if (condition === "status=200") return checkResult.status === 200;
    if (condition.startsWith("status>=")) {
      const threshold = parseInt(condition.substring(8));
      return checkResult.status >= threshold;
    }
  }

  if (source === "file") {
    if (condition === "content_matches") return checkResult.exists && checkResult.matches;
    if (condition === "not_exists") return !checkResult.exists;
    if (condition === "exists") return checkResult.exists;
  }

  return false;
}

async function executeWatchAction(watch, checkResult, metadata = {}) {
  const { action_tool, action_args } = watch;
  if (!action_tool) return;

  const args = { ...action_args };
  if (args.message) {
    args.message = args.message
      .replace(/\{\{source\}\}/g, watch.source)
      .replace(/\{\{target\}\}/g, watch.target)
      .replace(/\{\{status\}\}/g, JSON.stringify(checkResult))
      .replace(/\{\{time\}\}/g, new Date().toISOString());
  }

  try {
    return await callTool(action_tool, args, metadata);
  } catch (e) {
    console.error(`Watch ${watch.id} action failed: ${e.message}`);
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_watch({ action, id, name, source, target, condition, interval, action_tool, action_args, pause }) {
  const watches = loadWatches();
  const now = new Date().toISOString();

  if (action === "add") {
    if (!name || !source || !target || !condition) {
      return { content: [{ type: "text", text: "name, source, target, and condition required" }], isError: true };
    }

    const validSources = ["service", "process", "endpoint", "file"];
    if (!validSources.includes(source)) {
      return { content: [{ type: "text", text: `Invalid source. Use: ${validSources.join(", ")}` }], isError: true };
    }
    if (source === "file") {
      const policyError = enforcePathPolicy(target, "read");
      if (policyError) return policyError;
    }

    const watch = {
      id: generateId("watch"),
      name,
      source,
      target,
      condition,
      interval: interval || "60s",
      action_tool: action_tool || "sidekick_notify",
      action_args: action_args || { channel: "discord", message: "Watch triggered: {{source}} {{target}} at {{time}}" },
      created: now,
      status: "active",
      lastCheck: null,
      lastTriggered: null,
      triggerCount: 0
    };
    createScheduledPlatformExecution("watch", watch, {
      operationType: "watch_monitor",
      state: "queued",
      risk: getToolRisk(watch.action_tool),
      metadata: { source: watch.source, target: watch.target, condition: watch.condition, interval: watch.interval, action_tool: watch.action_tool },
      reason: "watch scheduled",
    });

    watches.push(watch);
    saveWatches(watches);
    appendScheduledPlatformEvent("watch", watch, "schedule.watch.added", { source: watch.source, target: watch.target, condition: watch.condition, interval: watch.interval });

    try {
      const http = require("http");
      const req = http.request({
        hostname: "127.0.0.1",
        port: 4099,
        path: "/api/watches/reload",
        method: "POST"
      });
      req.on("error", () => {});
      req.end();
    } catch {}

    return { content: [{ type: "text", text: `Added watch: ${watch.id}\nName: ${name}\nSource: ${source} ${target}\nCondition: ${condition}\nInterval: ${watch.interval}\nAction: ${watch.action_tool}` }] };
  }

  if (action === "list") {
    const active = watches.filter(w => w.status === "active");
    const paused = watches.filter(w => w.status === "paused");

    let output = `# Active Watches\n\n`;
    output += `**Active: ${active.length}**\n`;
    output += `**Paused: ${paused.length}**\n\n`;

    if (active.length > 0) {
      output += `## Active\n`;
      for (const w of active) {
        output += `- **${w.id}**: ${w.name}\n`;
        output += `  - Source: ${w.source} ${w.target}\n`;
        output += `  - Condition: ${w.condition}\n`;
        output += `  - Interval: ${w.interval}\n`;
        output += `  - Triggers: ${w.triggerCount}\n`;
        if (w.lastCheck) output += `  - Last check: ${w.lastCheck}\n`;
        if (w.lastTriggered) output += `  - Last triggered: ${w.lastTriggered}\n`;
      }
    }

    if (paused.length > 0) {
      output += `\n## Paused\n`;
      for (const w of paused) {
        output += `- ${w.id}: ${w.name}\n`;
      }
    }

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "remove") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const idx = watches.findIndex(w => w.id === id);
    if (idx === -1) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }

    const removed = watches.splice(idx, 1)[0];
    transitionScheduledPlatformExecution("watch", removed, "cancelled", {
      reason: "watch removed",
      result_status: "removed",
      result_summary: `Removed watch ${id}`,
    });
    appendScheduledPlatformEvent("watch", removed, "schedule.watch.removed", {});
    saveWatches(watches);

    return { content: [{ type: "text", text: `Removed watch: ${id}` }] };
  }

  if (action === "pause") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const watch = watches.find(w => w.id === id);
    if (!watch) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }

    watch.status = pause ? "paused" : "active";
    transitionScheduledPlatformExecution("watch", watch, pause ? "blocked" : "queued", {
      reason: pause ? "watch paused" : "watch resumed",
      result_status: pause ? "paused" : "active",
    });
    appendScheduledPlatformEvent("watch", watch, pause ? "schedule.watch.paused" : "schedule.watch.resumed", {});
    saveWatches(watches);

    return { content: [{ type: "text", text: `${pause ? "Paused" : "Resumed"} watch: ${id}` }] };
  }

  if (action === "check") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const watch = watches.find(w => w.id === id);
    if (!watch) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }

    const checkClaim = claimScheduledDefinition(watch, `watch-check:${process.pid}`, "watch");
    if (!checkClaim.ok) {
      const detail = checkClaim.code === "claim_held" ? `check already in progress (${checkClaim.claimed_by})` : `cannot check: execution ${checkClaim.code}`;
      return { content: [{ type: "text", text: `Watch ${id} ${detail}` }], isError: true };
    }
    if (checkClaim.claim && checkClaim.claim.cancel_requested) {
      pauseWatchForCancel(watch, checkClaim.claim);
      return { content: [{ type: "text", text: `Watch ${id} paused: cancel requested on its execution` }] };
    }
    // Everything after a successful claim runs under try/finally: a mid-check
    // throw must clear the renewal timer (which would otherwise keep the
    // lease fresh forever) and release the claim.
    const renewTimer = startScheduledLeaseRenewal(watch.platform_execution_id, checkClaim.claim);
    try {
      let checkResult;
      if (watch.source === "service") {
        checkResult = checkService(watch.target);
      } else if (watch.source === "process") {
        checkResult = checkProcess(watch.target);
      } else if (watch.source === "endpoint") {
        checkResult = checkEndpoint(watch.target);
      } else if (watch.source === "file") {
        const policyError = enforcePathPolicy(watch.target, "read");
        if (policyError) return policyError;
        checkResult = checkFile(watch.target, watch.condition === "content_matches" ? watch.value : null);
      }

      const checkExecution = createScheduledPlatformExecution("watch", watch, {
        attach: false,
        parentExecutionId: watch.platform_execution_id || null,
        rootExecutionId: watch.platform_execution_id || null,
        operationType: "watch_check",
        state: "running",
        risk: getToolRisk(watch.action_tool),
        metadata: { source: watch.source, target: watch.target, condition: watch.condition },
        reason: "watch check started",
      });
      const triggered = evaluateCondition(watch, checkResult);

      if (triggered) {
        appendScheduledPlatformEvent("watch", watch, "schedule.watch.triggered", { check_result: checkResult }, { executionId: checkExecution?.execution_id, rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id });
        const actionResult = await executeWatchAction(watch, checkResult, {
          parentId: checkExecution?.execution_id || watch.platform_execution_id || null,
          rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id || null,
          correlationId: watch.id,
        });
        if (checkExecution) platformKernel.transitionExecution(checkExecution.execution_id, actionResult?.isError ? "failed" : "completed", {
          source: "watch",
          actor_id: getCurrentSource() || "unknown",
          reason: actionResult?.isError ? "watch action failed" : "watch action completed",
          result_status: actionResult?.isError ? "failure" : "success",
          error_category: actionResult?.isError ? evolveCommon.errorCategory(actionResult.content?.[0]?.text || "watch action failed") : null,
          result_summary: actionResult?.content?.[0]?.text || "watch triggered",
          correlation_id: watch.id,
        });
      } else if (checkExecution) {
        platformKernel.transitionExecution(checkExecution.execution_id, "completed", {
          source: "watch",
          actor_id: getCurrentSource() || "unknown",
          reason: "watch check completed without trigger",
          result_status: "not_triggered",
          result_summary: `Watch ${watch.id} did not trigger`,
          correlation_id: watch.id,
        });
      }
      // Re-load before writing: the entry snapshot may be stale relative to a
      // concurrent tick for another watch in the other process.
      const watchesAfter = loadWatches();
      const fresh = watchesAfter.find(w => w.id === watch.id);
      if (fresh) {
        fresh.lastCheck = now;
        if (triggered) {
          fresh.lastTriggered = now;
          fresh.triggerCount = (fresh.triggerCount || 0) + 1;
        }
        saveWatches(watchesAfter);
      }

      return { content: [{ type: "text", text: `Watch check: ${watch.id}\nSource: ${watch.source} ${watch.target}\nResult: ${JSON.stringify(checkResult)}\nTriggered: ${triggered}` }] };
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      releaseScheduledClaim(watch.platform_execution_id, checkClaim.claim);
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: add, list, remove, pause, check" }], isError: true };
}

// --- Secret Tool ---

const crypto = require("crypto");
const SECRETS_FILE = path.join(DATA_DIR, "secrets.enc");

// AES-256-GCM value cipher relocated to a shared module so the approval
// continuation storage layer can encrypt at rest without requiring
// `tools-legacy` at top level (docs/tool-architecture.md). Wire format
// unchanged, so existing ciphertext keeps decrypting.
const { getSecretKey, encryptSecret, decryptSecret } = require("./core/secret-cipher");

function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    const data = fs.readFileSync(SECRETS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveSecrets(secrets) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

async function sidekick_secret({ action, key, value, generate }) {
  const now = new Date().toISOString();

  try {
    getSecretKey();
  } catch (e) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }

  const secrets = loadSecrets();

  if (action === "store") {
    if (!key || !value) {
      return { content: [{ type: "text", text: "key and value required" }], isError: true };
    }

    const encrypted = encryptSecret(value);
    secrets[key] = {
      ...encrypted,
      created: now,
      updated: now
    };
    saveSecrets(secrets);

    return { content: [{ type: "text", text: `Stored secret: ${key}` }] };
  }

  if (action === "get") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }

    const secret = secrets[key];
    if (!secret) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }

    try {
      const decrypted = decryptSecret(secret);
      return { content: [{ type: "text", text: decrypted }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Decryption failed: ${e.message}` }], isError: true };
    }
  }

  if (action === "delete") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }

    if (!secrets[key]) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }

    delete secrets[key];
    saveSecrets(secrets);

    return { content: [{ type: "text", text: `Deleted secret: ${key}` }] };
  }

  if (action === "list") {
    const keys = Object.keys(secrets);
    let output = `# Stored Secrets (${keys.length})\n\n`;
    for (const k of keys) {
      const s = secrets[k];
      output += `- **${k}** (created: ${s.created}, updated: ${s.updated})\n`;
    }
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "rotate") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }

    const secret = secrets[key];
    if (!secret) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }

    let newValue;
    if (generate) {
      const length = parseInt(generate);
      if (isNaN(length) || length < 8) {
        return { content: [{ type: "text", text: "generate must be a number >= 8" }], isError: true };
      }
      newValue = crypto.randomBytes(length).toString("hex").substring(0, length);
    } else {
      return { content: [{ type: "text", text: "generate parameter required for rotation" }], isError: true };
    }

    const encrypted = encryptSecret(newValue);
    secrets[key] = {
      ...encrypted,
      created: secret.created,
      updated: now
    };
    saveSecrets(secrets);

    return { content: [{ type: "text", text: `Rotated secret: ${key}\nNew value: ${newValue}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: store, get, delete, list, rotate" }], isError: true };
}

// --- Queue Tool ---

const QUEUE_FILE = path.join(DATA_DIR, "queue.json");

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return { tasks: [], nextId: 1 };
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch {
    return { tasks: [], nextId: 1 };
  }
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

async function sidekick_queue({ action, id, tool, args, priority, status }) {
  const queue = loadQueue();

  if (action === "add") {
    if (!tool) {
      return { content: [{ type: "text", text: "tool required" }], isError: true };
    }

    const task = {
      id: queue.nextId++,
      tool,
      args: args || {},
      priority: priority || 0,
      status: "pending",
      created: new Date().toISOString(),
      attempts: 0
    };

    queue.tasks.push(task);
    queue.tasks.sort((a, b) => b.priority - a.priority);
    saveQueue(queue);

    return { content: [{ type: "text", text: `Added task ${task.id} (priority: ${task.priority})` }] };
  }

  if (action === "list") {
    const filterStatus = status || "all";
    const filtered = filterStatus === "all"
      ? queue.tasks
      : queue.tasks.filter(t => t.status === filterStatus);

    if (filtered.length === 0) {
      return { content: [{ type: "text", text: `No tasks found (status: ${filterStatus})` }] };
    }

    const summary = filtered.map(t =>
      `Task ${t.id}: ${t.tool} (priority: ${t.priority}, status: ${t.status}, attempts: ${t.attempts})`
    ).join("\n");

    return { content: [{ type: "text", text: `Queue (${filtered.length} tasks):\n${summary}` }] };
  }

  if (action === "process") {
    const pending = queue.tasks.find(t => t.status === "pending");

    if (!pending) {
      return { content: [{ type: "text", text: "No pending tasks" }] };
    }

    pending.status = "processing";
    pending.attempts++;
    saveQueue(queue);

    try {
      const result = await callTool(pending.tool, pending.args);

      if (result.isError) {
        pending.status = "failed";
        pending.error = result.content?.[0]?.text || "Unknown error";
        pending.failedAt = new Date().toISOString();
      } else {
        pending.status = "completed";
        pending.result = result.content?.[0]?.text?.substring(0, 200);
        pending.completedAt = new Date().toISOString();
      }

      saveQueue(queue);
      return result;
    } catch (e) {
      pending.status = "failed";
      pending.error = e.message;
      pending.failedAt = new Date().toISOString();
      saveQueue(queue);

      return { content: [{ type: "text", text: `Task failed: ${e.message}` }], isError: true };
    }
  }

  if (action === "remove") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const idx = queue.tasks.findIndex(t => t.id === id);
    if (idx === -1) {
      return { content: [{ type: "text", text: `Task ${id} not found` }], isError: true };
    }

    queue.tasks.splice(idx, 1);
    saveQueue(queue);

    return { content: [{ type: "text", text: `Removed task ${id}` }] };
  }

  if (action === "clear") {
    const clearStatus = status || "all";

    if (clearStatus === "all") {
      queue.tasks = [];
    } else {
      queue.tasks = queue.tasks.filter(t => t.status !== clearStatus);
    }

    saveQueue(queue);
    return { content: [{ type: "text", text: `Cleared tasks (status: ${clearStatus})` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: add, list, process, remove, clear" }], isError: true };
}

// --- Retry Tool ---

async function sidekick_retry({ tool, args, max_attempts, backoff, initial_delay }) {
  if (!tool) {
    return { content: [{ type: "text", text: "tool required" }], isError: true };
  }

  const maxAttempts = max_attempts || 3;
  const backoffType = backoff || "exponential";
  const initialDelay = initial_delay || 1000;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callTool(tool, args || {});

      if (!result.isError) {
        return { content: [{ type: "text", text: `✓ Succeeded on attempt ${attempt}\n\n${result.content?.[0]?.text || ""}` }] };
      }

      lastError = result.content?.[0]?.text || "Unknown error";
    } catch (e) {
      lastError = e.message;
    }

    if (attempt < maxAttempts) {
      let delay;
      if (backoffType === "exponential") {
        delay = initialDelay * Math.pow(2, attempt - 1);
      } else if (backoffType === "linear") {
        delay = initialDelay * attempt;
      } else {
        delay = initialDelay;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { content: [{ type: "text", text: `✗ Failed after ${maxAttempts} attempts\nLast error: ${lastError}` }], isError: true };
}

// --- Evolve Tool ---

async function sidekick_evolve(args = {}) {
  const evolveImpl = require("./evolve");
  // Active module tools count as built-in names so evolve cannot mint a
  // generated capability that collides with a module-owned tool.
  const moduleDefs = require("./modules/loader").getActiveDescriptors().map(d => ({ name: d.name, aliases: d.aliases, description: d.description, args: d.args }));
  return evolveImpl.sidekick_evolve(args, { TOOL_DEFS: [...TOOL_DEFS, ...moduleDefs], loadProcedures });
}

// --- Orchestrate Tool ---

const ORCHESTRATE_FILE = path.join(DATA_DIR, "orchestrate.json");

function loadOrchestrate() {
  if (!fs.existsSync(ORCHESTRATE_FILE)) return { tasks: [], nextId: 1 };
  try {
    return JSON.parse(fs.readFileSync(ORCHESTRATE_FILE, "utf-8"));
  } catch {
    return { tasks: [], nextId: 1 };
  }
}

function saveOrchestrate(orchestrate) {
  fs.writeFileSync(ORCHESTRATE_FILE, JSON.stringify(orchestrate, null, 2));
}

async function sidekick_orchestrate({ action, id, task_name, subtasks, dependencies, timeout }) {
  const orchestrate = loadOrchestrate();
  const now = new Date().toISOString();

  if (action === "create") {
    if (!task_name || !subtasks || !Array.isArray(subtasks)) {
      return { content: [{ type: "text", text: "task_name and subtasks array required" }], isError: true };
    }

    const taskId = orchestrate.nextId++;
    const task = {
      id: taskId,
      name: task_name,
      subtasks: subtasks.map((st, idx) => ({
        id: `${taskId}-${idx}`,
        name: st.name || `Subtask ${idx + 1}`,
        tool: st.tool,
        args: st.args || {},
        status: "pending",
        result: null,
        error: null
      })),
      dependencies: dependencies || {},
      status: "created",
      created: now,
      timeout: timeout || 1800000, // 30 minutes default
      results: {}
    };

    orchestrate.tasks.push(task);
    saveOrchestrate(orchestrate);

    return { content: [{ type: "text", text: `Task ${taskId} created with ${subtasks.length} subtasks\nName: ${task_name}` }] };
  }

  if (action === "execute") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }

    task.status = "executing";
    task.startedAt = now;
    saveOrchestrate(orchestrate);

    // Execute subtasks respecting dependencies
    const executed = new Set();
    const results = {};

    for (const subtask of task.subtasks) {
      const deps = task.dependencies[subtask.id] || [];
      const depsMet = deps.every(d => executed.has(d));

      if (!depsMet) {
        subtask.status = "skipped";
        subtask.error = "Dependencies not met";
        continue;
      }

      subtask.status = "running";
      saveOrchestrate(orchestrate);

      try {
        const result = await callTool(subtask.tool, subtask.args);
        subtask.status = result.isError ? "failed" : "completed";
        subtask.result = result.content?.[0]?.text?.substring(0, 500);
        subtask.error = result.isError ? result.content?.[0]?.text : null;
        results[subtask.id] = subtask.result;
        executed.add(subtask.id);
      } catch (e) {
        subtask.status = "failed";
        subtask.error = e.message;
      }

      saveOrchestrate(orchestrate);
    }

    task.status = "completed";
    task.completedAt = new Date().toISOString();
    task.results = results;
    saveOrchestrate(orchestrate);

    const summary = task.subtasks.map(st =>
      `${st.name}: ${st.status}${st.error ? ` (${st.error.substring(0, 50)})` : ""}`
    ).join("\n");

    return { content: [{ type: "text", text: `Task ${id} executed\n\nSubtask Results:\n${summary}` }] };
  }

  if (action === "list") {
    if (orchestrate.tasks.length === 0) {
      return { content: [{ type: "text", text: "No orchestration tasks" }] };
    }

    const list = orchestrate.tasks.map(t =>
      `ID: ${t.id}\nName: ${t.name}\nStatus: ${t.status}\nSubtasks: ${t.subtasks.length}\nCreated: ${t.created}`
    ).join("\n\n");

    return { content: [{ type: "text", text: `# Orchestration Tasks (${orchestrate.tasks.length})\n\n${list}` }] };
  }

  if (action === "status") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }

    const status = task.subtasks.map(st =>
      `${st.name}: ${st.status}${st.result ? `\n  Result: ${st.result.substring(0, 100)}...` : ""}${st.error ? `\n  Error: ${st.error.substring(0, 100)}` : ""}`
    ).join("\n\n");

    return { content: [{ type: "text", text: `# Task ${id} Status\n\nName: ${task.name}\nOverall: ${task.status}\n\n## Subtasks\n\n${status}` }] };
  }

  if (action === "cancel") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }

    task.status = "cancelled";
    task.cancelledAt = new Date().toISOString();
    saveOrchestrate(orchestrate);

    return { content: [{ type: "text", text: `Task ${id} cancelled` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: create, execute, list, status, cancel" }], isError: true };
}

// --- Token-efficient tools (v1.17) ---

async function sidekick_batch({ calls }) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return { content: [{ type: "text", text: "calls must be a non-empty array" }], isError: true };
  }
  if (calls.length > 20) {
    return { content: [{ type: "text", text: "Maximum 20 calls per batch" }], isError: true };
  }
  const results = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    // Resolve against TOOL_DEFS rather than the TOOLS handler map: descriptor-owned
    // families (src/tools/families/) keep their TOOL_DEFS row as an ordering anchor
    // but no longer have a legacy handler entry. Every TOOL_DEFS name is dispatchable,
    // so this stays equivalent to the old check for legacy-owned tools while keeping
    // extracted tools reachable. Active module tools are dispatchable too;
    // generated tools stay excluded as before. Execution still goes through
    // callTool -> dispatcher.
    if (!call.tool || !(isBuiltinToolName(call.tool) || require("./modules/loader").resolveActiveDescriptor(call.tool))) {
      results.push({ index: i, tool: call.tool, error: "Unknown tool: " + call.tool });
      continue;
    }
    const start = Date.now();
    try {
      const result = await callTool(call.tool, call.args || {});
      results.push({
        index: i,
        tool: call.tool,
        result: result.content?.[0]?.text?.substring(0, 500) || "(ok)",
        error: result.isError || false,
        duration_ms: Date.now() - start
      });
    } catch (e) {
      results.push({ index: i, tool: call.tool, error: e.message });
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

async function sidekick_project({ name, include }) {
  const sections = (include || "kv,context").split(",").map(s => s.trim());
  const output = {};
  if (sections.includes("kv")) {
    const allKV = dbStore.getAllKV();
    const kvResults = [];
    for (const [key, entry] of Object.entries(allKV)) {
      if (typeof entry === 'object' && entry !== null && entry.project === name) {
        kvResults.push({ key, value: typeof entry.value === 'string' ? entry.value.substring(0, 200) : entry.value, updated: entry.updated });
      }
    }
    output.kv = kvResults;
  }
  if (sections.includes("context")) {
    const ctx = loadSharedContext();
    const structuredMemories = dbStore.searchMemories({ project: name, limit: 20 }).map(i => ({
      type: i.type || "memory",
      summary: i.summary || i.content,
      created: i.last_seen_at || i.updated_at,
      project: i.project
    }));
    const items = [
      ...structuredMemories,
      ...(ctx.decisions || []).map(i => ({ type: "decision", summary: i.decision, created: i.date, project: i.project })),
      ...(ctx.problems || []).map(i => ({ type: "problem", summary: i.description, created: i.date, project: i.project })),
      ...(ctx.patterns || []).map(i => ({ type: "pattern", summary: i.description, created: i.date, project: i.project })),
      ...(ctx.sessions || []).map(i => ({ type: "session", summary: i.summary, created: i.date, project: i.project })),
      ...(ctx.memories || []).map(i => ({ type: i.type || "memory", summary: i.summary || i.goal || i.tool, created: i.date, project: i.project }))
    ].filter(i => i.project === name);
    output.context = items.slice(-20).map(i => ({
      type: i.type,
      summary: String(i.summary || "").substring(0, 200),
      created: i.created
    }));
  }
  if (sections.includes("logs")) {
    const toolLogs = dbStore.readToolLogs(20);
    output.logs = toolLogs.map(l => ({
      time: l.t, tool: l.n, ok: l.ok, summary: l.s
    }));
  }
  if (sections.includes("procedures")) {
    const procs = loadProcedures();
    output.procedures = Object.keys(procs).filter(n => n.toLowerCase().includes(name.toLowerCase()));
  }
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

const MISSION_PROFILES = {
  read_only_audit: {
    risk: "low",
    description: "Read-only inspection. Routes status, logs, tool discovery, project context, and deploy verification.",
    execute: ["status", "logs", "tools", "policy", "project", "verify_deploy"]
  },
  trusted_vps: {
    risk: "high",
    description: "Trusted single-operator VPS. Allows normal inspection plus deploy_current_main with confirmation.",
    execute: ["status", "logs", "tools", "policy", "project", "verify_deploy", "deploy", "delete_key"]
  },
  production: {
    risk: "critical",
    description: "Production-like host. Requires confirmation for mutation and defaults deploy requests to verification.",
    execute: ["status", "logs", "tools", "policy", "project", "verify_deploy", "delete_key"]
  },
  danger_zone: {
    risk: "critical",
    description: "Explicit high-power mode. Allows deploy_current_main and key deletion with confirmation.",
    execute: ["status", "logs", "tools", "policy", "project", "verify_deploy", "deploy", "delete_key"]
  }
};

function normalizeMissionIntent(intent) {
  const text = String(intent || "").toLowerCase();
  if (!text.trim()) return "unknown";
  if (/\bdeploy\b|release|rollout|ship/.test(text)) return "deploy";
  if (/verify.*deploy|deployed.*commit|current.*main|matches.*origin/.test(text)) return "verify_deploy";
  if (/status|health|uptime|services|disk|memory|load/.test(text)) return "status";
  if (/log|logs|history|recent activity|tool calls/.test(text)) return "logs";
  if (/policy|permission|permissions|allowed|blocked|lockdown|approval|approvals|why.*tool|tool.*why|who can call|can call|call what|risk/.test(text)) return "policy";
  if (/tool|tools|catalog|manifest|available capabilities|what can sidekick do/.test(text)) return "tools";
  if (/project|memory|context|remember|stored facts/.test(text)) return "project";
  if (/delete.*key|remove.*key|delete.*kv|remove.*kv/.test(text)) return "delete_key";
  return "unknown";
}

function missionRoute(intent, profileName = "trusted_vps", options = {}) {
  const route = normalizeMissionIntent(intent);
  const profile = MISSION_PROFILES[profileName] ? profileName : "trusted_vps";
  const allowed = MISSION_PROFILES[profile].execute.includes(route);
  const toolMap = {
    deploy: { tool: "ops", args: { action: "deploy_current_main", repo_path: options.repo_path } },
    verify_deploy: { tool: "ops", args: { action: "verify_deployed_commit", repo_path: options.repo_path } },
    status: { tool: "status", args: { include: options.include || "services,disk,memory,load,uptime", services: options.services } },
    logs: { tool: "log_query", args: { limit: options.limit || 20, tool: options.tool, source: options.source } },
    tools: { tool: "tools", args: { action: options.query ? "search" : "overview", query: options.query, format: options.format || "text" } },
    policy: { tool: "tools", args: { action: "policy", name: options.tool, source: options.source, format: options.format || "text", limit: options.limit } },
    project: { tool: "project", args: { name: options.project || "sidekick", include: options.include || "kv,context" } },
    delete_key: { tool: "delete", args: { key: options.key } }
  };
  const recommendation = toolMap[route] || null;
  const requiresConfirmation = ["deploy", "delete_key"].includes(route);
  return {
    intent: intent || "",
    profile,
    route,
    allowed,
    requires_confirmation: requiresConfirmation,
    risk: route === "deploy" ? "critical" : (route === "delete_key" ? "medium" : "low"),
    recommended_tool: recommendation?.tool || null,
    recommended_args: recommendation?.args || null,
    reason: route === "unknown"
      ? "No deterministic route matched. Use tools action=search or a narrower tool."
      : (allowed ? "Route is allowed by profile." : "Route is not allowed by profile.")
  };
}

function formatMissionRoute(route) {
  return [
    "MISSION ROUTE",
    `Intent: ${route.intent || "(empty)"}`,
    `Profile: ${route.profile}`,
    `Route: ${route.route}`,
    `Allowed: ${route.allowed ? "yes" : "no"}`,
    `Risk: ${route.risk}`,
    `Requires confirmation: ${route.requires_confirmation ? "yes" : "no"}`,
    `Recommended tool: ${route.recommended_tool || "(none)"}`,
    `Recommended args: ${route.recommended_args ? JSON.stringify(route.recommended_args) : "(none)"}`,
    `Reason: ${route.reason}`
  ].join("\n");
}

async function sidekick_mission({ action, intent, profile, confirm, key, project, query, include, services, repo_path, limit, tool, source, format }) {
  const selectedAction = action || "route";
  if (selectedAction === "profiles") {
    return { content: [{ type: "text", text: JSON.stringify(MISSION_PROFILES, null, 2) }] };
  }

  const route = missionRoute(intent, profile, { key, project, query, include, services, repo_path, limit, tool, source, format });

  if (selectedAction === "route") {
    return { content: [{ type: "text", text: formatMissionRoute(route) }] };
  }

  if (selectedAction === "preflight") {
    const checks = [
      route.route === "unknown" ? "Clarify intent or use tools search." : "Intent mapped deterministically.",
      route.allowed ? "Profile allows this route." : "Profile blocks this route.",
      route.requires_confirmation ? "Mutation requires confirm=true before execute." : "No mutation confirmation required.",
      route.recommended_tool ? `Use ${route.recommended_tool}.` : "No tool selected."
    ];
    return { content: [{ type: "text", text: JSON.stringify({ ...route, checks }, null, 2) }], isError: !route.allowed || route.route === "unknown" };
  }

  if (selectedAction === "execute") {
    if (route.route === "unknown") {
      return { content: [{ type: "text", text: "No deterministic route matched. Run action=route or action=preflight first." }], isError: true };
    }
    if (!route.allowed) {
      return { content: [{ type: "text", text: `Route ${route.route} is blocked by profile ${route.profile}` }], isError: true };
    }
    if (route.requires_confirmation && confirm !== true) {
      return { content: [{ type: "text", text: `Route ${route.route} requires confirm=true before execution.` }], isError: true };
    }
    if (route.route === "delete_key" && !key) {
      return { content: [{ type: "text", text: "key is required for delete_key missions" }], isError: true };
    }
    return callTool(route.recommended_tool, route.recommended_args || {});
  }

  return { content: [{ type: "text", text: "Invalid action. Allowed: profiles, route, preflight, execute" }], isError: true };
}

const CIRCUIT_FILE = path.join(DATA_DIR, "circuits.json");
const MAX_CIRCUIT_TARGETS = 20;
const CIRCUIT_IDLE_RESET_HOURS = 1;

function loadCircuits() {
  try {
    if (fs.existsSync(CIRCUIT_FILE)) {
      return JSON.parse(fs.readFileSync(CIRCUIT_FILE, "utf8"));
    }
  } catch {}
  return { circuits: {} };
}

function saveCircuits(data) {
  fs.writeFileSync(CIRCUIT_FILE, JSON.stringify(data, null, 2));
}

function cleanupIdleCircuits(data) {
  const now = Date.now();
  const idleMs = CIRCUIT_IDLE_RESET_HOURS * 3600000;
  let cleaned = 0;
  for (const [target, circuit] of Object.entries(data.circuits)) {
    if (now - circuit.lastAccess > idleMs) {
      delete data.circuits[target];
      cleaned++;
    }
  }
  return cleaned;
}

async function sidekick_circuit({ action, target, tool, args, failure_threshold, cooldown_seconds, cache_response }) {
  const data = loadCircuits();
  cleanupIdleCircuits(data);

  if (action === "status") {
    const entries = Object.entries(data.circuits);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No circuits configured" }] };
    }
    const list = entries.map(([t, c]) => {
      const age = Math.round((Date.now() - c.lastAccess) / 1000);
      return `${t}: ${c.state} (failures: ${c.failures}/${c.threshold}, cooldown: ${c.cooldown}s, last: ${age}s ago)`;
    }).join("\n");
    return { content: [{ type: "text", text: `Circuits (${entries.length}/${MAX_CIRCUIT_TARGETS}):\n\n${list}` }] };
  }

  if (action === "reset") {
    if (!target) {
      return { content: [{ type: "text", text: "target required" }], isError: true };
    }
    if (data.circuits[target]) {
      data.circuits[target].state = "closed";
      data.circuits[target].failures = 0;
      data.circuits[target].lastFailure = null;
      saveCircuits(data);
      return { content: [{ type: "text", text: `Circuit reset: ${target}` }] };
    }
    return { content: [{ type: "text", text: `Circuit not found: ${target}` }], isError: true };
  }

  if (action === "configure") {
    if (!target) {
      return { content: [{ type: "text", text: "target required" }], isError: true };
    }
    if (!data.circuits[target]) {
      if (Object.keys(data.circuits).length >= MAX_CIRCUIT_TARGETS) {
        return { content: [{ type: "text", text: `Max circuits reached (${MAX_CIRCUIT_TARGETS})` }], isError: true };
      }
      data.circuits[target] = {
        state: "closed",
        failures: 0,
        threshold: failure_threshold || 5,
        cooldown: cooldown_seconds || 60,
        lastFailure: null,
        lastAccess: Date.now(),
        cachedResponse: null
      };
    } else {
      if (failure_threshold !== undefined) data.circuits[target].threshold = failure_threshold;
      if (cooldown_seconds !== undefined) data.circuits[target].cooldown = cooldown_seconds;
    }
    saveCircuits(data);
    return { content: [{ type: "text", text: `Circuit configured: ${target} (threshold: ${data.circuits[target].threshold}, cooldown: ${data.circuits[target].cooldown}s)` }] };
  }

  if (action === "call") {
    if (!target || !tool) {
      return { content: [{ type: "text", text: "target and tool required" }], isError: true };
    }

    if (!data.circuits[target]) {
      if (Object.keys(data.circuits).length >= MAX_CIRCUIT_TARGETS) {
        return { content: [{ type: "text", text: `Max circuits reached (${MAX_CIRCUIT_TARGETS}). Configure a circuit first.` }], isError: true };
      }
      data.circuits[target] = {
        state: "closed",
        failures: 0,
        threshold: failure_threshold || 5,
        cooldown: cooldown_seconds || 60,
        lastFailure: null,
        lastAccess: Date.now(),
        cachedResponse: null
      };
    }

    const circuit = data.circuits[target];
    circuit.lastAccess = Date.now();
    const now = Date.now();

    if (circuit.state === "open") {
      const elapsed = (now - circuit.lastFailure) / 1000;
      if (elapsed >= circuit.cooldown) {
        circuit.state = "half-open";
      } else {
        const remaining = Math.ceil(circuit.cooldown - elapsed);
        if (cache_response && circuit.cachedResponse) {
          saveCircuits(data);
          return { content: [{ type: "text", text: `[CIRCUIT OPEN - CACHED] ${target}\nCooldown: ${remaining}s remaining\n\n${circuit.cachedResponse}` }] };
        }
        saveCircuits(data);
        return { content: [{ type: "text", text: `[CIRCUIT OPEN] ${target}\nFailures: ${circuit.failures}/${circuit.threshold}\nCooldown: ${remaining}s remaining\nTool: ${tool} (not called)` }], isError: true };
      }
    }

    const result = await callTool(tool, args || {});
    const success = !result.isError;

    if (success) {
      circuit.state = "closed";
      circuit.failures = 0;
      circuit.lastFailure = null;
      if (cache_response && result.content && result.content[0]) {
        circuit.cachedResponse = result.content[0].text;
      }
      saveCircuits(data);
      return result;
    } else {
      circuit.failures++;
      circuit.lastFailure = now;
      if (circuit.failures >= circuit.threshold) {
        circuit.state = "open";
      }
      saveCircuits(data);
      const stateInfo = circuit.state === "open" ? " (CIRCUIT NOW OPEN)" : "";
      return { content: [{ type: "text", text: `${result.content?.[0]?.text || "Tool call failed"}\n\n[CIRCUIT] ${target}: ${circuit.failures}/${circuit.threshold} failures${stateInfo}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: call, status, reset, configure" }], isError: true };
}

const RUNBOOK_FILE = path.join(DATA_DIR, "runbooks.json");
const MAX_RUNBOOKS = 20;
const MAX_ACTIVE_INSTANCES = 5;
const MAX_STEPS_PER_RUNBOOK = 20;
const STEP_TIMEOUT_MS = 60000;
// Claim lease sized for the worst-case autonomous run (20 steps x step +
// verify + rollback timeouts ~= 27 min) instead of using a renewal timer — no
// timer means no path to a perpetually-renewed leak.
const RUNBOOK_CLAIM_LEASE_MS = 3600000;
const RUNBOOK_ABANDON_AGE_MS = 30 * 60 * 1000;

function loadRunbooks() {
  try {
    if (fs.existsSync(RUNBOOK_FILE)) {
      return JSON.parse(fs.readFileSync(RUNBOOK_FILE, "utf8"));
    }
  } catch {}
  return { definitions: {}, instances: {} };
}

// Phase 4/B restart recovery: an instance stranded `running` by a crash used
// to hold one of the MAX_ACTIVE_INSTANCES capacity slots forever. An instance
// is abandoned when no live claim exists AND its execution is orphaned or has
// sat in `running` past the worst-case runtime. Guided instances parked
// between steps (execution `waiting`) are never touched, and instances whose
// execution already reached a terminal state have their file status synced.
function recoverStrandedRunbooks(details = {}) {
  try {
    platformKernel.recoverOrphanedExecutions({ source: details.source || "runbook", actor_id: details.actor || null });
  } catch (e) {}
  const data = loadRunbooks();
  const recovered = [];
  const nowMs = Date.now();
  for (const instance of Object.values(data.instances)) {
    if (instance.status !== "running" || !instance.platform_execution_id) continue;
    try {
      const claim = platformKernel.getExecutionClaim(instance.platform_execution_id);
      if (claim && claim.claimed_by && claim.lease_expires_at && claim.lease_expires_at > new Date().toISOString()) continue;
      const exec = platformKernel.getExecution(instance.platform_execution_id);
      if (!exec || exec.state === "waiting") continue;
      if (platformKernel.TERMINAL_STATES.has(exec.state)) {
        instance.status = exec.state === "completed" ? "completed" : "failed";
        recovered.push(instance.id);
        continue;
      }
      const isOrphaned = exec.state === "orphaned";
      const isStaleRunning = exec.state === "running" && nowMs - (instance.started || 0) > RUNBOOK_ABANDON_AGE_MS;
      if (!isOrphaned && !isStaleRunning) continue;
      if (isOrphaned) {
        platformKernel.transitionExecution(instance.platform_execution_id, "running", { source: details.source || "runbook", actor_id: details.actor || null, reason: "recovering orphaned runbook instance", correlation_id: instance.id });
      }
      platformKernel.transitionExecution(instance.platform_execution_id, "failed", { source: details.source || "runbook", actor_id: details.actor || null, reason: "runbook instance abandoned after runner crash", result_status: "failure", error_category: "timeout", result_summary: `Runbook instance ${instance.id} abandoned at step ${instance.currentStep}`, correlation_id: instance.id });
      instance.status = "failed";
      instance.abandoned = true;
      recovered.push(instance.id);
    } catch (e) {}
  }
  if (recovered.length > 0) saveRunbooks(data);
  return { recovered: recovered.length, instances: recovered };
}

function saveRunbooks(data) {
  fs.writeFileSync(RUNBOOK_FILE, JSON.stringify(data, null, 2));
}

function generateRunbookId() {
  return "rb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function sidekick_runbook({ action, name, mode, steps, runbook_id, step_index }) {
  const data = loadRunbooks();
  const execMode = mode || "autonomous";

  if (action === "create") {
    if (!name || !steps || steps.length === 0) {
      return { content: [{ type: "text", text: "name and steps required" }], isError: true };
    }
    if (steps.length > MAX_STEPS_PER_RUNBOOK) {
      return { content: [{ type: "text", text: `Max steps per runbook: ${MAX_STEPS_PER_RUNBOOK}` }], isError: true };
    }
    if (Object.keys(data.definitions).length >= MAX_RUNBOOKS) {
      return { content: [{ type: "text", text: `Max runbooks reached (${MAX_RUNBOOKS})` }], isError: true };
    }

    const id = generateRunbookId();
    data.definitions[id] = {
      name,
      steps,
      created: Date.now()
    };
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Runbook created: ${id} (${name})\nSteps: ${steps.length}` }] };
  }

  if (action === "list") {
    const entries = Object.entries(data.definitions);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No runbooks defined" }] };
    }
    const list = entries.map(([id, rb]) => {
      const instances = Object.values(data.instances).filter(i => i.definitionId === id && i.status === "running").length;
      return `${id}: ${rb.name} (${rb.steps.length} steps, ${instances} active)`;
    }).join("\n");
    return { content: [{ type: "text", text: `Runbooks (${entries.length}/${MAX_RUNBOOKS}):\n\n${list}` }] };
  }

  if (action === "get") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let rb = null;
    let rbId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { rb = def; rbId = id; break; }
      }
    } else {
      rb = data.definitions[runbook_id];
    }
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }
    const stepsList = rb.steps.map((s, i) => `${i + 1}. ${s.name}\n   Command: ${s.command}\n   ${s.rollback ? "Rollback: " + s.rollback : ""}\n   ${s.verify_command ? "Verify: " + s.verify_command : ""}`).join("\n\n");
    return { content: [{ type: "text", text: `Runbook: ${rbId} (${rb.name})\n\n${stepsList}` }] };
  }

  if (action === "delete") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let targetId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { targetId = id; break; }
      }
    }
    if (!data.definitions[targetId]) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }
    delete data.definitions[targetId];
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Deleted runbook: ${targetId}` }] };
  }

  if (action === "start") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let rb = null;
    let rbId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { rb = def; rbId = id; break; }
      }
    } else {
      rb = data.definitions[runbook_id];
    }
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }

    const activeCount = Object.values(data.instances).filter(i => i.status === "running").length;
    if (activeCount >= MAX_ACTIVE_INSTANCES) {
      return { content: [{ type: "text", text: `Max active instances reached (${MAX_ACTIVE_INSTANCES})` }], isError: true };
    }

    const instanceId = generateRunbookId();
    data.instances[instanceId] = {
      id: instanceId,
      definitionId: rbId,
      status: "running",
      currentStep: 0,
      mode: execMode,
      started: Date.now(),
      results: []
    };
    createScheduledPlatformExecution("runbook", data.instances[instanceId], {
      operationType: "runbook_execution",
      state: "running",
      risk: "critical",
      metadata: { definition_id: rbId, mode: execMode, steps: rb.steps.length, runbook_name: rb.name },
      reason: "runbook started",
    });
    saveRunbooks(data);

    // Liveness claim (Phase 4/B): the lease marks this instance as actively
    // running so recoverStrandedRunbooks can tell a live run from one
    // abandoned by a crash. The lease is sized for the worst-case autonomous
    // run instead of using a renewal timer — no timer means no path to a
    // perpetually-renewed leak; a crash self-heals at lease expiry.
    const startedInstance = data.instances[instanceId];
    const startClaimRes = startedInstance.platform_execution_id ? platformKernel.claimExecution({ execution_id: startedInstance.platform_execution_id, claimed_by: `runbook-run:${process.pid}`, lease_ms: RUNBOOK_CLAIM_LEASE_MS }) : { ok: true, claim: null };
    const startClaim = startClaimRes.ok ? startClaimRes.claim : null;
    if (startClaim && startClaim.cancel_requested) {
      startedInstance.status = "cancelled";
      transitionScheduledPlatformExecution("runbook", startedInstance, "cancelled", { reason: "cancel requested before first step", result_status: "cancelled" });
      saveRunbooks(data);
      releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
      return { content: [{ type: "text", text: `Runbook instance ${instanceId} cancelled before dispatch` }] };
    }

    if (execMode === "autonomous") {
      let output = `Starting autonomous runbook: ${rbId} (${rb.name})\n\n`;
      for (let i = 0; i < rb.steps.length; i++) {
        const step = rb.steps[i];
        output += `Step ${i + 1}/${rb.steps.length}: ${step.name}\n`;
        appendScheduledPlatformEvent("runbook", data.instances[instanceId], "runbook.step_started", { step: i, name: step.name });
        try {
          const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
          output += `  ✓ Success\n`;
          appendScheduledPlatformEvent("runbook", data.instances[instanceId], "runbook.step_completed", { step: i, name: step.name });
          if (step.verify_command) {
            try {
              const verifyResult = execSync(step.verify_command, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
              output += `  ✓ Verified\n`;
              appendScheduledPlatformEvent("runbook", data.instances[instanceId], "runbook.step_verified", { step: i, name: step.name });
            } catch (e) {
              output += `  ✗ Verification failed: ${e.message}\n`;
              if (step.rollback) {
                output += `  Rolling back...\n`;
                try {
                  execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
                  output += `  ✓ Rollback successful\n`;
                } catch (re) {
                  output += `  ✗ Rollback failed: ${re.message}\n`;
                }
              }
              data.instances[instanceId].status = "failed";
              transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "failed", {
                reason: "runbook verification failed",
                result_status: "failure",
                error_category: evolveCommon.errorCategory(e.message),
                result_summary: output,
              });
              saveRunbooks(data);
              releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
              return { content: [{ type: "text", text: output }], isError: true };
            }
          }
          data.instances[instanceId].results.push({ step: i, success: true });
        } catch (e) {
          output += `  ✗ Failed: ${e.message}\n`;
          if (step.rollback) {
            output += `  Rolling back...\n`;
            try {
              execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
              output += `  ✓ Rollback successful\n`;
            } catch (re) {
              output += `  ✗ Rollback failed: ${re.message}\n`;
            }
          }
          data.instances[instanceId].status = "failed";
          data.instances[instanceId].currentStep = i;
          transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "failed", {
            reason: "runbook step failed",
            result_status: "failure",
            error_category: evolveCommon.errorCategory(e.message),
            result_summary: output,
          });
          saveRunbooks(data);
          releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
          return { content: [{ type: "text", text: output }], isError: true };
        }
      }
      data.instances[instanceId].status = "completed";
      transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "completed", {
        reason: "runbook completed",
        result_status: "success",
        result_summary: output,
      });
      saveRunbooks(data);
      releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
      output += `\n✓ Runbook completed successfully`;
      return { content: [{ type: "text", text: output }] };
    } else {
      const step = rb.steps[0];
      let output = `Starting guided runbook: ${rbId} (${rb.name})\n\n`;
      output += `Step 1/${rb.steps.length}: ${step.name}\n`;
      output += `Command: ${step.command}\n`;
      try {
        const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
        output += `Result: ${result.substring(0, 500)}\n`;
        data.instances[instanceId].results.push({ step: 0, success: true, output: result });
        if (rb.steps.length > 1) {
          output += `\nUse action="next" with runbook_id="${instanceId}" to continue`;
          transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "waiting", {
            reason: "guided runbook waiting for next step",
            result_status: "waiting",
            result_summary: output,
          });
        } else {
          data.instances[instanceId].status = "completed";
          transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "completed", {
            reason: "guided runbook completed",
            result_status: "success",
            result_summary: output,
          });
          output += `\n✓ Runbook completed`;
        }
      } catch (e) {
        output += `Failed: ${e.message}\n`;
        if (step.rollback) {
          output += `Use action="rollback" with runbook_id="${instanceId}" to rollback`;
        }
        data.instances[instanceId].status = "failed";
        transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "failed", {
          reason: "guided runbook step failed",
          result_status: "failure",
          error_category: evolveCommon.errorCategory(e.message),
          result_summary: output,
        });
      }
      saveRunbooks(data);
      releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
      return { content: [{ type: "text", text: output }] };
    }
  }

  if (action === "next") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (!instance.id) instance.id = runbook_id;
    if (instance.mode !== "guided") {
      return { content: [{ type: "text", text: "Instance is not in guided mode" }], isError: true };
    }
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }

    // Fenced claim (Phase 4/B): two concurrent `next` calls cannot both run
    // the step; a cancel request stops the instance before dispatch.
    let nextClaim = null;
    if (instance.platform_execution_id) {
      const nextClaimRes = platformKernel.claimExecution({ execution_id: instance.platform_execution_id, claimed_by: `runbook-next:${process.pid}`, lease_ms: RUNBOOK_CLAIM_LEASE_MS });
      if (!nextClaimRes.ok) {
        const detail = nextClaimRes.code === "claim_held" ? `a step is already in progress (${nextClaimRes.claimed_by})` : `cannot continue: execution ${nextClaimRes.code}`;
        return { content: [{ type: "text", text: `Runbook instance ${runbook_id}: ${detail}` }], isError: true };
      }
      nextClaim = nextClaimRes.claim;
      if (nextClaim.cancel_requested) {
        instance.status = "cancelled";
        transitionScheduledPlatformExecution("runbook", instance, "cancelled", { reason: "cancel requested before next step", result_status: "cancelled" });
        saveRunbooks(data);
        releaseScheduledClaim(instance.platform_execution_id, nextClaim);
        return { content: [{ type: "text", text: `Runbook instance ${runbook_id} cancelled before next step` }] };
      }
    }

    instance.currentStep++;
    transitionScheduledPlatformExecution("runbook", instance, "running", { reason: "guided runbook next step started" });
    if (instance.currentStep >= rb.steps.length) {
      instance.status = "completed";
      transitionScheduledPlatformExecution("runbook", instance, "completed", {
        reason: "guided runbook completed",
        result_status: "success",
        result_summary: "Runbook completed",
      });
      saveRunbooks(data);
      releaseScheduledClaim(instance.platform_execution_id, nextClaim);
      return { content: [{ type: "text", text: `✓ Runbook completed` }] };
    }

    const step = rb.steps[instance.currentStep];
    let output = `Step ${instance.currentStep + 1}/${rb.steps.length}: ${step.name}\n`;
    output += `Command: ${step.command}\n`;
    appendScheduledPlatformEvent("runbook", instance, "runbook.step_started", { step: instance.currentStep, name: step.name });
    try {
      const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
      output += `Result: ${result.substring(0, 500)}\n`;
      instance.results.push({ step: instance.currentStep, success: true, output: result });
      appendScheduledPlatformEvent("runbook", instance, "runbook.step_completed", { step: instance.currentStep, name: step.name });
      if (instance.currentStep < rb.steps.length - 1) {
        output += `\nUse action="next" to continue`;
        transitionScheduledPlatformExecution("runbook", instance, "waiting", {
          reason: "guided runbook waiting for next step",
          result_status: "waiting",
          result_summary: output,
        });
      } else {
        instance.status = "completed";
        transitionScheduledPlatformExecution("runbook", instance, "completed", {
          reason: "guided runbook completed",
          result_status: "success",
          result_summary: output,
        });
        output += `\n✓ Runbook completed`;
      }
    } catch (e) {
      output += `Failed: ${e.message}\n`;
      if (step.rollback) {
        output += `Use action="rollback" to rollback`;
      }
      instance.status = "failed";
      transitionScheduledPlatformExecution("runbook", instance, "failed", {
        reason: "guided runbook step failed",
        result_status: "failure",
        error_category: evolveCommon.errorCategory(e.message),
        result_summary: output,
      });
    }
    saveRunbooks(data);
    releaseScheduledClaim(instance.platform_execution_id, nextClaim);
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "verify") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (!instance.id) instance.id = runbook_id;
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }
    const step = rb.steps[instance.currentStep];
    if (!step.verify_command) {
      return { content: [{ type: "text", text: "No verification command for this step" }] };
    }
    try {
      const result = execSync(step.verify_command, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
      return { content: [{ type: "text", text: `✓ Verification passed\n\n${result}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `✗ Verification failed\n\n${e.message}` }], isError: true };
    }
  }

  if (action === "rollback") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (!instance.id) instance.id = runbook_id;
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }

    let output = `Rolling back runbook: ${runbook_id}\n\n`;
    transitionScheduledPlatformExecution("runbook", instance, "rolling_back", { reason: "runbook rollback started" });
    for (let i = instance.currentStep; i >= 0; i--) {
      const step = rb.steps[i];
      if (step.rollback) {
        output += `Step ${i + 1}: ${step.name}\n`;
        try {
          execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
          output += `  ✓ Rollback successful\n`;
        } catch (e) {
          output += `  ✗ Rollback failed: ${e.message}\n`;
        }
      }
    }
    instance.status = "rolled_back";
    transitionScheduledPlatformExecution("runbook", instance, "rolled_back", {
      reason: "runbook rollback completed",
      result_status: "rolled_back",
      result_summary: output,
    });
    saveRunbooks(data);
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "abort") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (!instance.id) instance.id = runbook_id;
    instance.status = "aborted";
    transitionScheduledPlatformExecution("runbook", instance, "cancelled", {
      reason: "runbook aborted",
      result_status: "aborted",
      result_summary: `Aborted runbook: ${runbook_id}`,
    });
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Aborted runbook: ${runbook_id}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: create, start, next, verify, rollback, abort, list, get, delete" }], isError: true };
}

// --- Metrics Tool ---

const TOOLS = {
  tools: sidekick_tools,
  resume: sidekick_resume,
  cron: sidekick_cron,
  github: sidekick_github,
  ci_status: sidekick_ci_status,
  teach: sidekick_teach,
  delay: sidekick_delay,
  watch: sidekick_watch,
  secret: sidekick_secret,
  queue: sidekick_queue,
  retry: sidekick_retry,
  evolve: sidekick_evolve,
  orchestrate: sidekick_orchestrate,
  batch: sidekick_batch,
  project: sidekick_project,
  circuit: sidekick_circuit,
  runbook: sidekick_runbook,
  mission: sidekick_mission,
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
  { name: "llm", description: "Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq)", args: { prompt: "string", system: "string (optional)", temperature: "number (optional)", provider: "string (optional, 'ollama' or 'groq' - default from SIDEKICK_DEFAULT_LLM env var or 'ollama')" } },
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
  { name: "embed", description: "Generate text embeddings using Ollama", args: { text: "string (text to embed)", model: "string (optional, embedding model - default nomic-embed-text)" } },
  { name: "ollama", description: "Manage Ollama models: list, ps, pull, show", args: { action: "string (list|ps|pull|show)", model: "string (optional, model name for pull/show)" } },
  { name: "tunnel", description: "Manage Cloudflare tunnels: start, stop, list", args: { action: "string (start|stop|list)", port: "number (local port to expose)", name: "string (optional, tunnel name)" } },
  { name: "download", description: "Download videos/audio from YouTube and 1000+ sites using yt-dlp", args: { url: "string (video URL)", output: "string (optional, output path)", format: "string (optional, video format)", audio_only: "boolean (optional, extract audio only)" } },
  { name: "wireguard", description: "Manage WireGuard VPN: status, list_peers, add_peer, remove_peer, generate_keypair", args: { action: "string (status|list_peers|add_peer|remove_peer|generate_keypair)", interface_name: "string (WireGuard interface, e.g. wg0)", peer_name: "string (peer name for add_peer)", public_key: "string (peer public key)", endpoint: "string (optional, peer endpoint IP:port)", allowed_ips: "string (optional, allowed IPs, default 10.0.0.0/24)" } },
  { name: "nginx", description: "Manage Nginx reverse proxy: status, list_sites, add_site, remove_site, test_config, reload", args: { action: "string (status|list_sites|add_site|remove_site|test_config|reload)", site_name: "string (site config name)", domain: "string (domain name for add_site)", upstream_port: "number (local port to proxy to)", ssl_email: "string (optional, email for Let's Encrypt)" } },
  { name: "knowledge", description: "Knowledge base management: search, get, list, add, update, soft-delete, and purge disabled entries", args: { action: "string (search|get|list|add|update|delete|purge)", id: "number (optional, entry ID for get/update/delete/purge)", category: "string (optional, category for list/add/update)", title: "string (optional, title for add/update)", content: "string (optional, content for add/update)", tags: "string (optional, comma-separated tags for add/update)", query: "string (optional, search query for search)", limit: "number (optional, max results for search/list)" } },
  { name: "metrics", description: "Metrics collection and querying with InfluxDB: write metrics, query data, list measurements and fields", args: { action: "string (write|query|list_measurements|list_fields)", measurement: "string (measurement name for write/list_fields)", fields: "object (field values for write)", tags: "object (optional, tags for write)", timestamp: "number (optional, nanosecond timestamp for write)", query: "string (Flux query for query action)", time_range: "string (optional, time range for list_fields, e.g. -30d)" } },
  { name: "compute", description: "Sidekick Compute: provider-neutral inference and compute system. List providers, check health, get system overview.", args: { action: "string (overview|init)" } },
  { name: "compute_nodes", description: "Manage compute worker nodes and enrollment tokens: list, get, heartbeat, revoke, maintenance mode, stats, create/list tokens, enroll", args: { action: "string (list|get|heartbeat|revoke|maintenance|stats|create_token|list_tokens|enroll)", node_id: "string (worker node ID for get/heartbeat/revoke/maintenance/enroll)", token: "string (enrollment token for enroll)", display_name: "string (worker or token display name)", platform: "string (worker platform for enroll)", architecture: "string (optional, worker architecture)", reason: "string (optional, revoke reason)", enable: "boolean (optional, enable/disable maintenance)", state: "string (optional, filter by worker state for list)", hardware_type: "string (optional, filter by hardware_type for list)", provider: "string (optional, filter by provider for list)" } },
  { name: "compute_providers", description: "Manage compute providers (Ollama, OpenAI, vLLM, etc.): list, get, create, update, delete, health check", args: { action: "string (list|get|create|update|delete|health|health_all)", provider_id: "string (provider ID for get/update/delete/health)", name: "string (display name; required for create)", type: "string (provider type; required for create: ollama|openai|vllm|llamacpp|mlx|mock; filters list)", base_url: "string (base URL for create/update)", api_key: "string (optional, recorded but NOT used to authenticate — no adapter reads it; do not paste a live credential)", priority: "number (optional, placement priority; HIGHER wins, default 50)", enabled: "boolean (optional, enable/disable; filters list)", trust_level: "string (optional placement gate: untrusted|limited|trusted|privileged; registry default 'private' ranks equal to trusted)", capabilities: "string[] (optional, descriptive only — placement gates on MODEL capabilities)", mode: "string (optional, direct|worker, default direct)", tls_policy: "string (optional, require|prefer|off, default prefer)", cost_policy: "string (optional, default free)", data_classifications: "string[] (optional placement gate: public|internal|private|sensitive|restricted; default public/internal/private)" } },
  { name: "compute_models", description: "Manage compute models: list, get, create, update, delete, discover from providers. Note: discover only LISTS what a provider currently serves — it does not register anything; use create to add a model to the registry", args: { action: "string (list|get|create|update|delete|discover)", model_id: "string (model ID for get/update/delete)", provider_id: "string (required for create; filters list)", model_name: "string (display name; required for create)", provider_model_name: "string (name on the provider, e.g. qwen3.5:latest; required for create)", family: "string (optional, stored as metadata)", parameter_count: "string (optional, e.g. 7b, 13b, 70b; stored as metadata)", context_length: "number (optional, context window size)", supports_vision: "boolean (optional; filters list)", supports_tools: "boolean (optional)", supports_embedding: "boolean (optional; filters list)", supports_structured_output: "boolean (optional)", min_vram_gb: "number (optional, minimum VRAM in GB)", capabilities: "string[] (optional, e.g. chat, generate, embeddings; placement gates on these — a model advertising none cannot be selected)", capability: "string (optional, filter list by one capability)", preferred_workloads: "string[] (optional)", quantization: "string (optional, e.g. Q4_K_M)", enabled: "boolean (optional; filters list)" } },
  { name: "compute_jobs", description: "Manage allowlisted compute jobs: list, get, create, cancel, view stats and artifacts", args: { action: "string (list|get|create|cancel|stats|artifacts)", job_id: "string (job ID for get/cancel/artifacts)", job_type: "string (canonical job type for create: chat|generate|embeddings|text_embedding)", capability: "string (optional, requested capability for create, preserved exactly, e.g. openvino.text_embedding)", request_payload: "object (optional, structured executor request payload for create; validated by the job contract and executor rules)", capability_requirements: "object (optional, capability requirements for create, e.g. { executor, model })", data_classification: "string (optional, public|internal|private for create; preserved when supplied)", prompt: "string (optional, create convenience mapped to request_payload.prompt)", model: "string (optional, create convenience mapped to request_payload.model)", provider: "string (optional, create convenience mapped to request_payload.provider)", timeout_ms: "number (optional, job timeout ms for create)", max_retries: "number (optional, retries after first attempt for create)", idempotency_key: "string (optional, idempotency key for create)", reason: "string (optional, cancellation reason for cancel)", status: "string (optional, filter by status for list)", limit: "number (optional, max results for list)", project: "string (optional, create metadata or list filter)", provider_id: "string (optional, filter by provider for list)", worker_id: "string (optional, filter by worker for list)" } },
  { name: "compute_route", description: "Explain routing decisions and manage routing rules for allowlisted compute workloads", args: { action: "string (explain|list_rules|create_rule|delete_rule)", workload_class: "string (chat|generate|embeddings for explain)", capabilities_required: "string (comma-separated capabilities for explain)", data_classification: "string (public|internal|private for explain)", trust_level: "string (untrusted|community|known|trusted|internal for explain)", rule_id: "string (routing rule ID for delete_rule)", rule_name: "string (rule name for create_rule)", priority: "number (rule priority for create_rule, lower=higher)", description: "string (optional, rule description for create_rule)", preferred_providers: "array (preferred provider IDs for create_rule)", preferred_models: "array (preferred model IDs for create_rule)", fallback_providers: "array (optional, fallback provider IDs for create_rule)", max_latency_ms: "number (optional, max latency requirement for create_rule)" } },
  { name: "module", description: "Inspect and operate platform module lifecycle state through the shared policy and approval path", args: { action: "string (list|get|health|check|recover|enable|disable - default list)", name: "string (module name for get/health/check/recover/enable/disable)" } },
];

async function callTool(name, args, options = {}) {
  return require("./tools/dispatcher").dispatchTool({ name, args, context: options });
}

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
