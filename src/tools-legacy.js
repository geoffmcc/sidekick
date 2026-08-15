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

const { createSourceCompat } = require("./tools/source-compat");
const { setSource, getCurrentSource } = createSourceCompat({ toolContext });

// Canonical names of every built-in tool, including those whose handlers have
// moved to descriptor-owned families under src/tools/families/. Built lazily
// because TOOL_DEFS is declared later in this module, and memoized because
// TOOL_DEFS is immutable for the process lifetime. If built-in tools ever
// become dynamically registerable, this memo must be invalidated.

const { createRiskCompat } = require("./tools/risk-compat");
const { getToolRisk, resolveActionRisk, RISK_ORDER } = createRiskCompat({
  dbStore,
  TOOL_RISK,
  TOOL_ACTION_RISK,
  RISK_LEVELS,
});

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

const { createRegistrySyncCompat } = require("./tools/registry-sync-compat");
const { syncToolRegistry } = createRegistrySyncCompat({
  dbStore,
  TOOL_DEFS,
  TOOL_RISK,
  TOOL_CATEGORIES,
});

const { createLoggingCompat } = require("./tools/logging-compat");
const {
  logToolCall,
  recordPlatformToolCall,
} = createLoggingCompat({
  evolveCommon,
  dbStore,
  getCurrentSource,
  recordToolCallMemory,
  platformKernel,
  getToolRisk,
  formatArgs,
});

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
