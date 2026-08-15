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

const { createPolicyCompat } = require("./tools/policy-compat");
const {
  getPolicyEntries,
  findPolicyListMatch,
  getApprovalMode,
  getApprovalEntries,
  getApprovalDecision,
  getToolPolicyDecision,
  enforceToolPolicy,
} = createPolicyCompat({
  parsePolicyList,
  sourceEnvName,
  getToolRisk,
  getCurrentSource,
});

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



const { createApprovalCompat } = require("./tools/approval-compat");
const {
  loadApprovals,
  saveApprovals,
  generateApprovalId,
  approvalPreviewArgs,
  withholdSecretToolValue,
  getApprovalTtlSeconds,
  getApprovalLeaseSeconds,
  generateOperationId,
  generateExecutorId,
  leaseExpiresAt,
  isLeaseExpired,
  approvalNeedsManualReconciliation,
  discardApprovalPayload,
  supersedeLegacyApprovalForTask,
  markApprovalReconciliationRequired,
  recordApprovalRecoveryEvent,
  expireApprovals,
  encryptApprovalArgs,
  decryptApprovalArgs,
  queueApproval,
  publicApproval,
  listContinuationApprovals,
  renderContinuationApprovalPreview,
  listApprovals,
  resolveApproval,
  claimApprovalExecution,
  renewApprovalLease,
  recoverStaleApprovals,
  finalizeApprovalExecution,
} = createApprovalCompat({
  dbStore,
  encryptSecret,
  decryptSecret,
  getToolPolicyDecision,
  getToolRisk,
  getCurrentSource,
  callTool,
  generateId,
  recordPlatformApprovalQueued,
  transitionPlatformApproval,
  recordPlatformApprovalEvent,
  recordPlatformChangeSet,
});

const { TOOL_DEFS } = require("./tools/legacy-catalog");
const { createRegistryCompat } = require("./tools/registry-compat");
const {
  getToolDefsForSource,
  getToolCategoriesWithTools,
  formatArgs,
} = createRegistryCompat({
  dbStore,
  TOOL_DEFS,
  TOOL_CATEGORIES,
  getToolPolicyDecision,
  getApprovalDecision,
  getCurrentSource,
});

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
