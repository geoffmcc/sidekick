const fs = require("fs");
const path = require("path");
const dns = require("dns");
const https = require("https");
const { execSync, execFile, execFileSync, spawn } = require("child_process");
const { redactSensitive } = require("./redact");
const dbStore = require("./db");
const pgStore = require("./pg");
const redisStore = require("./redis");
const qdrantStore = require("./qdrant");
const { recordToolCallMemory } = require("./memory");
const { scanSecurityConfig } = require("./security-scan");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

fs.mkdirSync(DATA_DIR, { recursive: true });

const LOG_FILE = path.join(DATA_DIR, "log.jsonl");
const CRON_FILE = path.join(DATA_DIR, "cron.json");
const WEBHOOK_FILE = path.join(DATA_DIR, "webhooks.json");
const CONTEXT_FILE = path.join(DATA_DIR, "context.json");
const PROCEDURES_FILE = path.join(DATA_DIR, "procedures.json");
const MAX_LOG = 1000;

const PROJECT_RE = /^[a-z][a-z0-9_]*$/;

const SHELL_META = /[`$\\!#&|;()*?<>[\]{}"'\n\r]/;
function shellEscape(arg) {
  if (arg === "") return "''";
  if (!SHELL_META.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

let currentSource = "unknown";

function setSource(source) {
  currentSource = source;
}

const RISK_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

const TOOL_RISK = {
  sidekick_bash: "critical",
  sidekick_write: "critical",
  sidekick_db_restore: "critical",
  sidekick_runbook: "critical",
  sidekick_ops: "critical",
  sidekick_mission: "critical",
  sidekick_sandbox: "critical",
  sidekick_evolve: "critical",
  sidekick_process: "high",
  sidekick_service: "high",
  sidekick_cron: "high",
  sidekick_delay: "high",
  sidekick_watch: "high",
  sidekick_github: "high",
  sidekick_ci_status: "low",
  sidekick_teach: "high",
  sidekick_secret: "high",
  sidekick_security_scan: "low",
  sidekick_db_migrate: "high",
  sidekick_queue: "high",
  sidekick_orchestrate: "high",
  sidekick_notify: "medium",
  sidekick_read: "medium",
  sidekick_archive: "medium",
  sidekick_git: "medium",
  sidekick_web_fetch: "medium",
  sidekick_llm: "medium",
  sidekick_context: "medium",
  sidekick_memory_export: "low",
  sidekick_memory_import: "medium",
  sidekick_memory_manage: "medium",
  sidekick_sync_identity: "low",
  sidekick_sync_export: "low",
  sidekick_sync_import: "medium",
  sidekick_sync_diff: "low",
  sidekick_health: "medium",
  sidekick_snapshot: "medium",
  sidekick_retry: "medium",
  sidekick_fresheyes: "medium",
  sidekick_batch: "medium",
  sidekick_tail: "medium",
  sidekick_find: "medium",
  sidekick_status: "medium",
  sidekick_extract: "medium",
  sidekick_changelog: "medium",
  sidekick_netdiag: "medium",
  sidekick_timeline: "medium",
  sidekick_circuit: "medium",
  sidekick_baseline: "medium",
  sidekick_depend: "medium",
  sidekick_black_box: "medium",
  sidekick_db_query: "medium",
  sidekick_db_backup: "medium",
  sidekick_db_export: "medium",
  sidekick_redis: "medium",
  sidekick_ocr: "low",
  sidekick_media: "low",
  sidekick_transcribe: "low",
  sidekick_analytics: "low",
  sidekick_insight_report: "low",
  sidekick_embed: "low",
  sidekick_ollama: "low",
  sidekick_tunnel: "medium",
  sidekick_download: "low",
  sidekick_wireguard: "high",
  sidekick_nginx: "high",
  sidekick_tools: "low",
  sidekick_knowledge: "low",
  sidekick_delete: "low",
  sidekick_resume: "low",
  sidekick_metrics: "low",
};

// Tool categories - maps tool names to their category
const TOOL_CATEGORIES = {
  'sidekick_bash': 'Core',
  'sidekick_tools': 'Core',
  'sidekick_read': 'Core',
  'sidekick_write': 'Core',
  'sidekick_list': 'Core',
  'sidekick_search': 'Core',
  'sidekick_web_fetch': 'Core',
  'sidekick_llm': 'Core',
  'sidekick_respond': 'Core',
  'sidekick_store': 'Storage',
  'sidekick_get': 'Storage',
  'sidekick_delete': 'Storage',
  'sidekick_resume': 'Storage',
  'sidekick_list_projects': 'Storage',
  'sidekick_get_by_project': 'Storage',
  'sidekick_redis': 'Storage',
  'sidekick_db_schema': 'Database',
  'sidekick_db_query': 'Database',
  'sidekick_db_stats': 'Database',
  'sidekick_db_backup': 'Database',
  'sidekick_db_restore': 'Database',
  'sidekick_db_export': 'Database',
  'sidekick_db_search': 'Database',
  'sidekick_db_migrate': 'Database',
  'sidekick_db_diff': 'Database',
  'sidekick_analytics': 'Database',
  'sidekick_insight_report': 'Data Pipeline',
  'sidekick_git': 'Git & GitHub',
  'sidekick_github': 'Git & GitHub',
  'sidekick_ci_status': 'Git & GitHub',
  'sidekick_process': 'Services',
  'sidekick_service': 'Services',
  'sidekick_cron': 'Scheduling',
  'sidekick_delay': 'Scheduling',
  'sidekick_notify': 'Communication',
  'sidekick_webhook': 'Communication',
  'sidekick_context': 'Context & Learning',
  'sidekick_teach': 'Context & Learning',
  'sidekick_embed': 'Context & Learning',
  'sidekick_ollama': 'Context & Learning',
  'sidekick_memory_export': 'Context & Learning',
  'sidekick_memory_import': 'Context & Learning',
  'sidekick_memory_manage': 'Context & Learning',
  'sidekick_sync_identity': 'Context & Learning',
  'sidekick_sync_export': 'Context & Learning',
  'sidekick_sync_import': 'Context & Learning',
  'sidekick_sync_diff': 'Context & Learning',
  'sidekick_transform': 'Data Pipeline',
  'sidekick_parse': 'Data Pipeline',
  'sidekick_diff': 'Data Pipeline',
  'sidekick_hash': 'Data Pipeline',
  'sidekick_validate': 'Data Pipeline',
  'sidekick_template': 'Data Pipeline',
  'sidekick_extract': 'Data Pipeline',
  'sidekick_anonymize': 'Data Pipeline',
  'sidekick_diff_files': 'Data Pipeline',
  'sidekick_health': 'Monitoring',
  'sidekick_status': 'Monitoring',
  'sidekick_watch': 'Monitoring',
  'sidekick_baseline': 'Monitoring',
  'sidekick_snapshot': 'Monitoring',
  'sidekick_timeline': 'Monitoring',
  'sidekick_black_box': 'Monitoring',
  'sidekick_netdiag': 'Monitoring',
  'sidekick_queue': 'Workflow',
  'sidekick_retry': 'Workflow',
  'sidekick_orchestrate': 'Workflow',
  'sidekick_runbook': 'Workflow',
  'sidekick_ops': 'Workflow',
  'sidekick_mission': 'Workflow',
  'sidekick_evolve': 'Meta',
  'sidekick_predict': 'Meta',
  'sidekick_debug_tool': 'Meta',
  'sidekick_fresheyes': 'Meta',
  'sidekick_batch': 'Efficiency',
  'sidekick_cache': 'Efficiency',
  'sidekick_summarize': 'Efficiency',
  'sidekick_filter': 'Efficiency',
  'sidekick_project': 'Efficiency',
  'sidekick_tail': 'Efficiency',
  'sidekick_find': 'Efficiency',
  'sidekick_secret': 'Security',
  'sidekick_security_scan': 'Security',
  'sidekick_sandbox': 'Security',
  'sidekick_tunnel': 'Networking',
  'sidekick_wireguard': 'Networking',
  'sidekick_nginx': 'Networking',
  'sidekick_changelog': 'Development',
  'sidekick_depend': 'Development',
  'sidekick_circuit': 'Reliability',
  'sidekick_archive': 'Archive',
  'sidekick_ocr': 'Media',
  'sidekick_media': 'Media',
  'sidekick_transcribe': 'Media',
  'sidekick_download': 'Media',
  'sidekick_knowledge': 'Context & Learning',
  'sidekick_metrics': 'Monitoring',
};

function getToolRisk(name) {
  return TOOL_RISK[name] || "low";
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
    
    // Get all current tools from code
    const codeTools = new Set(TOOL_DEFS.map(t => t.name));
    
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
    
    // Insert/update each tool
    for (const toolDef of TOOL_DEFS) {
      const risk = TOOL_RISK[toolDef.name] || "low";
      const argsJson = JSON.stringify(toolDef.args || {});
      
      upsertTool.run(
        toolDef.name,
        toolDef.description,
        argsJson,
        risk,
        now
      );
      
      // Get the tool's category
      const categoryName = TOOL_CATEGORIES[toolDef.name];
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
    
    console.log(`[ToolRegistry] Synced ${TOOL_DEFS.length} tools to database`);
  } catch (error) {
    console.error('[ToolRegistry] Error syncing tool registry:', error.message);
  }
}

function parsePolicyList(value) {
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function sourceEnvName(source, suffix) {
  return "SIDEKICK_" + String(source || "unknown").toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_" + suffix;
}

function getPolicyEntries(source, suffixes) {
  const entries = [];
  for (const suffix of suffixes) {
    entries.push(...parsePolicyList(process.env["SIDEKICK_" + suffix]));
    entries.push(...parsePolicyList(process.env[sourceEnvName(source, suffix)]));
  }
  return entries;
}

function policyListMatches(entries, toolName, risk) {
  return Boolean(findPolicyListMatch(entries, toolName, risk));
}

function findPolicyListMatch(entries, toolName, risk) {
  return entries.find(entry => {
    const normalized = entry.toLowerCase();
    return normalized === toolName.toLowerCase() || normalized === ("risk:" + risk);
  });
}

function getApprovalMode(source = currentSource) {
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

function getApprovalDecision(toolName, source = currentSource) {
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

function getToolPolicyDecision(toolName, source = currentSource) {
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

function enforceToolPolicy(toolName, source = currentSource) {
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

function getApprovalTtlSeconds() {
  const configured = parseInt(process.env.SIDEKICK_APPROVAL_TTL_SECONDS || "3600", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 3600;
}

function discardApprovalPayload(item) {
  delete item.args;
  delete item.args_encrypted;
  item.payload_discarded_at = new Date().toISOString();
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
    discardApprovalPayload(item);
    changed = true;
  }
  return changed;
}

function encryptApprovalArgs(args) {
  return encryptSecret(JSON.stringify(args || {}));
}

function decryptApprovalArgs(item) {
  if (item.args_encrypted) {
    return JSON.parse(decryptSecret(item.args_encrypted));
  }
  // Backward compatibility for approvals queued before encrypted payloads.
  if (Object.prototype.hasOwnProperty.call(item, "args")) return item.args || {};
  throw new Error("Approval payload is missing");
}

function queueApproval(toolName, args, decision) {
  const approvals = loadApprovals();
  const now = new Date().toISOString();
  expireApprovals(approvals);
  const item = {
    id: generateApprovalId(),
    status: "pending",
    tool: toolName,
    risk: decision.risk,
    source: decision.source,
    mode: decision.mode,
    reason: decision.reason,
    args_encrypted: encryptApprovalArgs(args),
    args_preview: approvalPreviewArgs(args),
    requested_at: now,
    updated_at: now,
    expires_at: new Date(Date.parse(now) + (getApprovalTtlSeconds() * 1000)).toISOString()
  };
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

function listApprovals({ status, limit } = {}) {
  const max = Math.min(parseInt(limit || "100", 10) || 100, 500);
  const approvals = loadApprovals();
  if (expireApprovals(approvals)) saveApprovals(approvals);
  return approvals
    .filter(item => !status || item.status === status)
    .slice(0, max)
    .map(publicApproval);
}

async function resolveApproval(id, action, reviewer = "dashboard") {
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
    discardApprovalPayload(item);
    saveApprovals(approvals);
    return { content: [{ type: "text", text: "Rejected approval: " + id }] };
  }

  if (action !== "approve") {
    return { content: [{ type: "text", text: "Invalid approval action: " + action }], isError: true };
  }

  let approvalArgs;
  try {
    approvalArgs = decryptApprovalArgs(item);
  } catch (e) {
    item.status = "failed";
    item.error = "Approval payload could not be decrypted";
    item.completed_at = new Date().toISOString();
    item.updated_at = item.completed_at;
    discardApprovalPayload(item);
    saveApprovals(approvals);
    return { content: [{ type: "text", text: item.error + ": " + e.message }], isError: true };
  }

  const now = new Date().toISOString();
  item.reviewed_at = now;
  item.updated_at = now;
  item.reviewed_by = reviewer;
  item.status = "running";
  saveApprovals(approvals);

  const previousSource = currentSource;
  currentSource = item.source || "unknown";
  try {
    const result = await callTool(item.tool, approvalArgs, { bypassApproval: true, approvalId: id });
    const latest = loadApprovals();
    const updated = latest.find(a => a.id === id);
    if (updated) {
      updated.status = result.isError ? "failed" : "approved";
      updated.result_preview = redactSensitive(result.content?.[0]?.text || "").substring(0, 1000);
      updated.completed_at = new Date().toISOString();
      updated.updated_at = updated.completed_at;
      discardApprovalPayload(updated);
      saveApprovals(latest);
    }
    return result;
  } catch (e) {
    const latest = loadApprovals();
    const updated = latest.find(a => a.id === id);
    if (updated) {
      updated.status = "failed";
      updated.error = e.message;
      updated.completed_at = new Date().toISOString();
      updated.updated_at = updated.completed_at;
      discardApprovalPayload(updated);
      saveApprovals(latest);
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  } finally {
    currentSource = previousSource;
  }
}

function getToolDefsForSource(source = currentSource) {
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
function getToolCategoriesWithTools(source = currentSource) {
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

function getToolRecordsForSource(source = currentSource) {
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
  let records = getToolRecordsForSource(currentSource);

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

function logToolCall(name, args, duration, success, summary) {
  try {
    const redactedSummary = redactSensitive(String(summary).substring(0, 200));
    dbStore.appendToolLog({
      t: new Date().toISOString(),
      n: name,
      a: formatArgs(args),
      d: Math.round(duration),
      ok: success,
      s: redactedSummary,
      src: currentSource
    });
    recordToolCallMemory({
      name,
      args,
      duration,
      success,
      summary: redactedSummary,
      source: currentSource
    });
  } catch (e) {}
}

const DANGEROUS_PATTERNS = [
  /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|$|[/*])/i,
  /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+\/(?:var|etc|home|usr|bin|sbin|lib|lib64|boot|root)(?:\s|$|\/)/i,
  /\s*>\s*\/dev\/(sd|nvme|vd|xvd)[a-z0-9]*/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\b(fdisk|parted)\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /:\(\)\{/,
  /\b(curl|wget)\b\s+.*\|\s*(?:sudo\s+)?(?:bash|sh)\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

function isDangerous(cmd) {
  return DANGEROUS_PATTERNS.some(p => p.test(cmd));
}

function normalizePolicyPath(filePath) {
  return path.resolve(String(filePath || ""));
}

function pathPolicyEntries(source, suffix) {
  return [
    ...parsePolicyList(process.env["SIDEKICK_" + suffix]),
    ...parsePolicyList(process.env[sourceEnvName(source, suffix)])
  ];
}

function pathMatchesPolicyEntry(filePath, entry) {
  const normalizedPath = normalizePolicyPath(filePath);
  const normalizedEntry = normalizePolicyPath(entry);
  const relative = path.relative(normalizedEntry, normalizedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findPathPolicyMatch(entries, filePath) {
  return entries.find(entry => pathMatchesPolicyEntry(filePath, entry));
}

function getPathPolicyDecision(filePath, operation = "access", source = currentSource) {
  const target = normalizePolicyPath(filePath);
  const allowedEntries = pathPolicyEntries(source, "ALLOWED_PATHS");
  const deniedEntries = pathPolicyEntries(source, "DENIED_PATHS");
  const deniedMatch = findPathPolicyMatch(deniedEntries, target);

  if (deniedMatch) {
    return { allowed: false, source, operation, path: target, reason: "path denied by policy", matched: deniedMatch, list: "denied" };
  }

  if (allowedEntries.length > 0) {
    const allowedMatch = findPathPolicyMatch(allowedEntries, target);
    return {
      allowed: Boolean(allowedMatch),
      source,
      operation,
      path: target,
      reason: allowedMatch ? "path allowed by policy" : "path not in allowed paths",
      matched: allowedMatch || null,
      list: "allowed"
    };
  }

  return { allowed: true, source, operation, path: target, reason: "path policy is open" };
}

function enforcePathPolicy(filePath, operation = "access") {
  const decision = getPathPolicyDecision(filePath, operation);
  if (decision.allowed) return null;
  return {
    content: [{
      type: "text",
      text: `Path blocked by policy: ${decision.path} (source=${decision.source}, operation=${decision.operation}). ${decision.reason}.`
    }],
    isError: true
  };
}

async function sidekick_bash({ command }) {
  if (isDangerous(command)) {
    return { content: [{ type: "text", text: "Blocked: command matches a dangerous pattern" }], isError: true };
  }
  try {
    const stdout = execSync(command, { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Exit code: " + e.status + "\nstdout: " + (e.stdout || "") + "\nstderr: " + (e.stderr || "")) }], isError: true };
  }
}

async function sidekick_read({ path: filePath }) {
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return { content: [{ type: "text", text: redactSensitive(content) }] };
}

async function sidekick_write({ path: filePath, content }) {
  const policyError = enforcePathPolicy(filePath, "write");
  if (policyError) return policyError;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  const stat = fs.statSync(filePath);
  return { content: [{ type: "text", text: "Written " + stat.size + " bytes to " + filePath }] };
}

async function sidekick_store({ key, value, project, category }) {
  if (project !== undefined && project !== null && !PROJECT_RE.test(project)) {
    return { content: [{ type: "text", text: "Invalid project name. Must match /^[a-z][a-z0-9_]*$/" }], isError: true };
  }
  
  const existing = dbStore.getKV(key);
  dbStore.setKV(key, value, project !== undefined ? project : (existing?.project || null), currentSource, category !== undefined ? category : (existing?.category || null));
  
  return { content: [{ type: "text", text: "Stored key \"" + key + "\" (" + value.length + " chars)" }] };
}

async function sidekick_get({ key }) {
  const entry = dbStore.getKV(key);
  if (!entry) {
    return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
  }
  const value = (typeof entry === 'object' && entry !== null && 'value' in entry) ? entry.value : entry;
  return { content: [{ type: "text", text: redactSensitive(value) }] };
}

async function sidekick_delete({ key }) {
  const existing = dbStore.getKV(key);
  if (!existing) {
    return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
  }
  dbStore.deleteKV(key);
  return { content: [{ type: "text", text: "Deleted key \"" + key + "\"" }] };
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

async function sidekick_list_projects() {
  const projects = dbStore.listKVProjects();
  return { content: [{ type: "text", text: JSON.stringify(projects) }] };
}

async function sidekick_get_by_project({ project }) {
  const allKV = dbStore.getAllKV();
  const results = [];
  for (const [key, entry] of Object.entries(allKV)) {
    if (typeof entry === 'object' && entry !== null && 'project' in entry) {
      if (entry.project === project) {
        results.push({ key, value: entry.value });
      }
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results) }] };
}

async function sidekick_list({ path: dirPath }) {
  const policyError = enforcePathPolicy(dirPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(dirPath)) {
    return { content: [{ type: "text", text: "Path not found: " + dirPath }], isError: true };
  }
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines = items.map(i => {
    const type = i.isDirectory() ? "DIR" : i.isFile() ? "FILE" : "OTHER";
    let stat = null;
    try { stat = fs.statSync(path.join(dirPath, i.name)); } catch (e) {}
    const size = stat ? stat.size : 0;
    const date = stat ? stat.mtime.toISOString().slice(0, 19).replace("T", " ") : "";
    return type.padEnd(5) + " " + String(size).padStart(10) + " " + date + " " + i.name;
  });
  return { content: [{ type: "text", text: redactSensitive(lines.join("\n") || "(empty directory)") }] };
}

async function sidekick_web_fetch({ url: targetUrl, method, headers, body }) {
  const https = require("https");
  const http = require("http");
  return new Promise((resolve) => {
    const urlObj = new URL(targetUrl);
    const lib = urlObj.protocol === "https:" ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method || "GET",
      headers: { "User-Agent": "Sidekick-MCP/1.0" },
      timeout: 30000
    };
    if (headers) {
      try { Object.assign(options.headers, JSON.parse(headers)); } catch (e) {}
    }
    if (body) {
      options.headers["Content-Type"] = options.headers["Content-Type"] || "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        resolve({ content: [{ type: "text", text: "Status: " + res.statusCode + "\n\n" + data }] });
      });
    });
    req.on("error", (err) => resolve({ content: [{ type: "text", text: "Error: " + err.message }], isError: true }));
    req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Request timed out" }], isError: true }); });
    if (body) req.write(body);
    req.end();
  });
}

async function sidekick_llm({ prompt, system, temperature, provider }) {
  const defaultProvider = process.env.SIDEKICK_DEFAULT_LLM || "ollama";
  const useGroq = (provider || defaultProvider) === "groq";
  
  if (useGroq && GROQ_API_KEY) {
    return callGroqLLM(prompt, system, temperature);
  }
  return callOllamaLLM(prompt, system, temperature);
}

function callOllamaLLM(prompt, system, temperature) {
  const http = require("http");
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: process.env.OLLAMA_MODEL || "qwen2.5-coder:7b",
      prompt: prompt,
      system: system || "You are a helpful assistant running on a remote machine.",
      options: { temperature: temperature || 0.7 },
      stream: false
    });
    const req = http.request({
      hostname: "127.0.0.1", port: 11434,
      path: "/api/generate",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ content: [{ type: "text", text: parsed.response || JSON.stringify(parsed) }] });
        } catch (e) {
          resolve({ content: [{ type: "text", text: "Error parsing response: " + data.substring(0, 200) }], isError: true });
        }
      });
    });
    req.on("error", (err) => resolve({ content: [{ type: "text", text: "LLM error: " + err.message }], isError: true }));
    req.write(body);
    req.end();
  });
}

function callGroqLLM(prompt, system, temperature) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: system || "You are a helpful assistant running on a remote machine." },
        { role: "user", content: prompt }
      ],
      temperature: temperature || 0.7
    });
    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || JSON.stringify(parsed);
          resolve({ content: [{ type: "text", text: content }] });
        } catch (e) {
          resolve({ content: [{ type: "text", text: "Error parsing response: " + data.substring(0, 200) }], isError: true });
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); resolve({ content: [{ type: "text", text: "LLM timeout" }], isError: true }); });
    req.on("error", (err) => resolve({ content: [{ type: "text", text: "LLM error: " + err.message }], isError: true }));
    req.write(body);
    req.end();
  });
}

async function sidekick_search({ pattern, path: searchPath, include }) {
  const targetPath = searchPath || ".";
  const policyError = enforcePathPolicy(targetPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(targetPath)) {
    return { content: [{ type: "text", text: "Path not found: " + targetPath }], isError: true };
  }
  
  let useRg = false;
  try {
    execFileSync("which", ["rg"], { stdio: "ignore" });
    useRg = true;
  } catch (e) {}
  
  try {
    let stdout;
    if (useRg) {
      const args = ["--json", "--max-count", "100"];
      if (include) args.push("-g", include);
      args.push(pattern, targetPath);
      stdout = execFileSync("rg", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    } else {
      const args = ["-rn", "--max-count=100"];
      if (include) args.push("--include=" + include);
      args.push(pattern, targetPath);
      stdout = execFileSync("grep", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    }
    return { content: [{ type: "text", text: redactSensitive(stdout || "(no matches)") }] };
  } catch (e) {
    if (e.status === 1) {
      return { content: [{ type: "text", text: "No matches found" }] };
    }
    return { content: [{ type: "text", text: "Search error: " + (e.stderr || e.message) }], isError: true };
  }
}

async function sidekick_git({ action, path: repoPath, args: extraArgs }) {
  const repo = repoPath || ".";
  const allowedActions = ["status", "diff", "log", "add", "commit", "push", "pull", "branch", "checkout", "stash"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const writeActions = new Set(["add", "commit", "pull", "branch", "checkout", "stash"]);
  const policyError = enforcePathPolicy(repo, writeActions.has(action) ? "write" : "read");
  if (policyError) return policyError;
  if (!fs.existsSync(repo)) {
    return { content: [{ type: "text", text: "Repository path not found: " + repo }], isError: true };
  }
  
  const cmdArgs = ["-C", repo, action];
  if (extraArgs) {
    const parsed = extraArgs.split(/\s+/).filter(Boolean);
    cmdArgs.push(...parsed);
  }
  
  try {
    const stdout = execFileSync("git", cmdArgs, { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Exit code: " + e.status + "\n" + (e.stderr || e.stdout || "")) }], isError: true };
  }
}

async function sidekick_notify({ channel, webhook_url, recipient, message, title }) {
  const https = require("https");
  const http = require("http");
  
  if (channel === "discord" || channel === "slack") {
    // Fall back to environment variables if webhook_url not provided
    if (!webhook_url) {
      webhook_url = channel === "discord" ? process.env.DISCORD_WEBHOOK_URL : process.env.SLACK_WEBHOOK_URL;
    }
    if (!webhook_url) {
      return { content: [{ type: "text", text: "webhook_url required for " + channel + " (set DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL env var)" }], isError: true };
    }
    
    const payload = channel === "discord" 
      ? JSON.stringify({ content: title ? `**${title}**\n${message}` : message })
      : JSON.stringify({ text: title ? `*${title}*\n${message}` : message });
    
    return new Promise((resolve) => {
      const urlObj = new URL(webhook_url);
      const lib = urlObj.protocol === "https:" ? https : http;
      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 10000
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ content: [{ type: "text", text: "Sent to " + channel }] });
          } else {
            resolve({ content: [{ type: "text", text: "Failed: " + res.statusCode + " " + data }], isError: true });
          }
        });
      });
      req.on("error", (err) => resolve({ content: [{ type: "text", text: "Error: " + err.message }], isError: true }));
      req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Timeout" }], isError: true }); });
      req.write(payload);
      req.end();
    });
  }
  
  if (channel === "email") {
    if (!recipient) {
      return { content: [{ type: "text", text: "recipient required for email" }], isError: true };
    }
    
    const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
    const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
    const smtpUser = process.env.SMTP_USER || "";
    const smtpPass = process.env.SMTP_PASS || "";
    
    if (!smtpUser || !smtpPass) {
      return { content: [{ type: "text", text: "SMTP_USER and SMTP_PASS env vars required" }], isError: true };
    }
    
    const subject = title || "Sidekick Notification";
    const emailContent = `From: ${smtpUser}\nTo: ${recipient}\nSubject: ${subject}\n\n${message}`;
    
    return new Promise((resolve) => {
      const req = https.request({
        hostname: smtpHost,
        port: smtpPort,
        path: "/",
        method: "POST",
        auth: `${smtpUser}:${smtpPass}`,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(emailContent)
        },
        timeout: 30000
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          resolve({ content: [{ type: "text", text: "Email sent to " + recipient }] });
        });
      });
      req.on("error", (err) => resolve({ content: [{ type: "text", text: "Email error: " + err.message }], isError: true }));
      req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Email timeout" }], isError: true }); });
      req.write(emailContent);
      req.end();
    });
  }
  
  return { content: [{ type: "text", text: "Invalid channel. Use: discord, slack, or email" }], isError: true };
}

async function sidekick_process({ action, filter, pid, name, signal }) {
  const allowedActions = ["list", "top", "kill", "tree"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }
  
  let cmd;
  if (action === "list") {
    cmd = ["ps", ["aux"]];
  } else if (action === "top") {
    cmd = ["ps", ["aux", "--sort=-%cpu"]];
  } else if (action === "kill") {
    if (!pid && !name) {
      return { content: [{ type: "text", text: "pid or name required for kill" }], isError: true };
    }
    const sig = signal || "TERM";
    if (pid) {
      cmd = ["kill", ["-" + sig, String(pid)]];
    } else {
      cmd = ["pkill", ["-" + sig, name]];
    }
  } else if (action === "tree") {
    cmd = ["pstree", ["-p"]];
  }
  
  try {
    let stdout = execFileSync(cmd[0], cmd[1], { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    if (action === "list" && filter) {
      const needle = String(filter).toLowerCase();
      stdout = stdout.split("\n").filter(line => line.toLowerCase().includes(needle)).join("\n");
    } else if (action === "top") {
      stdout = stdout.split("\n").slice(0, 20).join("\n");
    }
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    if (action === "kill" && e.status === 0) {
      return { content: [{ type: "text", text: "Process killed" }] };
    }
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
  }
}

async function sidekick_service({ action, service, lines }) {
  const allowedActions = ["start", "stop", "restart", "status", "enable", "disable", "logs"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }
  
  let cmd;
  if (action === "logs") {
    if (!service) {
      return { content: [{ type: "text", text: "service required for logs" }], isError: true };
    }
    const n = lines || 50;
    cmd = ["journalctl", ["-u", service, "-n", String(n), "--no-pager"]];
  } else {
    if (!service) {
      return { content: [{ type: "text", text: "service required for " + action }], isError: true };
    }
    cmd = ["sudo", ["systemctl", action, service]];
  }
  
  try {
    const stdout = execFileSync(cmd[0], cmd[1], { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "OK") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
  }
}

async function sidekick_archive({ action, path: sourcePath, output, format }) {
  const allowedActions = ["create", "extract", "list"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }
  
  if (!sourcePath) {
    return { content: [{ type: "text", text: "path required" }], isError: true };
  }

  const sourcePolicyError = enforcePathPolicy(sourcePath, "read");
  if (sourcePolicyError) return sourcePolicyError;
  
  if (!fs.existsSync(sourcePath)) {
    return { content: [{ type: "text", text: "Path not found: " + sourcePath }], isError: true };
  }
  
  const fmt = format || "tar.gz";
  let cmd;
  
  if (action === "create") {
    if (!output) {
      return { content: [{ type: "text", text: "output required for create" }], isError: true };
    }
    const outputPolicyError = enforcePathPolicy(output, "write");
    if (outputPolicyError) return outputPolicyError;
    if (fmt === "tar.gz" || fmt === "tgz") {
      cmd = ["tar", ["-czf", output, "-C", path.dirname(sourcePath), path.basename(sourcePath)]];
    } else if (fmt === "zip") {
      cmd = ["zip", ["-r", output, sourcePath]];
    } else {
      return { content: [{ type: "text", text: "Invalid format. Use: tar.gz, tgz, or zip" }], isError: true };
    }
  } else if (action === "extract") {
    const extractTarget = process.cwd();
    const outputPolicyError = enforcePathPolicy(extractTarget, "write");
    if (outputPolicyError) return outputPolicyError;
    if (sourcePath.endsWith(".tar.gz") || sourcePath.endsWith(".tgz")) {
      cmd = ["tar", ["-xzf", sourcePath]];
    } else if (sourcePath.endsWith(".zip")) {
      cmd = ["unzip", [sourcePath]];
    } else {
      return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
    }
  } else if (action === "list") {
    if (sourcePath.endsWith(".tar.gz") || sourcePath.endsWith(".tgz")) {
      cmd = ["tar", ["-tzf", sourcePath]];
    } else if (sourcePath.endsWith(".zip")) {
      cmd = ["unzip", ["-l", sourcePath]];
    } else {
      return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
    }
  }
  
  try {
    const stdout = execFileSync(cmd[0], cmd[1], { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "OK") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
  }
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
    jobs.push(newJob);
    saveCronJobs(jobs);
    syncCrontab(jobs);
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
    try {
      const stdout = execSync(job.command, { timeout: 300000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      job.lastRun = new Date().toISOString();
      job.lastResult = "success";
      saveCronJobs(jobs);
      return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
    } catch (e) {
      job.lastRun = new Date().toISOString();
      job.lastResult = "error";
      saveCronJobs(jobs);
      return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
    }
  }
}

function syncCrontab(jobs) {
  try {
    const enabledJobs = jobs.filter(j => j.enabled);
    if (enabledJobs.length === 0) {
      execSync('crontab -r 2>/dev/null || true', { encoding: "utf-8" });
      return;
    }
    const lines = enabledJobs.map(j => {
      const script = `cd /home/sidekick/sidekick && ${j.command} >> ${DATA_DIR}/cron-${j.id}.log 2>&1`;
      return `${j.schedule} ${script} # sidekick:${j.id}`;
    });
    const crontabContent = lines.join("\n") + "\n";
    execSync(`echo ${JSON.stringify(crontabContent)} | crontab -`, { encoding: "utf-8" });
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

// --- Webhook Tool ---

function loadWebhooks() {
  return dbStore.loadDocument("webhooks", []);
}

function saveWebhooks(webhooks) {
  dbStore.setDocument("webhooks", webhooks);
}

async function sidekick_webhook({ action, id, limit }) {
  const allowedActions = ["list", "get", "clear"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const webhooks = loadWebhooks();

  if (action === "list") {
    if (webhooks.length === 0) {
      return { content: [{ type: "text", text: "No webhooks received" }] };
    }
    const n = limit || 20;
    const recent = webhooks.slice(-n);
    const summary = recent.map(w => 
      w.id + " | " + w.source + " | " + w.timestamp + " | " + JSON.stringify(w.payload).substring(0, 50) + "..."
    ).join("\n");
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "get") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    const webhook = webhooks.find(w => w.id === id);
    if (!webhook) {
      return { content: [{ type: "text", text: "Webhook not found" }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(webhook, null, 2) }] };
  }

  if (action === "clear") {
    saveWebhooks([]);
    return { content: [{ type: "text", text: "Cleared all webhooks" }] };
  }
}

// --- Context Tool ---

const DEFAULT_CONTEXT = {
  projects: {},
  decisions: [],
  problems: [],
  patterns: [],
  sessions: [],
  memories: []
};

function loadContext() {
  return dbStore.loadDocument("context", DEFAULT_CONTEXT);
}

function saveContext(ctx) {
  dbStore.setDocument("context", ctx);
}

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function simpleSimilarity(text1, text2) {
  const words1 = text1.toLowerCase().split(/\s+/);
  const words2 = text2.toLowerCase().split(/\s+/);
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

async function generateEmbedding(text) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const model = "nomic-embed-text";
  
  try {
    const response = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text })
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return data.embedding;
  } catch {
    return null;
  }
}

async function searchContext(ctx, query, type, limit = 10) {
  const results = [];
  const structuredExact = findStructuredMemoryById(query, type);
  if (structuredExact) {
    return [{ type: "memory", item: structuredExact, score: 1 }];
  }
  const exact = findContextItemById(ctx, query, type);
  if (exact && contextItemIsActive(exact.item)) {
    return [{ type: exact.type, item: exact.item, score: 1 }];
  }

  // Try Qdrant semantic search first, then merge keyword matches so automatic
  // memories in the SQLite context document are always eligible.
  const qdrantAvailable = await qdrantStore.isAvailable();
  
  if (qdrantAvailable && type !== "memories") {
    const embedding = await generateEmbedding(query);
    if (embedding) {
      try {
        const filter = type && type !== "all" ? {
          must: [{ key: "type", match: { value: type } }]
        } : null;
        
        const semanticResults = await qdrantStore.search(embedding, limit, filter);
        for (const r of semanticResults) {
          results.push({
          type: r.payload.type,
          item: r.payload.data,
          score: r.score
          });
        }
      } catch (e) {
      // Fall through to keyword search
      }
    }
  }
  
  // Fallback to keyword search
  if (type === "all" || type === "memories") {
    const structuredMemories = dbStore.searchMemories({ type: "all", limit: Math.max(limit * 5, 50) });
    for (const mem of structuredMemories) {
      const text = `${mem.type || ""} ${mem.project || ""} ${mem.content || ""} ${mem.summary || ""} ${mem.source_tool || ""} ${(mem.tags || []).join(" ")}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({
          type: "memory",
          item: {
            id: mem.id,
            date: mem.last_seen_at || mem.updated_at,
            type: mem.type,
            project: mem.project,
            summary: mem.summary || mem.content,
            content: mem.content,
            tool: mem.source_tool,
            outcome: mem.metadata?.outcome,
            confidence: mem.confidence,
            times_confirmed: mem.times_confirmed,
            structured: true
          },
          score: score * (mem.confidence || 1)
        });
      }
    }
  }

  if (type === "all" || type === "decisions") {
    for (const dec of ctx.decisions) {
      if (!contextItemIsActive(dec)) continue;
      const text = `${dec.context} ${dec.decision} ${dec.reasoning}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "decision", item: dec, score });
      }
    }
  }
  
  if (type === "all" || type === "problems") {
    for (const prob of ctx.problems) {
      if (!contextItemIsActive(prob)) continue;
      const text = `${prob.description} ${prob.solution || ""}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "problem", item: prob, score });
      }
    }
  }
  
  if (type === "all" || type === "patterns") {
    for (const pat of ctx.patterns) {
      if (!contextItemIsActive(pat)) continue;
      const text = `${pat.description} ${pat.example || ""}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "pattern", item: pat, score });
      }
    }
  }
  
  if (type === "all" || type === "sessions") {
    for (const sess of (ctx.sessions || [])) {
      if (!contextItemIsActive(sess)) continue;
      const text = `${sess.summary || ""} ${(sess.topics || []).join(" ")} ${sess.notes || ""}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "session", item: sess, score });
      }
    }
  }

  if (type === "all" || type === "memories") {
    for (const mem of (ctx.memories || [])) {
      if (!contextItemIsActive(mem)) continue;
      const text = `${mem.summary || ""} ${mem.goal || ""} ${mem.args || ""} ${mem.tool || ""} ${(mem.tools || []).join(" ")}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "memory", item: mem, score });
      }
    }
  }
  
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

const CONTEXT_COLLECTIONS = [
  { type: "decision", filter: "decisions", key: "decisions" },
  { type: "problem", filter: "problems", key: "problems" },
  { type: "pattern", filter: "patterns", key: "patterns" },
  { type: "session", filter: "sessions", key: "sessions" },
  { type: "memory", filter: "memories", key: "memories" }
];

function structuredMemoryToContextItem(mem) {
  if (!mem || mem.enabled === false || mem.state === "deleted" || mem.state === "expired") return null;
  return {
    id: mem.id,
    date: mem.last_seen_at || mem.updated_at,
    type: mem.type,
    project: mem.project,
    summary: mem.summary || mem.content,
    content: mem.content,
    tool: mem.source_tool,
    outcome: mem.metadata?.outcome,
    confidence: mem.confidence,
    times_confirmed: mem.times_confirmed,
    structured: true
  };
}

function findStructuredMemoryById(id, type = "all") {
  if (!contextTypeMatches(type || "all", { type: "memory", filter: "memories" })) return null;
  const mem = dbStore.getMemoryById(String(id || "").trim(), { includeDisabled: true });
  return structuredMemoryToContextItem(mem);
}

function contextTypeMatches(filter, entry) {
  return !filter || filter === "all" || filter === entry.filter || filter === entry.type;
}

function contextItemIsActive(item) {
  return item && item.enabled !== false && item.state !== "deleted" && item.state !== "disabled" && item.state !== "expired";
}

function findContextItemById(ctx, id, type = "all") {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  for (const entry of CONTEXT_COLLECTIONS) {
    if (!contextTypeMatches(type || "all", entry)) continue;
    const list = Array.isArray(ctx[entry.key]) ? ctx[entry.key] : [];
    const index = list.findIndex(item => item && item.id === wanted);
    if (index >= 0) return { ...entry, item: list[index], index };
  }
  return null;
}

function formatContextRecallResult(type, item) {
  if (type === "decision") {
    return `[Decision ${item.id}] ${item.date}\nContext: ${item.context}\nDecision: ${item.decision}\nReasoning: ${item.reasoning || "N/A"}`;
  }
  if (type === "problem") {
    return `[Problem ${item.id}] ${item.date}\nDescription: ${item.description}\nSolution: ${item.solution || "Unresolved"}`;
  }
  if (type === "pattern") {
    return `[Pattern ${item.id}] ${item.date}\nDescription: ${item.description}\nExample: ${item.example || "N/A"}`;
  }
  if (type === "session") {
    return `[Session ${item.id}] ${item.date}\nSummary: ${item.summary}\nTopics: ${(item.topics || []).join(", ")}\nOutcome: ${item.outcome || "N/A"}`;
  }
  if (type === "memory") {
    return `[Memory ${item.id}] ${item.date}\nType: ${item.type || "memory"}\nProject: ${item.project || "N/A"}\nSummary: ${item.summary || item.content || "N/A"}\nTool: ${item.tool || "N/A"}\nOutcome: ${item.outcome || "N/A"}\nConfidence: ${item.confidence || "N/A"}\nConfirmations: ${item.times_confirmed || "N/A"}`;
  }
  return `[Context ${item.id}] ${JSON.stringify(item, null, 2)}`;
}

function updateLegacyContextItem(id, action, reason) {
  const ctx = loadContext();
  const found = findContextItemById(ctx, id, "all");
  if (!found) return { found: false };

  const now = new Date().toISOString();
  const item = found.item;
  if (action === "delete") {
    item.enabled = false;
    item.state = "deleted";
    item.deleted_at = now;
    item.delete_reason = reason || "user_deleted";
  } else if (action === "disable") {
    item.enabled = false;
    item.state = "disabled";
    item.disabled_at = now;
    item.disable_reason = reason || "user_disabled";
  } else if (action === "expire") {
    item.enabled = false;
    item.state = "expired";
    item.expired_at = now;
    item.expire_reason = reason || "manual_expire";
  } else if (action === "restore") {
    item.enabled = true;
    item.state = "active";
    item.restored_at = now;
    delete item.deleted_at;
    delete item.disabled_at;
    delete item.expired_at;
  } else {
    return { found: true, supported: false, type: found.type };
  }

  item.updated_at = now;
  saveContext(ctx);
  return { found: true, supported: true, type: found.type, id };
}

async function sidekick_context({ action, project, context, decision, reasoning, problem, solution, pattern, summary, topics, outcome, notes, query, type, limit }) {
  const allowedActions = ["track_project", "track_decision", "track_problem", "track_pattern", "track_session", "recall", "suggest", "summarize", "list"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const ctx = loadContext();
  const now = new Date().toISOString();

  if (action === "track_project") {
    if (!project) {
      return { content: [{ type: "text", text: "project required" }], isError: true };
    }
    if (!ctx.projects[project]) {
      ctx.projects[project] = {
        name: project,
        created: now,
        lastWorked: now,
        sessions: 0,
        active: true
      };
    } else {
      ctx.projects[project].lastWorked = now;
      ctx.projects[project].sessions++;
    }
    saveContext(ctx);
    return { content: [{ type: "text", text: `Tracked project: ${project}` }] };
  }

  if (action === "track_decision") {
    if (!context || !decision) {
      return { content: [{ type: "text", text: "context and decision required" }], isError: true };
    }
    const dec = {
      id: generateId("dec"),
      date: now,
      project: project || null,
      context,
      decision,
      reasoning: reasoning || null,
      outcome: null
    };
    ctx.decisions.push(dec);
    if (project && ctx.projects[project]) {
      ctx.projects[project].lastWorked = now;
    }
    saveContext(ctx);
    
    // Store in Qdrant for semantic search
    try {
      if (await qdrantStore.isAvailable()) {
        const text = `${context} ${decision} ${reasoning || ""}`;
        const embedding = await generateEmbedding(text);
        if (embedding) {
          await qdrantStore.upsert(dec.id, embedding, { type: "decision", data: dec });
        }
      }
    } catch (e) {
      // Silently fail - context is still saved in JSON
    }
    
    return { content: [{ type: "text", text: `Tracked decision: ${decision} (id: ${dec.id})` }] };
  }

  if (action === "track_problem") {
    if (!problem) {
      return { content: [{ type: "text", text: "problem required" }], isError: true };
    }
    const prob = {
      id: generateId("prob"),
      date: now,
      project: project || null,
      description: problem,
      solution: solution || null,
      resolved: !!solution
    };
    ctx.problems.push(prob);
    if (project && ctx.projects[project]) {
      ctx.projects[project].lastWorked = now;
    }
    saveContext(ctx);
    
    // Store in Qdrant for semantic search
    try {
      if (await qdrantStore.isAvailable()) {
        const text = `${problem} ${solution || ""}`;
        const embedding = await generateEmbedding(text);
        if (embedding) {
          await qdrantStore.upsert(prob.id, embedding, { type: "problem", data: prob });
        }
      }
    } catch (e) {
      // Silently fail - context is still saved in JSON
    }
    
    return { content: [{ type: "text", text: `Tracked problem: ${problem} (id: ${prob.id})` }] };
  }

  if (action === "track_pattern") {
    if (!pattern) {
      return { content: [{ type: "text", text: "pattern required" }], isError: true };
    }
    const pat = {
      id: generateId("pat"),
      date: now,
      project: project || null,
      description: pattern,
      example: context || null
    };
    ctx.patterns.push(pat);
    saveContext(ctx);
    
    // Store in Qdrant for semantic search
    try {
      if (await qdrantStore.isAvailable()) {
        const text = `${pattern} ${context || ""}`;
        const embedding = await generateEmbedding(text);
        if (embedding) {
          await qdrantStore.upsert(pat.id, embedding, { type: "pattern", data: pat });
        }
      }
    } catch (e) {
      // Silently fail - context is still saved in JSON
    }
    
    return { content: [{ type: "text", text: `Tracked pattern: ${pattern} (id: ${pat.id})` }] };
  }

  if (action === "track_session") {
    if (!summary) {
      return { content: [{ type: "text", text: "summary required" }], isError: true };
    }
    const redactedSummary = redactSensitive(summary);
    const redactedNotes = notes ? redactSensitive(notes) : null;
    const topicList = topics ? topics.split(",").map(t => redactSensitive(t.trim())).filter(Boolean) : [];
    const sess = {
      id: generateId("sess"),
      date: now,
      project: project || null,
      summary: redactedSummary,
      topics: topicList,
      outcome: outcome || null,
      notes: redactedNotes
    };
    if (!ctx.sessions) ctx.sessions = [];
    ctx.sessions.push(sess);
    if (ctx.sessions.length > 100) {
      ctx.sessions = ctx.sessions.slice(-100);
    }
    if (project && ctx.projects[project]) {
      ctx.projects[project].lastWorked = now;
    }
    saveContext(ctx);
    
    // Store in Qdrant for semantic search
    try {
      if (await qdrantStore.isAvailable()) {
        const text = `${redactedSummary} ${topicList.join(" ")} ${redactedNotes || ""}`;
        const embedding = await generateEmbedding(text);
        if (embedding) {
          await qdrantStore.upsert(sess.id, embedding, { type: "session", data: sess });
        }
      }
    } catch (e) {
      // Silently fail - context is still saved in JSON
    }
    
    return { content: [{ type: "text", text: `Tracked session: ${redactedSummary} (id: ${sess.id})` }] };
  }

  if (action === "recall") {
    if (!query) {
      return { content: [{ type: "text", text: "query required" }], isError: true };
    }
    const results = await searchContext(ctx, query, type || "all", limit || 10);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No relevant context found" }] };
    }
    const summary = results.map(r => formatContextRecallResult(r.type, r.item)).join("\n\n");
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "suggest") {
    if (!query) {
      return { content: [{ type: "text", text: "query required" }], isError: true };
    }
    const results = await searchContext(ctx, query, "all", 5);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No suggestions based on past context" }] };
    }
    const suggestions = results.map(r => {
      const item = r.item;
      if (r.type === "decision") {
        return `• You previously decided: "${item.decision}" because "${item.reasoning || "no reason recorded"}" (on ${item.date})`;
      } else if (r.type === "problem") {
        return `• You encountered a similar problem: "${item.description}" - ${item.solution ? `solved with: "${item.solution}"` : "unresolved"}`;
      } else if (r.type === "pattern") {
        return `• You have a pattern: "${item.description}"`;
      } else if (r.type === "session") {
        return `• You had a session on ${item.date}: "${item.summary}" (${item.outcome || "no outcome recorded"})`;
      } else if (r.type === "memory") {
        return `• Automatic memory from ${item.date}: "${item.summary || item.goal || item.tool}"`;
      }
    }).join("\n");
    return { content: [{ type: "text", text: `Based on your past context:\n\n${suggestions}` }] };
  }

  if (action === "summarize") {
    const projectName = project || "all";
    let summary = `# Context Summary`;
    
    if (projectName !== "all") {
      const proj = ctx.projects[projectName];
      if (!proj) {
        return { content: [{ type: "text", text: `Project not found: ${projectName}` }], isError: true };
      }
      summary += `\n\n## Project: ${projectName}\n`;
      summary += `- Created: ${proj.created}\n`;
      summary += `- Last worked: ${proj.lastWorked}\n`;
      summary += `- Sessions: ${proj.sessions}\n`;
      
      const projDecisions = ctx.decisions.filter(d => d.project === projectName);
      const projProblems = ctx.problems.filter(p => p.project === projectName);
      const projPatterns = ctx.patterns.filter(p => p.project === projectName);
      const projMemories = (ctx.memories || []).filter(m => m.project === projectName);
      
      if (projDecisions.length > 0) {
        summary += `\n### Decisions (${projDecisions.length}):\n`;
        projDecisions.slice(-5).forEach(d => {
          summary += `- ${d.date}: ${d.decision}\n`;
        });
      }
      
      if (projProblems.length > 0) {
        summary += `\n### Problems (${projProblems.length}):\n`;
        projProblems.slice(-5).forEach(p => {
          summary += `- ${p.date}: ${p.description} ${p.resolved ? "(resolved)" : "(unresolved)"}\n`;
        });
      }
      
      if (projPatterns.length > 0) {
        summary += `\n### Patterns (${projPatterns.length}):\n`;
        projPatterns.slice(-5).forEach(p => {
          summary += `- ${p.description}\n`;
        });
      }
      
      const projSessions = (ctx.sessions || []).filter(s => s.project === projectName);
      if (projSessions.length > 0) {
        summary += `\n### Recent Sessions (${projSessions.length}):\n`;
        projSessions.slice(-5).forEach(s => {
          summary += `- ${s.date}: ${s.summary} (${s.outcome || "N/A"})\n`;
        });
      }

      if (projMemories.length > 0) {
        summary += `\n### Automatic Memories (${projMemories.length}):\n`;
        projMemories.slice(-5).forEach(m => {
          summary += `- ${m.date}: ${m.summary || m.goal || m.tool || "memory"}\n`;
        });
      }
    } else {
      summary += `\n\n## Overview\n`;
      summary += `- Total projects: ${Object.keys(ctx.projects).length}\n`;
      summary += `- Total decisions: ${ctx.decisions.length}\n`;
      summary += `- Total problems: ${ctx.problems.length}\n`;
      summary += `- Total patterns: ${ctx.patterns.length}\n`;
      summary += `- Total sessions: ${(ctx.sessions || []).length}\n`;
      summary += `- Automatic memories: ${(ctx.memories || []).length}\n`;
      
      const activeProjects = Object.values(ctx.projects).filter(p => p.active);
      if (activeProjects.length > 0) {
        summary += `\n### Active Projects:\n`;
        activeProjects.forEach(p => {
          summary += `- ${p.name} (last worked: ${p.lastWorked})\n`;
        });
      }
    }
    
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "list") {
    const items = [];
    if (!type || type === "all" || type === "decisions") {
      items.push(`Decisions: ${ctx.decisions.length}`);
    }
    if (!type || type === "all" || type === "problems") {
      items.push(`Problems: ${ctx.problems.length}`);
    }
    if (!type || type === "all" || type === "patterns") {
      items.push(`Patterns: ${ctx.patterns.length}`);
    }
    if (!type || type === "all" || type === "projects") {
      items.push(`Projects: ${Object.keys(ctx.projects).length}`);
    }
    if (!type || type === "all" || type === "sessions") {
      items.push(`Sessions: ${(ctx.sessions || []).length}`);
    }
    if (!type || type === "all" || type === "memories") {
      items.push(`Automatic memories: ${(ctx.memories || []).length}`);
    }
    return { content: [{ type: "text", text: items.join("\n") }] };
  }
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

// --- Transform Tool ---

async function sidekick_transform({ action, input, pattern, format, field, key, value }) {
  if (!input && input !== "") {
    return { content: [{ type: "text", text: "input required" }], isError: true };
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    data = input;
  }

  if (action === "filter") {
    if (!pattern) {
      return { content: [{ type: "text", text: "pattern required for filter" }], isError: true };
    }
    if (typeof data === "string") {
      const regex = new RegExp(pattern);
      const lines = data.split("\n");
      const matches = lines.filter(line => regex.test(line));
      const result = matches.join("\n");
      return { content: [{ type: "text", text: result }] };
    } else if (Array.isArray(data)) {
      const regex = new RegExp(pattern);
      const filtered = data.filter(item => {
        if (typeof item === "string") return regex.test(item);
        if (typeof item === "object") return regex.test(JSON.stringify(item));
        return regex.test(String(item));
      });
      return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
    } else {
      return { content: [{ type: "text", text: "filter works on strings or arrays" }], isError: true };
    }
  }

  if (action === "extract") {
    if (!field) {
      return { content: [{ type: "text", text: "field required for extract" }], isError: true };
    }
    if (typeof data !== "object" || data === null) {
      return { content: [{ type: "text", text: "extract requires JSON input" }], isError: true };
    }
    const fields = field.split(".");
    let result = data;
    for (const f of fields) {
      if (result === undefined || result === null) break;
      if (Array.isArray(result) && f === "[]") {
        continue;
      }
      result = result[f];
    }
    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "sort") {
    if (!Array.isArray(data)) {
      return { content: [{ type: "text", text: "sort requires array input" }], isError: true };
    }
    const sorted = [...data].sort((a, b) => {
      if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
      if (typeof a === "number" && typeof b === "number") return a - b;
      if (typeof a === "object" && typeof b === "object") {
        if (key) {
          const aVal = a[key];
          const bVal = b[key];
          if (typeof aVal === "number" && typeof bVal === "number") return aVal - bVal;
          return String(aVal).localeCompare(String(bVal));
        }
      }
      return String(a).localeCompare(String(b));
    });
    return { content: [{ type: "text", text: JSON.stringify(sorted, null, 2) }] };
  }

  if (action === "format") {
    if (!format) {
      return { content: [{ type: "text", text: "format required" }], isError: true };
    }
    if (format === "json") {
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    if (format === "csv") {
      if (!Array.isArray(data)) {
        return { content: [{ type: "text", text: "csv format requires array input" }], isError: true };
      }
      if (data.length === 0) return { content: [{ type: "text", text: "" }] };
      const first = data[0];
      if (typeof first !== "object" || first === null) {
        return { content: [{ type: "text", text: data.join("\n") }] };
      }
      const headers = Object.keys(first);
      const rows = data.map(item => headers.map(h => {
        const val = item[h];
        const str = val === null || val === undefined ? "" : String(val);
        return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(","));
      return { content: [{ type: "text", text: [headers.join(","), ...rows].join("\n") }] };
    }
    if (format === "table") {
      if (!Array.isArray(data)) {
        return { content: [{ type: "text", text: "table format requires array input" }], isError: true };
      }
      if (data.length === 0) return { content: [{ type: "text", text: "" }] };
      const first = data[0];
      if (typeof first !== "object" || first === null) {
        return { content: [{ type: "text", text: data.join("\n") }] };
      }
      const headers = Object.keys(first);
      const widths = headers.map(h => Math.max(h.length, ...data.map(row => String(row[h] || "").length)));
      const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join(" | ");
      const separator = widths.map(w => "-".repeat(w)).join("-+-");
      const dataRows = data.map(row => headers.map((h, i) => String(row[h] || "").padEnd(widths[i])).join(" | "));
      return { content: [{ type: "text", text: [headerRow, separator, ...dataRows].join("\n") }] };
    }
    if (format === "text") {
      if (typeof data === "string") return { content: [{ type: "text", text: data }] };
      if (Array.isArray(data)) return { content: [{ type: "text", text: data.join("\n") }] };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
    return { content: [{ type: "text", text: "Unknown format. Use: json, csv, table, text" }], isError: true };
  }

  if (action === "map") {
    if (!key || !value) {
      return { content: [{ type: "text", text: "key and value required for map" }], isError: true };
    }
    if (!Array.isArray(data)) {
      return { content: [{ type: "text", text: "map requires array input" }], isError: true };
    }
    const mapped = data.map(item => {
      if (typeof item === "object" && item !== null) {
        return { ...item, [key]: value };
      }
      return { [key]: value, original: item };
    });
    return { content: [{ type: "text", text: JSON.stringify(mapped, null, 2) }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: filter, extract, sort, format, map" }], isError: true };
}

// --- Health Tool ---

const HEALTH_HISTORY_FILE = path.join(DATA_DIR, "health_history.json");
const MAX_HEALTH_HISTORY = 100;

function loadHealthHistory() {
  if (!fs.existsSync(HEALTH_HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HEALTH_HISTORY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveHealthHistory(history) {
  fs.writeFileSync(HEALTH_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function checkServices(serviceList) {
  const services = serviceList
    ? serviceList.split(",").map(s => s.trim()).filter(Boolean)
    : ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"];
  const results = [];
  let healthy = 0;
  for (const svc of services) {
    try {
      const output = execFileSync("systemctl", ["is-active", svc], { encoding: "utf-8", timeout: 5000 }).trim();
      const isActive = output === "active";
      results.push({ service: svc, status: output, healthy: isActive });
      if (isActive) healthy++;
    } catch (e) {
      const status = String(e.stdout || "unknown").trim() || "unknown";
      results.push({ service: svc, status, healthy: false, error: e.message });
    }
  }
  const issues = results.filter(result => !result.healthy).map(result => `Service ${result.service} is ${result.status}`);
  return {
    results,
    score: services.length > 0 ? (healthy / services.length) * 100 : 0,
    healthy,
    total: services.length,
    issues
  };
}

function checkProcesses() {
  try {
    const output = execFileSync("ps", ["aux", "--sort=-%cpu"], {
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 5 * 1024 * 1024
    });
    const lines = output.trim().split("\n");
    const processes = lines.slice(1).map(line => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1]),
        cpu: parseFloat(parts[2]),
        mem: parseFloat(parts[3]),
        command: parts.slice(10).join(" ")
      };
    });
    const highCpu = processes.filter(p => p.cpu > 50);
    const highMem = processes.filter(p => p.mem > 50);
    const score = 100 - (highCpu.length * 10) - (highMem.length * 10);
    return {
      results: { top: processes.slice(0, 5), highCpu, highMem },
      score: Math.max(0, score),
      issues: [...highCpu.map(p => `High CPU: ${p.command} (${p.cpu}%)`), ...highMem.map(p => `High MEM: ${p.command} (${p.mem}%)`)]
    };
  } catch (e) {
    return {
      results: { top: [], highCpu: [], highMem: [] },
      score: 0,
      issues: [`Failed to check processes: ${e.message}`]
    };
  }
}

function checkDisk() {
  try {
    const output = execFileSync("df", ["-P"], { encoding: "utf-8", timeout: 5000 });
    const lines = output.trim().split("\n").slice(1);
    const disks = lines.map(line => {
      const parts = line.split(/\s+/);
      return {
        filesystem: parts[0],
        usage: parseInt(parts[4], 10),
        mount: parts.slice(5).join(" ")
      };
    }).filter(disk => Number.isFinite(disk.usage) && disk.mount);
    const critical = disks.filter(d => d.usage > 90);
    const warning = disks.filter(d => d.usage > 80 && d.usage <= 90);
    const score = 100 - (critical.length * 20) - (warning.length * 10);
    return {
      results: disks,
      score: Math.max(0, score),
      issues: [...critical.map(d => `Critical: ${d.mount} at ${d.usage}%`), ...warning.map(d => `Warning: ${d.mount} at ${d.usage}%`)]
    };
  } catch (e) {
    return { results: [], score: 0, issues: [`Failed to check disk: ${e.message}`] };
  }
}

function probeDns(hostname, timeoutMs = 4000) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, host: hostname, error: "Timed out" });
      }
    }, timeoutMs);

    dns.lookup(hostname, (error, address) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error
        ? { ok: false, host: hostname, error: error.message }
        : { ok: true, host: hostname, address });
    });
  });
}

function probeHttps(url, timeoutMs = 4000) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    let request;

    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ url, latencyMs: Date.now() - started, ...result });
    };

    try {
      request = https.request(url, { method: "HEAD" }, response => {
        response.resume();
        finish({ ok: true, statusCode: response.statusCode });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("Timed out")));
      request.on("error", error => finish({ ok: false, error: error.message }));
      request.end();
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
  });
}

async function checkNetwork(options = {}) {
  const issues = [];
  const recommendations = [];
  const targetUrl = options.targetUrl || process.env.SIDEKICK_HEALTHCHECK_URL || "https://github.com";
  let targetHost;
  try {
    targetHost = new URL(targetUrl).hostname;
  } catch {
    targetHost = "";
  }
  const dnsProbe = options.dnsProbe || probeDns;
  const httpsProbe = options.httpsProbe || probeHttps;
  const runFile = options.execFileSyncImpl || execFileSync;
  const services = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"];
  const servicePorts = {
    "sidekick-mcp": 4097,
    "sidekick-dashboard": 4098,
    "sidekick-agent": 4099
  };

  const [dnsResult, httpsResult] = await Promise.all([
    targetHost
      ? dnsProbe(targetHost)
      : Promise.resolve({ ok: false, host: targetHost, error: "Invalid health-check URL" }),
    httpsProbe(targetUrl)
  ]);
  if (!dnsResult.ok) issues.push(`DNS resolution failed for ${targetHost || targetUrl}: ${dnsResult.error}`);
  if (!httpsResult.ok) issues.push(`Outbound HTTPS failed for ${targetUrl}: ${httpsResult.error}`);

  let icmp = { target: "8.8.8.8", ok: false };
  try {
    runFile("ping", ["-c", "1", "-W", "2", "8.8.8.8"], {
      encoding: "utf-8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    icmp.ok = true;
  } catch (error) {
    icmp.error = error.message;
  }

  let listeners = "";
  try {
    listeners = runFile("ss", ["-tln"], { encoding: "utf-8", timeout: 5000 });
  } catch (e) {
    issues.push(`Failed to inspect listening ports: ${e.message}`);
  }

  const ports = {};
  for (const service of services) {
    const port = servicePorts[service];
    const listening = listeners.split("\n").some(line =>
      new RegExp(`[:.]${port}(?:\\s|$)`).test(line)
    );
    ports[service] = { port, listening };
    if (!listening) recommendations.push(`${service} not listening on port ${port}`);
  }
  const listeningCount = Object.values(ports).filter(port => port.listening).length;
  const score = (dnsResult.ok ? 25 : 0) +
    (httpsResult.ok ? 25 : 0) +
    (listeningCount / services.length) * 50;
  return {
    results: {
      internet: dnsResult.ok && httpsResult.ok,
      dns: dnsResult,
      https: httpsResult,
      icmp,
      ports
    },
    score,
    issues,
    recommendations
  };
}

function checkCustom(commands) {
  if (!commands) return { results: [], score: 100, issues: [] };
  const cmdList = commands.split(",").map(c => c.trim());
  const results = [];
  let allPassed = true;
  for (const cmd of cmdList) {
    try {
      const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
      results.push({ command: cmd, output, success: true });
    } catch (e) {
      results.push({ command: cmd, error: e.message, success: false });
      allPassed = false;
    }
  }
  return { results, score: allPassed ? 100 : 50, issues: results.filter(r => !r.success).map(r => `Failed: ${r.command}`) };
}

function parseThresholds(threshold) {
  if (!threshold) return {};
  const thresholds = {};
  const parts = threshold.split(",").map(t => t.trim());
  for (const part of parts) {
    const match = part.match(/^(\w+)([><=]+)(\d+)$/);
    if (match) {
      thresholds[match[1]] = { operator: match[2], value: parseInt(match[3]) };
    }
  }
  return thresholds;
}

function applyThresholds(results, thresholds) {
  const issues = [];
  for (const [metric, { operator, value }] of Object.entries(thresholds)) {
    if (metric === "disk" && results.disk?.results) {
      for (const disk of results.disk.results) {
        const usage = disk.usage;
        if ((operator === ">" && usage > value) || (operator === ">=" && usage >= value)) {
          issues.push(`Disk ${disk.mount} at ${usage}% exceeds threshold ${operator}${value}%`);
        }
      }
    }
    if (metric === "mem" && results.processes?.results?.top) {
      for (const proc of results.processes.results.top) {
        if ((operator === ">" && proc.mem > value) || (operator === ">=" && proc.mem >= value)) {
          issues.push(`Process ${proc.command} using ${proc.mem}% memory exceeds threshold ${operator}${value}%`);
        }
      }
    }
  }
  return issues;
}

async function sidekick_health({ check, services, commands, threshold }) {
  const now = new Date().toISOString();
  const checks = check === "all" ? ["services", "processes", "disk", "network"] : [check];
  const results = {};
  let totalScore = 0;
  let totalChecks = 0;
  const allIssues = [];
  const allRecommendations = [];

  for (const c of checks) {
    if (c === "services") {
      results.services = checkServices(services);
      totalScore += results.services.score;
      totalChecks++;
      if (results.services.issues) allIssues.push(...results.services.issues);
    } else if (c === "processes") {
      results.processes = checkProcesses();
      totalScore += results.processes.score;
      totalChecks++;
      if (results.processes.issues) allIssues.push(...results.processes.issues);
    } else if (c === "disk") {
      results.disk = checkDisk();
      totalScore += results.disk.score;
      totalChecks++;
      if (results.disk.issues) allIssues.push(...results.disk.issues);
    } else if (c === "network") {
      results.network = await checkNetwork();
      totalScore += results.network.score;
      totalChecks++;
      if (results.network.issues) allIssues.push(...results.network.issues);
      if (results.network.recommendations) allRecommendations.push(...results.network.recommendations);
    } else if (c === "custom") {
      results.custom = checkCustom(commands);
      totalScore += results.custom.score;
      totalChecks++;
      if (results.custom.issues) allIssues.push(...results.custom.issues);
    } else {
      return { content: [{ type: "text", text: `Unknown check: ${c}. Use: all, services, processes, disk, network, custom` }], isError: true };
    }
  }

  const thresholds = parseThresholds(threshold);
  const thresholdIssues = applyThresholds(results, thresholds);
  allIssues.push(...thresholdIssues);

  const overallScore = totalChecks > 0 ? Math.round(totalScore / totalChecks) : 0;

  const history = loadHealthHistory();
  history.push({ date: now, score: overallScore, checks: checks.join(","), issues: allIssues.length });
  if (history.length > MAX_HEALTH_HISTORY) history.splice(0, history.length - MAX_HEALTH_HISTORY);
  saveHealthHistory(history);

  let output = `# Health Check Report\n\n`;
  output += `**Overall Score: ${overallScore}/100**\n`;
  output += `**Time: ${now}**\n\n`;

  for (const c of checks) {
    output += `## ${c.charAt(0).toUpperCase() + c.slice(1)}\n`;
    if (c === "services") {
      output += `- Score: ${results.services.score.toFixed(0)}/100\n`;
      output += `- Services: ${results.services.healthy}/${results.services.total} healthy\n`;
      for (const svc of results.services.results) {
        output += `  - ${svc.service}: ${svc.status} ${svc.healthy ? "✓" : "✗"}\n`;
      }
    } else if (c === "processes") {
      output += `- Score: ${results.processes.score.toFixed(0)}/100\n`;
      output += `- Top processes (by CPU):\n`;
      for (const proc of results.processes.results?.top || []) {
        output += `  - ${proc.command.substring(0, 40)}: CPU ${proc.cpu}%, MEM ${proc.mem}%\n`;
      }
    } else if (c === "disk") {
      output += `- Score: ${results.disk.score.toFixed(0)}/100\n`;
      output += `- Disk usage:\n`;
      for (const disk of Array.isArray(results.disk.results) ? results.disk.results : []) {
        output += `  - ${disk.mount}: ${disk.usage}%\n`;
      }
    } else if (c === "network") {
      output += `- Score: ${results.network.score.toFixed(0)}/100\n`;
      output += `- Internet: ${results.network.results?.internet ? "✓" : "✗"}\n`;
      const dnsResult = results.network.results?.dns;
      const httpsResult = results.network.results?.https;
      const icmpResult = results.network.results?.icmp;
      output += `- DNS (${dnsResult?.host || "unknown"}): ${dnsResult?.ok ? "✓" : "✗"}\n`;
      output += `- HTTPS (${httpsResult?.url || "unknown"}): ${httpsResult?.ok ? `✓ ${httpsResult.statusCode || ""} (${httpsResult.latencyMs}ms)`.trim() : "✗"}\n`;
      output += `- ICMP (${icmpResult?.target || "unknown"}): ${icmpResult?.ok ? "✓" : "✗"} (informational)\n`;
      output += `- Ports:\n`;
      for (const [svc, info] of Object.entries(results.network.results?.ports || {})) {
        output += `  - ${svc} (${info.port}): ${info.listening ? "listening" : "not listening"}\n`;
      }
    } else if (c === "custom") {
      output += `- Score: ${results.custom.score.toFixed(0)}/100\n`;
      for (const res of Array.isArray(results.custom.results) ? results.custom.results : []) {
        output += `  - ${res.command}: ${res.success ? "✓" : "✗"}\n`;
        if (res.output) output += `    ${res.output.substring(0, 100)}\n`;
      }
    }
    output += `\n`;
  }

  if (allIssues.length > 0) {
    output += `## Issues (${allIssues.length})\n`;
    for (const issue of allIssues) {
      output += `- ${issue}\n`;
    }
    output += `\n`;
  }

  if (allRecommendations.length > 0) {
    output += `## Recommendations\n`;
    for (const rec of allRecommendations) {
      output += `- ${rec}\n`;
    }
    output += `\n`;
  }

  if (overallScore >= 90) {
    output += `**Status: HEALTHY** ✓\n`;
  } else if (overallScore >= 70) {
    output += `**Status: WARNING** ⚠\n`;
  } else {
    output += `**Status: CRITICAL** ✗\n`;
  }

  return { content: [{ type: "text", text: output }] };
}

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
    
    delays.push(delay);
    saveDelays(delays);
    
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
    
    delay.status = "running";
    delay.startedAt = now;
    saveDelays(delays);
    
    try {
      const result = await callTool(delay.tool, delay.args);
      delay.status = "completed";
      delay.completedAt = new Date().toISOString();
      delay.result = result.content?.[0]?.text?.substring(0, 200) || "ok";
      saveDelays(delays);
      
      return { content: [{ type: "text", text: `Executed delay ${id}:\n\n${result.content?.[0]?.text || "ok"}` }] };
    } catch (e) {
      delay.status = "failed";
      delay.completedAt = new Date().toISOString();
      delay.error = e.message;
      saveDelays(delays);
      
      return { content: [{ type: "text", text: `Delay ${id} failed: ${e.message}` }], isError: true };
    }
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: add, list, cancel, run" }], isError: true };
}

// --- Snapshot Tool ---

const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
if (!fs.existsSync(SNAPSHOTS_DIR)) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

function captureProcesses() {
  try {
    const output = execSync("ps aux --sort=-%mem", { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    return lines.slice(1).map(line => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1]),
        cpu: parseFloat(parts[2]),
        mem: parseFloat(parts[3]),
        command: parts.slice(10).join(" ")
      };
    });
  } catch {
    return [];
  }
}

function captureServices() {
  try {
    const output = execSync("systemctl list-units --type=service --state=running --no-pager", { encoding: "utf-8" });
    const lines = output.trim().split("\n").slice(1, -5);
    return lines.map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        unit: parts[0],
        load: parts[1],
        active: parts[2],
        sub: parts[3],
        description: parts.slice(4).join(" ")
      };
    });
  } catch {
    return [];
  }
}

function captureDisk() {
  try {
    const output = execSync("df -h --output=source,size,used,avail,pcent,target", { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    return lines.slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        usePercent: parts[4],
        mounted: parts[5]
      };
    });
  } catch {
    return [];
  }
}

function captureFiles(filePaths) {
  if (!filePaths) return {};
  const paths = filePaths.split(",").map(p => p.trim());
  const result = {};
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      result[p] = { mtime: Math.floor(stat.mtimeMs / 1000), size: stat.size };
    } catch {
      result[p] = { error: "not found" };
    }
  }
  return result;
}

function capturePackages() {
  try {
    const output = execSync("dpkg -l | grep '^ii' | awk '{print $2, $3}'", { encoding: "utf-8" });
    return output.trim().split("\n").map(line => {
      const [name, version] = line.split(" ");
      return { name, version };
    });
  } catch {
    return [];
  }
}

function captureNetwork() {
  try {
    const interfaces = execSync("ip -o link show | awk '{print $2}' | tr -d ':'", { encoding: "utf-8" }).trim().split("\n");
    const result = {};
    for (const iface of interfaces) {
      try {
        const ip = execSync(`ip -o -4 addr show ${iface} | awk '{print $4}'`, { encoding: "utf-8" }).trim();
        result[iface] = { ip };
      } catch {
        result[iface] = { ip: "none" };
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function sidekick_snapshot({ action, name, capture, compare }) {
  const now = new Date().toISOString();
  
  if (action === "capture") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    
    const types = capture ? capture.split(",").map(t => t.trim()) : ["processes", "services", "disk"];
    const snapshot = { name, date: now, types, data: {} };
    
    for (const type of types) {
      if (type === "processes") {
        snapshot.data.processes = captureProcesses();
      } else if (type === "services") {
        snapshot.data.services = captureServices();
      } else if (type === "disk") {
        snapshot.data.disk = captureDisk();
      } else if (type === "packages") {
        snapshot.data.packages = capturePackages();
      } else if (type === "network") {
        snapshot.data.network = captureNetwork();
      } else if (type.startsWith("files:")) {
        const paths = type.substring(6);
        for (const filePath of paths.split(",").map(p => p.trim()).filter(Boolean)) {
          const policyError = enforcePathPolicy(filePath, "read");
          if (policyError) return policyError;
        }
        snapshot.data.files = captureFiles(paths);
      }
    }
    
    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    
    return { content: [{ type: "text", text: `Captured snapshot: ${name}\nTypes: ${types.join(", ")}\nDate: ${now}` }] };
  }
  
  if (action === "compare") {
    if (!name || !compare) {
      return { content: [{ type: "text", text: "name and compare required" }], isError: true };
    }
    
    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    const comparePath = path.join(SNAPSHOTS_DIR, `${compare}.json`);
    
    if (!fs.existsSync(snapshotPath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${name}` }], isError: true };
    }
    if (!fs.existsSync(comparePath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${compare}` }], isError: true };
    }
    
    const current = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    const baseline = JSON.parse(fs.readFileSync(comparePath, "utf-8"));
    
    let output = `# Snapshot Comparison\n\n`;
    output += `**Current: ${name}** (${current.date})\n`;
    output += `**Baseline: ${compare}** (${baseline.date})\n\n`;
    
    const diff = { added: [], removed: [], changed: [] };
    
    if (current.data.processes && baseline.data.processes) {
      const currentPids = new Set(current.data.processes.map(p => p.pid));
      const baselinePids = new Set(baseline.data.processes.map(p => p.pid));
      
      for (const p of current.data.processes) {
        if (!baselinePids.has(p.pid)) diff.added.push(`Process: ${p.command} (PID ${p.pid})`);
      }
      for (const p of baseline.data.processes) {
        if (!currentPids.has(p.pid)) diff.removed.push(`Process: ${p.command} (PID ${p.pid})`);
      }
    }
    
    if (current.data.services && baseline.data.services) {
      const currentServices = new Set(current.data.services.map(s => s.unit));
      const baselineServices = new Set(baseline.data.services.map(s => s.unit));
      
      for (const s of current.data.services) {
        if (!baselineServices.has(s.unit)) diff.added.push(`Service: ${s.unit}`);
      }
      for (const s of baseline.data.services) {
        if (!currentServices.has(s.unit)) diff.removed.push(`Service: ${s.unit}`);
      }
    }
    
    if (current.data.files && baseline.data.files) {
      for (const [path, info] of Object.entries(current.data.files)) {
        const baselineInfo = baseline.data.files[path];
        if (!baselineInfo) {
          diff.added.push(`File: ${path}`);
        } else if (info.mtime !== baselineInfo.mtime || info.size !== baselineInfo.size) {
          diff.changed.push(`File: ${path} (modified)`);
        }
      }
      for (const path of Object.keys(baseline.data.files)) {
        if (!current.data.files[path]) {
          diff.removed.push(`File: ${path}`);
        }
      }
    }
    
    output += `## Summary\n`;
    output += `- Added: ${diff.added.length}\n`;
    output += `- Removed: ${diff.removed.length}\n`;
    output += `- Changed: ${diff.changed.length}\n\n`;
    
    if (diff.added.length > 0) {
      output += `## Added\n`;
      for (const item of diff.added.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.added.length > 20) output += `- ... and ${diff.added.length - 20} more\n`;
      output += `\n`;
    }
    
    if (diff.removed.length > 0) {
      output += `## Removed\n`;
      for (const item of diff.removed.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.removed.length > 20) output += `- ... and ${diff.removed.length - 20} more\n`;
      output += `\n`;
    }
    
    if (diff.changed.length > 0) {
      output += `## Changed\n`;
      for (const item of diff.changed.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.changed.length > 20) output += `- ... and ${diff.changed.length - 20} more\n`;
      output += `\n`;
    }
    
    return { content: [{ type: "text", text: output }] };
  }
  
  if (action === "list") {
    const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith(".json"));
    const snapshots = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), "utf-8"));
      return { name: data.name, date: data.date, types: data.types.join(", ") };
    });
    
    let output = `# Snapshots (${snapshots.length})\n\n`;
    for (const s of snapshots) {
      output += `- **${s.name}** (${s.date})\n  Types: ${s.types}\n`;
    }
    
    return { content: [{ type: "text", text: output }] };
  }
  
  if (action === "delete") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    
    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    if (!fs.existsSync(snapshotPath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${name}` }], isError: true };
    }
    
    fs.unlinkSync(snapshotPath);
    return { content: [{ type: "text", text: `Deleted snapshot: ${name}` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: capture, compare, list, delete" }], isError: true };
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

function parseInterval(interval) {
  if (!interval) return 60000;
  const match = interval.match(/^(\d+)(s|m|h)$/);
  if (!match) return 60000;
  const amount = parseInt(match[1]);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000 };
  return amount * multipliers[unit];
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

async function executeWatchAction(watch, checkResult) {
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
    await callTool(action_tool, args);
  } catch (e) {
    console.error(`Watch ${watch.id} action failed: ${e.message}`);
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
    
    watches.push(watch);
    saveWatches(watches);
    
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
    
    watches.splice(idx, 1);
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
    
    const triggered = evaluateCondition(watch, checkResult);
    
    watch.lastCheck = now;
    if (triggered) {
      watch.lastTriggered = now;
      watch.triggerCount++;
      await executeWatchAction(watch, checkResult);
    }
    saveWatches(watches);
    
    return { content: [{ type: "text", text: `Watch check: ${watch.id}\nSource: ${watch.source} ${watch.target}\nResult: ${JSON.stringify(checkResult)}\nTriggered: ${triggered}` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: add, list, remove, pause, check" }], isError: true };
}

// --- Secret Tool ---

const crypto = require("crypto");
const SECRETS_FILE = path.join(DATA_DIR, "secrets.enc");

function getSecretKey() {
  const key = process.env.SIDEKICK_SECRET_KEY;
  if (!key) {
    throw new Error("SIDEKICK_SECRET_KEY not set in .env");
  }
  return crypto.createHash("sha256").update(key).digest();
}

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

function encryptSecret(value) {
  const key = getSecretKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return { iv: iv.toString("hex"), data: encrypted, authTag };
}

function decryptSecret(encrypted) {
  const key = getSecretKey();
  const iv = Buffer.from(encrypted.iv, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));
  let decrypted = decipher.update(encrypted.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
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

async function sidekick_security_scan({ path: rootPath, max_files, format } = {}) {
  const scanRoot = path.resolve(rootPath || process.env.SIDEKICK_REPO_DIR || path.join(__dirname, ".."));
  const policyError = enforcePathPolicy(scanRoot, "security_scan");
  if (policyError) return policyError;
  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    return { content: [{ type: "text", text: "Scan directory not found: " + scanRoot }], isError: true };
  }

  const report = scanSecurityConfig({
    root: scanRoot,
    maxFiles: max_files,
    canAccess: target => getPathPolicyDecision(target, "security_scan").allowed
  });
  if (format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }

  const lines = [
    "SECURITY CONFIG SCAN",
    "Root: " + report.root,
    "Files scanned: " + report.files_scanned,
    "Skipped by path policy: " + report.skipped_by_policy,
    "Truncated: " + (report.truncated ? "yes" : "no"),
    `Findings: ${report.findings.length} (critical=${report.counts.critical}, high=${report.counts.high}, medium=${report.counts.medium}, low=${report.counts.low})`
  ];
  for (const finding of report.findings) {
    const location = finding.path + (finding.line ? ":" + finding.line : "");
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.type} ${location} - ${finding.message}`);
  }
  if (report.findings.length === 0) lines.push("No config or secret handling findings.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// --- Parse Tool ---

const YAML = require("yaml");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const INI = require("ini");

function detectFormat(input) {
  const trimmed = input.trim();
  
  // Try JSON first
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {}
  }
  
  // Check for YAML indicators
  if (trimmed.includes(":") && (trimmed.includes("\n") || trimmed.startsWith("---"))) {
    try {
      YAML.parse(trimmed);
      return "yaml";
    } catch {}
  }
  
  // Check for XML
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<")) {
    try {
      const parser = new XMLParser();
      parser.parse(trimmed);
      return "xml";
    } catch {}
  }
  
  // Check for INI
  if (trimmed.includes("[") && trimmed.includes("=")) {
    try {
      INI.parse(trimmed);
      return "ini";
    } catch {}
  }
  
  // Check for CSV (has commas and newlines)
  if (trimmed.includes(",") && trimmed.includes("\n")) {
    return "csv";
  }
  
  return null;
}

function parseCSV(input) {
  const lines = input.trim().split("\n");
  if (lines.length === 0) return [];
  
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"(.*)"$/, "$1"));
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim().replace(/^"(.*)"$/, "$1"));
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || "";
    }
    rows.push(row);
  }
  
  return rows;
}

async function sidekick_parse({ input, format }) {
  if (!input) {
    return { content: [{ type: "text", text: "input required" }], isError: true };
  }
  
  const detectedFormat = format || detectFormat(input);
  
  if (!detectedFormat) {
    return { content: [{ type: "text", text: "Could not detect format. Specify format: json, yaml, xml, ini, csv" }], isError: true };
  }
  
  try {
    let parsed;
    
    if (detectedFormat === "json") {
      parsed = JSON.parse(input);
    } else if (detectedFormat === "yaml") {
      parsed = YAML.parse(input);
    } else if (detectedFormat === "xml") {
      const parser = new XMLParser({ ignoreAttributes: false });
      parsed = parser.parse(input);
    } else if (detectedFormat === "ini") {
      parsed = INI.parse(input);
    } else if (detectedFormat === "csv") {
      parsed = parseCSV(input);
    } else {
      return { content: [{ type: "text", text: `Unsupported format: ${detectedFormat}` }], isError: true };
    }
    
    return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Parse error (${detectedFormat}): ${e.message}` }], isError: true };
  }
}

// --- Diff Tool ---

function diffText(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const changes = [];
  
  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    
    if (oldLine === undefined) {
      changes.push({ type: "added", line: i + 1, content: newLine });
    } else if (newLine === undefined) {
      changes.push({ type: "removed", line: i + 1, content: oldLine });
    } else if (oldLine !== newLine) {
      changes.push({ type: "modified", line: i + 1, oldContent: oldLine, newContent: newLine });
    }
  }
  
  return changes;
}

function diffJSON(oldObj, newObj, path = "") {
  const changes = [];
  
  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  
  for (const key of allKeys) {
    const currentPath = path ? `${path}.${key}` : key;
    const oldVal = oldObj?.[key];
    const newVal = newObj?.[key];
    
    if (oldVal === undefined) {
      changes.push({ type: "added", path: currentPath, value: newVal });
    } else if (newVal === undefined) {
      changes.push({ type: "removed", path: currentPath, value: oldVal });
    } else if (typeof oldVal === "object" && typeof newVal === "object" && oldVal !== null && newVal !== null) {
      // Recursively diff nested objects
      if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        // Array comparison
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes.push({ type: "modified", path: currentPath, oldValue: oldVal, newValue: newVal });
        }
      } else {
        // Object comparison
        changes.push(...diffJSON(oldVal, newVal, currentPath));
      }
    } else if (oldVal !== newVal) {
      changes.push({ type: "modified", path: currentPath, oldValue: oldVal, newValue: newVal });
    }
  }
  
  return changes;
}

function formatChanges(changes, format) {
  if (format === "summary") {
    const added = changes.filter(c => c.type === "added").length;
    const removed = changes.filter(c => c.type === "removed").length;
    const modified = changes.filter(c => c.type === "modified").length;
    return `Summary: ${added} added, ${removed} removed, ${modified} modified`;
  }
  
  if (format === "unified") {
    return changes.map(c => {
      if (c.type === "added") {
        return `+ ${c.path || `line ${c.line}`}: ${JSON.stringify(c.value || c.content)}`;
      } else if (c.type === "removed") {
        return `- ${c.path || `line ${c.line}`}: ${JSON.stringify(c.value || c.content)}`;
      } else if (c.type === "modified") {
        return `~ ${c.path || `line ${c.line}`}:\n- ${JSON.stringify(c.oldValue || c.oldContent)}\n+ ${JSON.stringify(c.newValue || c.newContent)}`;
      }
    }).join("\n");
  }
  
  // Default: structured JSON
  return JSON.stringify(changes, null, 2);
}

async function sidekick_diff({ old_text, new_text, format, type }) {
  if (!old_text || !new_text) {
    return { content: [{ type: "text", text: "old_text and new_text required" }], isError: true };
  }
  
  const diffType = type || "auto";
  const outputFormat = format || "unified";
  
  let changes;
  
  if (diffType === "text") {
    changes = diffText(old_text, new_text);
  } else if (diffType === "json") {
    try {
      const oldObj = JSON.parse(old_text);
      const newObj = JSON.parse(new_text);
      changes = diffJSON(oldObj, newObj);
    } catch (e) {
      return { content: [{ type: "text", text: `JSON parse error: ${e.message}` }], isError: true };
    }
  } else if (diffType === "yaml") {
    try {
      const oldObj = YAML.parse(old_text);
      const newObj = YAML.parse(new_text);
      changes = diffJSON(oldObj, newObj);
    } catch (e) {
      return { content: [{ type: "text", text: `YAML parse error: ${e.message}` }], isError: true };
    }
  } else {
    // Auto-detect
    const oldFormat = detectFormat(old_text);
    const newFormat = detectFormat(new_text);
    
    if (oldFormat === "json" && newFormat === "json") {
      try {
        const oldObj = JSON.parse(old_text);
        const newObj = JSON.parse(new_text);
        changes = diffJSON(oldObj, newObj);
      } catch (e) {
        return { content: [{ type: "text", text: `Auto-detect JSON parse error: ${e.message}` }], isError: true };
      }
    } else if ((oldFormat === "yaml" && newFormat === "yaml") || (oldFormat === "json" && newFormat === "yaml") || (oldFormat === "yaml" && newFormat === "json")) {
      try {
        const oldObj = oldFormat === "json" ? JSON.parse(old_text) : YAML.parse(old_text);
        const newObj = newFormat === "json" ? JSON.parse(new_text) : YAML.parse(new_text);
        changes = diffJSON(oldObj, newObj);
      } catch (e) {
        return { content: [{ type: "text", text: `Auto-detect YAML/JSON parse error: ${e.message}` }], isError: true };
      }
    } else {
      // Fall back to text diff
      changes = diffText(old_text, new_text);
    }
  }
  
  const output = formatChanges(changes, outputFormat);
  return { content: [{ type: "text", text: output }] };
}

// --- Hash Tool ---

async function sidekick_hash({ input, algorithm, verify, path: filePath }) {
  const algo = algorithm || "sha256";
  const validAlgorithms = ["md5", "sha1", "sha256", "sha512"];
  
  if (!validAlgorithms.includes(algo)) {
    return { content: [{ type: "text", text: `Invalid algorithm. Use: ${validAlgorithms.join(", ")}` }], isError: true };
  }
  
  let data;
  
  if (filePath) {
    const policyError = enforcePathPolicy(filePath, "read");
    if (policyError) return policyError;
    // Hash a file
    try {
      data = fs.readFileSync(filePath);
    } catch (e) {
      return { content: [{ type: "text", text: `File read error: ${e.message}` }], isError: true };
    }
  } else if (input) {
    // Hash input string
    data = Buffer.from(input, "utf-8");
  } else {
    return { content: [{ type: "text", text: "input or path required" }], isError: true };
  }
  
  const hash = crypto.createHash(algo).update(data).digest("hex");
  
  if (verify) {
    const matches = hash === verify.toLowerCase();
    return { content: [{ type: "text", text: matches ? `✓ Hash matches (${algo}: ${hash})` : `✗ Hash mismatch\nExpected: ${verify}\nActual:   ${hash}` }] };
  }
  
  return { content: [{ type: "text", text: `${algo.toUpperCase()}: ${hash}` }] };
}

// --- Validate Tool ---

const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, verbose: true });

async function sidekick_validate({ data, schema }) {
  if (!data || !schema) {
    return { content: [{ type: "text", text: "data and schema required" }], isError: true };
  }
  
  let parsedData, parsedSchema;
  
  try {
    // Try to parse data as JSON, otherwise use as-is
    parsedData = typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    parsedData = data;
  }
  
  try {
    parsedSchema = typeof schema === "string" ? JSON.parse(schema) : schema;
  } catch (e) {
    return { content: [{ type: "text", text: `Schema parse error: ${e.message}` }], isError: true };
  }
  
  try {
    const validate = ajv.compile(parsedSchema);
    const valid = validate(parsedData);
    
    if (valid) {
      return { content: [{ type: "text", text: "✓ Validation passed" }] };
    } else {
      const errors = validate.errors.map(e => ({
        path: e.instancePath || "/",
        message: e.message,
        params: e.params
      }));
      return { content: [{ type: "text", text: `✗ Validation failed:\n${JSON.stringify(errors, null, 2)}` }] };
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Validation error: ${e.message}` }], isError: true };
  }
}

// --- Template Tool ---

const Handlebars = require("handlebars");

async function sidekick_template({ template, data }) {
  if (!template) {
    return { content: [{ type: "text", text: "template required" }], isError: true };
  }
  
  let parsedData = {};
  
  if (data) {
    try {
      parsedData = typeof data === "string" ? JSON.parse(data) : data;
    } catch (e) {
      return { content: [{ type: "text", text: `Data parse error: ${e.message}` }], isError: true };
    }
  }
  
  try {
    const compiled = Handlebars.compile(template);
    const result = compiled(parsedData);
    return { content: [{ type: "text", text: result }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Template error: ${e.message}` }], isError: true };
  }
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

const EVOLVE_FILE = path.join(DATA_DIR, "evolve.json");
const MAX_PROPOSALS_PER_DAY = 10;
const CONFIDENCE_THRESHOLD = 70;
const AUTO_APDOCS_THRESHOLD = 90;
const SANDBOX_TIMEOUT = 120000;
const EVOLVE_RETENTION_DAYS = parseInt(process.env.SIDEKICK_EVOLVE_RETENTION_DAYS || "30", 10);
const EVOLVE_AUTO_CLEANUP_SIZE_THRESHOLD = 100 * 1024; // 100KB
const EVOLVE_AUTO_CLEANUP_COUNT_THRESHOLD = 50;

function loadEvolve() {
  if (!fs.existsSync(EVOLVE_FILE)) return { proposals: [], history: [], queue: [], docs: [] };
  try {
    const d = JSON.parse(fs.readFileSync(EVOLVE_FILE, "utf-8"));
    if (!d.queue) d.queue = [];
    if (!d.docs) d.docs = [];
    
    // Automatic cleanup if thresholds exceeded
    const fileSize = fs.statSync(EVOLVE_FILE).size;
    const proposalCount = d.proposals.length;
    
    if (fileSize > EVOLVE_AUTO_CLEANUP_SIZE_THRESHOLD || proposalCount > EVOLVE_AUTO_CLEANUP_COUNT_THRESHOLD) {
      const cleanupResult = evolveCleanup(d, false);
      if (cleanupResult.deleted > 0) {
        saveEvolve(d);
        console.log(`[Evolve] Auto-cleanup: deleted ${cleanupResult.deleted} old entries`);
      }
    }
    
    return d;
  } catch {
    return { proposals: [], history: [], queue: [], docs: [] };
  }
}

function evolveCleanup(evolve, confirm = false) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - EVOLVE_RETENTION_DAYS);
  const cutoffISO = cutoffDate.toISOString();
  
  // Find proposals to delete (not approved, older than retention period)
  const toDelete = evolve.proposals.filter(p => {
    if (p.status === "approved") return false; // Keep approved forever
    if (!p.created) return false;
    return p.created < cutoffISO;
  });
  
  // Find queue entries to delete (not pending, older than retention period)
  const queueToDelete = evolve.queue.filter(q => {
    if (q.status === "pending") return false;
    if (!q.added) return false;
    return q.added < cutoffISO;
  });
  
  if (!confirm) {
    // Preview mode
    return {
      deleted: toDelete.length + queueToDelete.length,
      proposals: toDelete.map(p => ({ id: p.id, status: p.status, created: p.created, title: p.title })),
      queue: queueToDelete.map(q => ({ id: q.id, status: q.status, added: q.added })),
      retentionDays: EVOLVE_RETENTION_DAYS,
      cutoffDate: cutoffISO
    };
  }
  
  // Actually delete
  const deletedIds = new Set(toDelete.map(p => p.id));
  evolve.proposals = evolve.proposals.filter(p => !deletedIds.has(p.id));
  
  const deletedQueueIds = new Set(queueToDelete.map(q => q.id));
  evolve.queue = evolve.queue.filter(q => !deletedQueueIds.has(q.id));
  
  return {
    deleted: toDelete.length + queueToDelete.length,
    proposalsDeleted: toDelete.length,
    queueDeleted: queueToDelete.length,
    retentionDays: EVOLVE_RETENTION_DAYS,
    cutoffDate: cutoffISO
  };
}

function saveEvolve(evolve) {
  fs.writeFileSync(EVOLVE_FILE, JSON.stringify(evolve, null, 2));
}

function analyzeToolUsage() {
  const logs = dbStore.readToolLogs(1000);
  if (!logs || logs.length === 0) return { patterns: [], suggestions: [] };
  try {
    const toolCounts = {};
    const toolSequences = [];
    for (let i = 0; i < logs.length; i++) {
      const tool = logs[i].n;
      toolCounts[tool] = (toolCounts[tool] || 0) + 1;
      if (i < logs.length - 1) toolSequences.push([logs[i].n, logs[i + 1].n].join(" -> "));
      if (i < logs.length - 2) toolSequences.push([logs[i].n, logs[i + 1].n, logs[i + 2].n].join(" -> "));
    }
    const seqCounts = {};
    for (const seq of toolSequences) seqCounts[seq] = (seqCounts[seq] || 0) + 1;
    const frequentSeqs = Object.entries(seqCounts).filter(([_, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const patterns = frequentSeqs.map(([seq, count]) => ({
      pattern: seq, count,
      suggestion: `Frequent pattern: ${seq} (${count}x). Consider creating a procedure.`
    }));
    return { patterns, toolCounts };
  } catch {
    return { patterns: [], suggestions: [] };
  }
}

async function evolveGenerateProposal(analysis) {
  const patternSummary = analysis.patterns.slice(0, 5).map(p => `${p.pattern} (${p.count}x)`).join("\n");
  const topTools = Object.entries(analysis.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t}: ${c}`).join("\n");
  const prompt = `You are an AI improvement system for a remote agent platform called Sidekick. Analyze these usage patterns and propose ONE concrete improvement.

Top tools by usage:
${topTools}

Frequent sequences:
${patternSummary}

Propose a specific, actionable improvement. Return JSON:
{"title": "short title", "description": "what to change and why", "type": "procedure|config|docs|workflow", "confidence": 0-100, "implementation": "step-by-step how to implement it"}

Be specific. Confidence should reflect how likely this improves efficiency. Return ONLY valid JSON.`;

  const result = await sidekick_llm({
    prompt,
    system: "You are a system improvement AI. Return only valid JSON. Be practical and specific.",
    temperature: 0.4
  });
  if (result.isError) return null;
  try {
    const text = result.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    return null;
  }
}

async function evolveSandboxTest(proposal) {
  const startTime = Date.now();
  const testResults = { passed: false, duration: 0, notes: "", checks: {} };

  if (proposal.implementation && typeof proposal.implementation !== 'string') {
    if (Array.isArray(proposal.implementation)) {
      proposal.implementation = proposal.implementation.map(step => 
        typeof step === "object" ? `${step.step || ""}. ${step.action || JSON.stringify(step)}` : String(step)
      ).join("\n");
    } else if (typeof proposal.implementation === 'object') {
      proposal.implementation = Object.entries(proposal.implementation)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
    } else {
      proposal.implementation = String(proposal.implementation);
    }
  }

  if (proposal.type === "docs") {
    testResults.checks.syntax = { passed: true, notes: "Docs change - no syntax to validate" };
    testResults.checks.safety = { passed: true, notes: "Documentation only, no execution risk" };
    testResults.checks.relevance = { passed: proposal.confidence >= CONFIDENCE_THRESHOLD, notes: `Confidence: ${proposal.confidence}` };
    testResults.passed = true;
    testResults.notes = "Documentation proposal - safe to apply directly";
    testResults.duration = Date.now() - startTime;
    return testResults;
  }

  if (proposal.type === "procedure") {
    try {
      const procCheck = await callTool("sidekick_teach", { action: "list" });
      testResults.checks.procedures_accessible = { passed: !procCheck.isError, notes: procCheck.content[0].text.substring(0, 100) };
    } catch (e) {
      testResults.checks.procedures_accessible = { passed: false, notes: e.message };
    }

    testResults.checks.syntax = { passed: !!proposal.implementation, notes: proposal.implementation ? "Has implementation steps" : "Missing implementation" };
    const dangerousMatch = proposal.implementation?.match(/rm\s+-rf|sudo|chmod|dd\s/);
    testResults.checks.safety = { passed: !dangerousMatch, notes: dangerousMatch ? `Dangerous command detected: ${dangerousMatch[0]}` : "No dangerous commands detected" };
    testResults.checks.confidence = { passed: proposal.confidence >= CONFIDENCE_THRESHOLD, notes: `Confidence ${proposal.confidence} ${proposal.confidence >= CONFIDENCE_THRESHOLD ? ">=" : "<"} ${CONFIDENCE_THRESHOLD}` };

    try {
      const sandboxResult = await callTool("sidekick_sandbox", {
        action: "exec",
        command: `echo "Testing proposal: ${proposal.title}" && echo "${(proposal.implementation || "").substring(0, 200)}"`,
        sandbox_name: `evolve-${Date.now()}`
      });
      testResults.checks.sandbox = { passed: !sandboxResult.isError, notes: sandboxResult.content[0].text.substring(0, 150) };
    } catch (e) {
      testResults.checks.sandbox = { passed: false, notes: e.message };
    }

    const allChecks = Object.values(testResults.checks);
    testResults.passed = allChecks.every(c => c.passed);
    testResults.notes = testResults.passed ? "All checks passed" : `Failed: ${allChecks.filter(c => !c.passed).map(c => c.notes).join("; ")}`;
    testResults.duration = Date.now() - startTime;
    return testResults;
  }

  testResults.checks.syntax = { passed: true, notes: "Generic proposal" };
  testResults.checks.confidence = { passed: proposal.confidence >= CONFIDENCE_THRESHOLD, notes: `Confidence: ${proposal.confidence}` };
  testResults.passed = proposal.confidence >= CONFIDENCE_THRESHOLD;
  testResults.notes = testResults.passed ? "Passed confidence threshold" : "Below confidence threshold";
  testResults.duration = Date.now() - startTime;
  return testResults;
}

async function evolveAutoApplyDocs(proposal) {
  const docsDir = "/home/sidekick/sidekick/docs";
  const filename = proposal.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50) + ".md";
  const filePath = `${docsDir}/${filename}`;
  const content = `# ${proposal.title}\n\n${proposal.description}\n\n## Implementation\n\n${proposal.implementation || "N/A"}\n\n---\n*Auto-applied by sidekick_evolve (confidence: ${proposal.confidence})*\n*Date: ${new Date().toISOString()}*\n`;

  try {
    await callTool("sidekick_write", { path: filePath, content });
    return { applied: true, path: filePath };
  } catch (e) {
    return { applied: false, error: e.message };
  }
}

async function evolveParseProcedureSteps(proposal) {
  const implementationText = typeof proposal.implementation === "string" 
    ? proposal.implementation 
    : JSON.stringify(proposal.implementation);
  
  const toolSchemas = `
Available tools and their parameters:
- sidekick_bash: { "command": "shell command to run" }
- sidekick_read: { "path": "absolute file path" }
- sidekick_write: { "path": "absolute file path", "content": "file content" }
- sidekick_list: { "path": "/home/sidekick" }
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

  const prompt = `Convert these procedure steps into structured tool calls.

Procedure: ${proposal.title}
Description: ${proposal.description}

Implementation steps:
${implementationText}

${toolSchemas}

CRITICAL REQUIREMENTS:
1. Use {{paramName}} syntax for ALL values that would vary between invocations (paths, commands, names, messages, etc.)
2. NEVER use hardcoded example values - make the procedure generic and reusable
3. Each unique variable should use a consistent parameter name across all steps
4. If a step is purely descriptive and cannot be implemented as a tool call, skip it

Example of GOOD parameterization:
[
  {"tool": "sidekick_read", "args": {"path": "{{file_path}}"}},
  {"tool": "sidekick_bash", "args": {"command": "wc -l {{file_path}}"}},
  {"tool": "sidekick_store", "args": {"key": "{{result_key}}", "value": "{{output}}"}}
]

Example of BAD (hardcoded values - DO NOT DO THIS):
[
  {"tool": "sidekick_read", "args": {"path": "/home/sidekick/script.sh"}},
  {"tool": "sidekick_bash", "args": {"command": "wc -l /home/sidekick/script.sh"}}
]

Return a JSON array where each element has "tool" and "args" properties.
Return ONLY the JSON array, no other text.`;

  const llmResult = await sidekick_llm({ 
    prompt, 
    system: "You are a helpful assistant that converts procedure descriptions into structured tool calls. Return only valid JSON arrays." 
  });
  
  if (llmResult.isError) {
    return { steps: [], error: llmResult.content[0].text };
  }
  
  try {
    const text = llmResult.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const steps = JSON.parse(jsonMatch[0]);
      if (Array.isArray(steps) && steps.length > 0) {
        return { steps, error: null };
      }
    }
    return { steps: [], error: "No valid steps found in LLM response" };
  } catch (e) {
    return { steps: [], error: `Failed to parse steps: ${e.message}` };
  }
}

async function evolveNotifyDiscord(message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return { notified: false, reason: "No DISCORD_WEBHOOK_URL set" };
  try {
    const result = await callTool("sidekick_notify", { channel: "discord", webhook_url: webhookUrl, message, title: "Evolve: Auto-applied Doc" });
    return { notified: !result.isError };
  } catch {
    return { notified: false, reason: "notify failed" };
  }
}

function evolveProcessQueue(evolve) {
  if (evolve.queue.length === 0) return null;
  const next = evolve.queue.find(p => p.status === "pending");
  return next || null;
}

async function sidekick_evolve({ action, id, proposal, approve, test, confirm }) {
  const evolve = loadEvolve();
  const now = new Date().toISOString();
  const today = now.split("T")[0];

  if (action === "analyze") {
    const analysis = analyzeToolUsage();
    if (analysis.patterns.length === 0) {
      return { content: [{ type: "text", text: "No frequent patterns detected yet. Continue using tools to build patterns." }] };
    }
    const generated = await evolveGenerateProposal(analysis);
    const report = analysis.patterns.map(p => `Pattern: ${p.pattern}\nCount: ${p.count}\nSuggestion: ${p.suggestion}`).join("\n\n");
    let output = `# Tool Usage Analysis\n\n${report}`;
    if (generated) {
      output += `\n\n## LLM-Generated Proposal\n\nTitle: ${generated.title}\nType: ${generated.type}\nConfidence: ${generated.confidence}\nDescription: ${generated.description}\nImplementation: ${generated.implementation}`;
    }
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "propose") {
    if (!proposal) {
      return { content: [{ type: "text", text: "proposal required" }], isError: true };
    }
    const todayProposals = evolve.proposals.filter(p => p.created.startsWith(today));
    if (todayProposals.length >= MAX_PROPOSALS_PER_DAY) {
      return { content: [{ type: "text", text: `Rate limit: max ${MAX_PROPOSALS_PER_DAY} proposals/day` }], isError: true };
    }

    const analysis = analyzeToolUsage();
    let llmProposal = null;
    if (proposal === "auto") {
      llmProposal = await evolveGenerateProposal(analysis);
      if (!llmProposal) {
        return { content: [{ type: "text", text: "LLM failed to generate proposal" }], isError: true };
      }
    }

    const newProposal = {
      id: generateId("prop"),
      proposal: llmProposal ? JSON.stringify(llmProposal) : proposal,
      type: llmProposal?.type || "workflow",
      title: llmProposal?.title || proposal.substring(0, 50),
      confidence: llmProposal?.confidence || 50,
      implementation: llmProposal?.implementation || null,
      status: "pending",
      created: now,
      testResults: null,
      autoGenerated: !!llmProposal
    };

    if (newProposal.confidence < CONFIDENCE_THRESHOLD) {
      newProposal.status = "rejected_low_confidence";
      newProposal.rejectedReason = `Confidence ${newProposal.confidence} below threshold ${CONFIDENCE_THRESHOLD}`;
    }

    evolve.proposals.push(newProposal);
    if (newProposal.status === "pending") {
      evolve.queue.push({ id: newProposal.id, status: "pending", added: now });
    }
    saveEvolve(evolve);

    return { content: [{ type: "text", text: `Proposal: ${newProposal.id}\nTitle: ${newProposal.title}\nType: ${newProposal.type}\nConfidence: ${newProposal.confidence}\nStatus: ${newProposal.status}${newProposal.status === "pending" ? "\nAdded to test queue" : ""}` }] };
  }

  if (action === "list") {
    if (evolve.proposals.length === 0) return { content: [{ type: "text", text: "No proposals yet" }] };
    const list = evolve.proposals.map(p =>
      `ID: ${p.id} | ${p.status} | conf:${p.confidence} | ${p.title || p.proposal.substring(0, 60)}`
    ).join("\n");
    const queueLen = evolve.queue.filter(q => q.status === "pending").length;
    return { content: [{ type: "text", text: `# Proposals (${evolve.proposals.length}) | Queue: ${queueLen} pending\n\n${list}` }] };
  }

  if (action === "test") {
    let target;
    if (id) {
      target = evolve.proposals.find(p => p.id === id);
    } else {
      const queued = evolveProcessQueue(evolve);
      if (queued) target = evolve.proposals.find(p => p.id === queued.id);
    }
    if (!target) return { content: [{ type: "text", text: id ? `Proposal not found: ${id}` : "No proposals in queue" }], isError: true };

    target.status = "testing";
    target.testStarted = now;
    saveEvolve(evolve);

    const testResults = await evolveSandboxTest(target);
    target.testResults = testResults;
    target.status = testResults.passed ? "tested" : "test_failed";
    target.testedAt = new Date().toISOString();

    const queueEntry = evolve.queue.find(q => q.id === target.id);
    if (queueEntry) queueEntry.status = target.status;
    saveEvolve(evolve);

    return { content: [{ type: "text", text: `Test: ${target.id}\nResult: ${testResults.passed ? "PASSED" : "FAILED"}\nDuration: ${testResults.duration}ms\nChecks:\n${Object.entries(testResults.checks).map(([k, v]) => `  ${k}: ${v.passed ? "PASS" : "FAIL"} - ${v.notes}`).join("\n")}` }] };
  }

  if (action === "approve") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const p = evolve.proposals.find(x => x.id === id);
    if (!p) return { content: [{ type: "text", text: `Proposal not found: ${id}` }], isError: true };
    if (p.status !== "tested") return { content: [{ type: "text", text: `Must be tested first (status: ${p.status})` }], isError: true };

    p.status = "approved";
    p.approvedAt = new Date().toISOString();
    evolve.history.push({ id: p.id, proposal: p.proposal, approvedAt: p.approvedAt, confidence: p.confidence });
    
    let implementationResult = null;
    if (p.type === "docs" && p.confidence >= AUTO_APDOCS_THRESHOLD) {
      implementationResult = await evolveAutoApplyDocs(p);
      p.autoApplied = true;
      p.autoAppliedAt = new Date().toISOString();
      p.autoAppliedPath = implementationResult.path || null;
    } else if (p.type === "procedure" && p.implementation) {
      const parsedSteps = await evolveParseProcedureSteps(p);
      if (parsedSteps.error) {
        implementationResult = { applied: false, error: parsedSteps.error };
      } else if (parsedSteps.steps.length === 0) {
        implementationResult = { applied: false, error: "No actionable steps found in implementation" };
      } else {
        const teachResult = await callTool("sidekick_teach", {
          action: "teach_procedure",
          name: p.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").substring(0, 50),
          description: p.description || p.title,
          steps: parsedSteps.steps
        });
        implementationResult = teachResult.isError ? { applied: false, error: teachResult.content[0].text } : { applied: true };
      }
      p.autoApplied = implementationResult.applied;
      p.autoAppliedAt = new Date().toISOString();
    }
    
    saveEvolve(evolve);
    
    let response = `Approved: ${id}`;
    if (implementationResult) {
      response += `\nAuto-implemented: ${implementationResult.applied ? "YES" : "NO"}`;
      if (implementationResult.path) response += `\nPath: ${implementationResult.path}`;
      if (implementationResult.error) response += `\nError: ${implementationResult.error}`;
    }
    return { content: [{ type: "text", text: response }] };
  }

  if (action === "reject") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const p = evolve.proposals.find(x => x.id === id);
    if (!p) return { content: [{ type: "text", text: `Proposal not found: ${id}` }], isError: true };
    p.status = "rejected";
    p.rejectedAt = new Date().toISOString();
    const qe = evolve.queue.find(q => q.id === id);
    if (qe) qe.status = "rejected";
    saveEvolve(evolve);
    return { content: [{ type: "text", text: `Rejected: ${id}` }] };
  }

  if (action === "report") {
    const stats = {
      total: evolve.proposals.length,
      pending: evolve.proposals.filter(p => p.status === "pending").length,
      tested: evolve.proposals.filter(p => p.status === "tested").length,
      approved: evolve.proposals.filter(p => p.status === "approved").length,
      rejected: evolve.proposals.filter(p => p.status === "rejected" || p.status === "rejected_low_confidence").length,
      test_failed: evolve.proposals.filter(p => p.status === "test_failed").length,
      queue_pending: evolve.queue.filter(q => q.status === "pending").length
    };
    const avgConf = evolve.proposals.length > 0 ? Math.round(evolve.proposals.reduce((s, p) => s + (p.confidence || 0), 0) / evolve.proposals.length) : 0;
    const recent = evolve.proposals.slice(-5).reverse().map(p =>
      `${p.id} | ${p.status} | conf:${p.confidence} | ${p.title || p.proposal.substring(0, 40)}`
    ).join("\n");
    return { content: [{ type: "text", text: `# Evolve Report\n\nTotal: ${stats.total} | Pending: ${stats.pending} | Tested: ${stats.tested} | Approved: ${stats.approved} | Rejected: ${stats.rejected} | Failed: ${stats.test_failed}\nQueue: ${stats.queue_pending} pending\nAvg confidence: ${avgConf}\n\n## Recent\n${recent}` }] };
  }

  if (action === "sync_docs") {
    const approved = evolve.proposals.filter(p => p.status === "approved" && p.type === "docs");
    const autoApplied = [];
    const notified = [];

    for (const p of approved) {
      if (p.confidence >= AUTO_APDOCS_THRESHOLD && !p.autoApplied) {
        const result = await evolveAutoApplyDocs(p);
        p.autoApplied = true;
        p.autoAppliedAt = new Date().toISOString();
        p.autoAppliedPath = result.path || null;
        if (result.applied) {
          autoApplied.push(p.id);
          const notif = await evolveNotifyDiscord(`Auto-applied doc: **${p.title}** (confidence: ${p.confidence})\nPath: \`${result.path}\``);
          if (notif.notified) notified.push(p.id);
        }
      }
    }
    saveEvolve(evolve);

    return { content: [{ type: "text", text: `# Doc Sync\n\nApproved docs proposals: ${approved.length}\nAuto-applied (conf >= ${AUTO_APDOCS_THRESHOLD}): ${autoApplied.length}\nDiscord notified: ${notified.length}\n${autoApplied.length > 0 ? `\nApplied:\n${autoApplied.map(id => `- ${id}`).join("\n")}` : ""}` }] };
  }

  if (action === "cleanup") {
    const confirmBool = confirm === true || confirm === "true";
    const result = evolveCleanup(evolve, confirmBool);
    
    if (confirmBool) {
      saveEvolve(evolve);
      return { content: [{ type: "text", text: `# Evolve Cleanup Complete\n\nDeleted ${result.deleted} entries (${result.proposalsDeleted} proposals, ${result.queueDeleted} queue entries)\nRetention: ${result.retentionDays} days\nCutoff: ${result.cutoffDate}` }] };
    } else {
      // Preview mode
      if (result.deleted === 0) {
        return { content: [{ type: "text", text: `# Evolve Cleanup Preview\n\nNo entries older than ${result.retentionDays} days (cutoff: ${result.cutoffDate})\nApproved proposals are kept forever.` }] };
      }
      
      let msg = `# Evolve Cleanup Preview\n\nWould delete ${result.deleted} entries (${result.proposals.length} proposals, ${result.queue.length} queue entries)\nRetention: ${result.retentionDays} days\nCutoff: ${result.cutoffDate}\nApproved proposals are kept forever.\n\n## Proposals to Delete\n`;
      msg += result.proposals.map(p => `- ${p.id} | ${p.status} | ${p.created} | ${p.title}`).join("\n");
      
      if (result.queue.length > 0) {
        msg += `\n\n## Queue Entries to Delete\n`;
        msg += result.queue.map(q => `- ${q.id} | ${q.status} | ${q.added}`).join("\n");
      }
      
      msg += `\n\nTo delete, run: sidekick_evolve action="cleanup" confirm=true`;
      
      return { content: [{ type: "text", text: msg }] };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: analyze, propose, list, test, approve, reject, report, sync_docs, cleanup" }], isError: true };
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

// --- Predict Tool ---

const PREDICT_FILE = path.join(DATA_DIR, "predict.json");

function loadPredict() {
  if (!fs.existsSync(PREDICT_FILE)) return { predictions: [], feedback: [] };
  try {
    return JSON.parse(fs.readFileSync(PREDICT_FILE, "utf-8"));
  } catch {
    return { predictions: [], feedback: [] };
  }
}

function savePredict(predict) {
  fs.writeFileSync(PREDICT_FILE, JSON.stringify(predict, null, 2));
}

function analyzeContextPatterns() {
  const CONTEXT_FILE = path.join(DATA_DIR, "context.json");
  if (!fs.existsSync(CONTEXT_FILE)) return [];
  
  try {
    const context = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf-8"));
    const patterns = [];
    
    // Analyze decision patterns
    if (context.decisions && context.decisions.length > 0) {
      const projectDecisions = {};
      for (const dec of context.decisions) {
        if (dec.project) {
          if (!projectDecisions[dec.project]) projectDecisions[dec.project] = [];
          projectDecisions[dec.project].push(dec);
        }
      }
      
      for (const [project, decisions] of Object.entries(projectDecisions)) {
        if (decisions.length >= 3) {
          patterns.push({
            type: "decision_pattern",
            project,
            count: decisions.length,
            prediction: `Project "${project}" has ${decisions.length} decisions. More decisions likely needed.`,
            confidence: 0.7
          });
        }
      }
    }
    
    // Analyze problem patterns
    if (context.problems && context.problems.length > 0) {
      const unresolved = context.problems.filter(p => !p.resolved);
      if (unresolved.length > 0) {
        patterns.push({
          type: "unresolved_problems",
          count: unresolved.length,
          prediction: `${unresolved.length} unresolved problems. Consider addressing these.`,
          confidence: 0.9
        });
      }
    }
    
    return patterns;
  } catch {
    return [];
  }
}

function analyzeToolPatterns() {
  const logs = dbStore.readToolLogs(1000);
  if (!logs || logs.length === 0) return [];
  
  try {
    const patterns = [];
    
    // Find most used tools
    const toolCounts = {};
    for (const log of logs) {
      toolCounts[log.n] = (toolCounts[log.n] || 0) + 1;
    }
    
    const topTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    if (topTools.length > 0) {
      patterns.push({
        type: "frequent_tools",
        tools: topTools,
        prediction: `Most used tools: ${topTools.map(([t, c]) => `${t} (${c})`).join(", ")}. These are critical to your workflow.`,
        confidence: 0.8
      });
    }
    
    // Find error patterns
    const errors = logs.filter(l => !l.ok);
    if (errors.length > logs.length * 0.1) {
      patterns.push({
        type: "error_rate",
        errorCount: errors.length,
        totalCount: logs.length,
        prediction: `Error rate: ${((errors.length / logs.length) * 100).toFixed(1)}%. Consider investigating frequent errors.`,
        confidence: 0.85
      });
    }
    
    return patterns;
  } catch {
    return [];
  }
}

async function sidekick_predict({ action, id, feedback, useful }) {
  const predict = loadPredict();
  const now = new Date().toISOString();
  
  if (action === "analyze") {
    const contextPatterns = analyzeContextPatterns();
    const toolPatterns = analyzeToolPatterns();
    
    const allPatterns = [...contextPatterns, ...toolPatterns];
    
    if (allPatterns.length === 0) {
      return { content: [{ type: "text", text: "No patterns detected yet. Continue using the system to build patterns." }] };
    }
    
    const predictions = allPatterns.map((p, idx) => ({
      id: generateId("pred"),
      ...p,
      created: now,
      feedback: null
    }));
    
    predict.predictions = predictions;
    savePredict(predict);
    
    const report = predictions.map(p => 
      `ID: ${p.id}\nType: ${p.type}\nConfidence: ${(p.confidence * 100).toFixed(0)}%\nPrediction: ${p.prediction}`
    ).join("\n\n");
    
    return { content: [{ type: "text", text: `# Predictions (${predictions.length})\n\n${report}` }] };
  }
  
  if (action === "list") {
    if (predict.predictions.length === 0) {
      return { content: [{ type: "text", text: "No predictions yet. Run 'analyze' first." }] };
    }
    
    const list = predict.predictions.map(p => 
      `ID: ${p.id}\nType: ${p.type}\nConfidence: ${(p.confidence * 100).toFixed(0)}%\nPrediction: ${p.prediction.substring(0, 100)}${p.prediction.length > 100 ? "..." : ""}\nFeedback: ${p.feedback || "none"}`
    ).join("\n\n");
    
    return { content: [{ type: "text", text: `# Predictions (${predict.predictions.length})\n\n${list}` }] };
  }
  
  if (action === "feedback") {
    if (!id || feedback === undefined) {
      return { content: [{ type: "text", text: "id and feedback (true/false) required" }], isError: true };
    }
    
    const prediction = predict.predictions.find(p => p.id === id);
    if (!prediction) {
      return { content: [{ type: "text", text: `Prediction not found: ${id}` }], isError: true };
    }
    
    prediction.feedback = feedback ? "useful" : "not_useful";
    prediction.feedbackAt = now;
    
    predict.feedback.push({
      predictionId: id,
      useful: feedback,
      timestamp: now
    });
    
    savePredict(predict);
    
    return { content: [{ type: "text", text: `Feedback recorded for ${id}: ${feedback ? "useful" : "not useful"}` }] };
  }
  
  if (action === "suggest") {
    const usefulPredictions = predict.predictions.filter(p => p.feedback === "useful");
    
    if (usefulPredictions.length === 0) {
      return { content: [{ type: "text", text: "No useful predictions yet. Provide feedback on predictions to improve suggestions." }] };
    }
    
    const suggestions = usefulPredictions.map(p => 
      `- ${p.prediction} (confidence: ${(p.confidence * 100).toFixed(0)}%)`
    ).join("\n");
    
    return { content: [{ type: "text", text: `# Suggestions Based on Past Predictions\n\n${suggestions}` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: analyze, list, feedback, suggest" }], isError: true };
}

// Debug tool implementation - uses persistent KV store for cross-session debugging
const DEBUG_SESSIONS = {};
const DEBUG_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours (for in-memory sessions)
const DEBUG_RETENTION_DAYS = 7; // For persistent storage

function loadDebugSessions() {
  const now = Date.now();
  for (const [id, session] of Object.entries(DEBUG_SESSIONS)) {
    if (now - session.started > DEBUG_TTL_MS) {
      delete DEBUG_SESSIONS[id];
    }
  }
}

function generateDebugKey(service, issue) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = (issue || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  return `debug:${service || 'unknown'}:${slug}_${date}`;
}

function getDebugEntries() {
  const allKV = dbStore.getAllKV();
  const entries = [];
  for (const [key, entry] of Object.entries(allKV)) {
    if (key.startsWith('debug:') && typeof entry === 'object' && entry !== null && 'value' in entry) {
      entries.push({ key, ...entry });
    }
  }
  return entries.sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

function isOlderThan7Days(dateStr) {
  const entryDate = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DEBUG_RETENTION_DAYS);
  return entryDate < cutoff;
}

async function sidekick_debug_tool({ action, session_name, key, value, service, issue, redact }) {
  loadDebugSessions();
  const now = Date.now();
  const shouldRedact = redact !== false; // Default to true
  
  // --- Persistent storage actions (new) ---
  
  if (action === "store") {
    if (!service) {
      return { content: [{ type: "text", text: "service parameter required" }], isError: true };
    }
    if (!value) {
      return { content: [{ type: "text", text: "value parameter required" }], isError: true };
    }
    
    const debugKey = generateDebugKey(service, issue);
    const nowISO = new Date().toISOString();
    
    const storedValue = shouldRedact ? redactSensitive(value) : value;
    
    dbStore.setKV(debugKey, storedValue, "debug", currentSource, "debug");
    return { content: [{ type: "text", text: `Stored debug finding: ${debugKey} (${storedValue.length} chars)` }] };
  }
  
  if (action === "recall") {
    const entries = getDebugEntries();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DEBUG_RETENTION_DAYS);
    
    const recent = entries.filter(e => !isOlderThan7Days(e.updated));
    const old = entries.filter(e => isOlderThan7Days(e.updated));
    
    // Filter by service if provided
    const filtered = service 
      ? recent.filter(e => e.service === service)
      : recent;
    
    if (filtered.length === 0) {
      let msg = "No recent debug findings";
      if (service) msg += ` for service: ${service}`;
      return { content: [{ type: "text", text: msg }] };
    }
    
    let result = `# Debug Findings (last ${DEBUG_RETENTION_DAYS} days)\n\n`;
    result += filtered.map(e => {
      const age = Math.round((now - new Date(e.updated)) / 1000 / 60 / 60);
      return `## ${e.key}\n- Service: ${e.service}\n- Issue: ${e.issue}\n- Updated: ${age}h ago\n- Value: ${e.value}\n`;
    }).join("\n");
    
    if (old.length > 0) {
      result += `\n---\n**Note:** Found ${old.length} debug entries older than ${DEBUG_RETENTION_DAYS} days. Run cleanup with: sidekick_debug_tool action="cleanup"`;
    }
    
    return { content: [{ type: "text", text: result }] };
  }
  
  if (action === "cleanup") {
    // If key parameter provided, delete that specific entry (regardless of age)
    if (key && key !== "all") {
      const entry = dbStore.getKV(key);
      if (entry && key.startsWith('debug:')) {
        dbStore.deleteKV(key);
        return { content: [{ type: "text", text: `Deleted: ${key}` }] };
      }
      return { content: [{ type: "text", text: `Key not found or not a debug entry: ${key}` }], isError: true };
    }
    
    const entries = getDebugEntries();
    const old = entries.filter(e => isOlderThan7Days(e.updated));
    
    if (old.length === 0) {
      return { content: [{ type: "text", text: "No debug entries older than " + DEBUG_RETENTION_DAYS + " days" }] };
    }
    
    // List old entries for review
    let result = `# Debug Entries Older Than ${DEBUG_RETENTION_DAYS} Days\n\n`;
    result += old.map(e => {
      const age = Math.round((now - new Date(e.updated)) / 1000 / 60 / 60 / 24);
      return `- **${e.key}** (${age} days old)\n  - Service: ${e.service}, Issue: ${e.issue}\n  - Delete with: sidekick_debug_tool action="cleanup" key="${e.key}"`;
    }).join("\n\n");
    
    result += `\n\nTo delete all old entries, use: sidekick_debug_tool action="cleanup" key="all"`;
    
    return { content: [{ type: "text", text: result }] };
  }
  
  // Special case: delete all old entries
  if (action === "cleanup" && key === "all") {
    const entries = getDebugEntries();
    const old = entries.filter(e => isOlderThan7Days(e.updated));
    let deleted = 0;
    for (const e of old) {
      dbStore.deleteKV(e.key);
      deleted++;
    }
    return { content: [{ type: "text", text: `Deleted ${deleted} old debug entries` }] };
  }
  
  // --- Legacy in-memory session actions (backward compatibility) ---
  
  if (action === "start") {
    const sessionId = session_name || `debug_${Date.now()}`;
    DEBUG_SESSIONS[sessionId] = {
      started: now,
      cache: {},
      name: session_name || sessionId
    };
    return { content: [{ type: "text", text: `Debug session started: ${sessionId}\nTTL: 8 hours\n\nNote: For cross-session persistence, use action="store" instead.` }] };
  }
  
  if (action === "stop") {
    const sessionId = session_name || Object.keys(DEBUG_SESSIONS).pop();
    if (!DEBUG_SESSIONS[sessionId]) {
      return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }
    delete DEBUG_SESSIONS[sessionId];
    return { content: [{ type: "text", text: `Debug session stopped: ${sessionId}` }] };
  }
  
  if (action === "cache") {
    const sessionId = session_name || Object.keys(DEBUG_SESSIONS).pop();
    if (!DEBUG_SESSIONS[sessionId]) {
      return { content: [{ type: "text", text: `No active session. Start one with action="start"` }], isError: true };
    }
    if (!key || value === undefined) {
      return { content: [{ type: "text", text: `key and value required` }], isError: true };
    }
    DEBUG_SESSIONS[sessionId].cache[key] = {
      value: value,
      cached_at: new Date().toISOString()
    };
    return { content: [{ type: "text", text: `Cached: ${key} (${String(value).length} chars)` }] };
  }
  
  if (action === "get") {
    const sessionId = session_name || Object.keys(DEBUG_SESSIONS).pop();
    if (!DEBUG_SESSIONS[sessionId]) {
      return { content: [{ type: "text", text: `No active session` }], isError: true };
    }
    if (!key) {
      return { content: [{ type: "text", text: `key required` }], isError: true };
    }
    const cached = DEBUG_SESSIONS[sessionId].cache[key];
    if (!cached) {
      return { content: [{ type: "text", text: `Key not found in session: ${key}` }], isError: true };
    }
    return { content: [{ type: "text", text: cached.value }] };
  }
  
  if (action === "status") {
    if (Object.keys(DEBUG_SESSIONS).length === 0) {
      return { content: [{ type: "text", text: `No active debug sessions` }] };
    }
    const sessions = Object.entries(DEBUG_SESSIONS).map(([id, s]) => {
      const age = Math.round((now - s.started) / 1000 / 60);
      const cacheSize = Object.keys(s.cache).length;
      return `${id}: ${cacheSize} items, ${age}min old`;
    }).join("\n");
    return { content: [{ type: "text", text: `Active sessions:\n${sessions}` }] };
  }
  
  if (action === "clear") {
    const sessionId = session_name;
    if (sessionId) {
      if (!DEBUG_SESSIONS[sessionId]) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
      }
      delete DEBUG_SESSIONS[sessionId];
      return { content: [{ type: "text", text: `Cleared session: ${sessionId}` }] };
    } else {
      const count = Object.keys(DEBUG_SESSIONS).length;
      for (const id of Object.keys(DEBUG_SESSIONS)) {
        delete DEBUG_SESSIONS[id];
      }
      return { content: [{ type: "text", text: `Cleared ${count} sessions` }] };
    }
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: store, recall, cleanup (persistent) or start, stop, cache, get, status, clear (session)" }], isError: true };
}

// FreshEyes tool implementation
async function sidekick_fresheyes({ problem, context, files, hypotheses, full_response }) {
  let prompt = `You are analyzing a problem with fresh eyes. Provide a clear, independent analysis.

Problem: ${problem}

`;
  
  if (context) {
    prompt += `Context:\n${context}\n\n`;
  }
  
  if (files && files.length > 0) {
    prompt += `Files analyzed:\n${files.map(f => `- ${f}`).join("\n")}\n\n`;
  }
  
  if (hypotheses && hypotheses.length > 0) {
    prompt += `Current hypotheses:\n${hypotheses.map(h => `- ${h}`).join("\n")}\n\n`;
  }
  
  prompt += `Provide your analysis:
1. What do you think is the root cause?
2. What approach would you take to solve it?
3. Are there any blind spots or assumptions in the current thinking?`;
  
  const sanitizedPrompt = redactSensitive(prompt);
  
  try {
    const result = await sidekick_llm({
      prompt: sanitizedPrompt,
      system: "You are a senior engineer providing a fresh perspective on a problem. Be direct and analytical. Focus on key insights, not verbose explanations.",
      temperature: 0.3
    });
    
    if (full_response) {
      return result;
    }
    
    const response = result.content?.[0]?.text || "";
    const insights = response.split("\n").filter(line => 
      line.trim().length > 0 && 
      (line.includes("root cause") || line.includes("approach") || line.includes("blind spot") || line.match(/^\d+\./))
    ).slice(0, 10).join("\n");
    
    return { content: [{ type: "text", text: insights || response.substring(0, 500) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error calling LLM: ${e.message}` }], isError: true };
  }
}

// --- Token-efficient tools (v1.17) ---

const sessionCache = new Map();

function parseDuration(str) {
  if (!str) return 300000;
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 300000;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * (multipliers[unit] || 60000);
}

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
    if (!call.tool || !TOOLS[call.tool]) {
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

async function sidekick_cache({ action, key, ttl, value }) {
  const now = Date.now();
  
  // Try Redis first
  let useRedis = false;
  try {
    const conn = await redisStore.testConnection();
    useRedis = conn.connected;
  } catch (e) {
    useRedis = false;
  }
  
  if (action === "clear") {
    if (useRedis) {
      if (key) {
        await redisStore.del(`cache:${key}`);
        return { content: [{ type: "text", text: "Cleared cache: " + key + " (redis)" }] };
      }
      const keys = await redisStore.keys("cache:*");
      if (keys.length > 0) {
        await Promise.all(keys.map(k => redisStore.del(k)));
      }
      return { content: [{ type: "text", text: "Cleared " + keys.length + " cache entries (redis)" }] };
    }
    // Fallback to in-memory
    if (key) {
      sessionCache.delete(key);
      return { content: [{ type: "text", text: "Cleared cache: " + key }] };
    }
    const count = sessionCache.size;
    sessionCache.clear();
    return { content: [{ type: "text", text: "Cleared " + count + " cache entries" }] };
  }
  
  if (action === "list") {
    if (useRedis) {
      const keys = await redisStore.keys("cache:*");
      const entries = [];
      for (const k of keys) {
        const ttlVal = await redisStore.ttl(k);
        const cacheKey = k.replace("cache:", "");
        entries.push({ key: cacheKey, expires_in_seconds: ttlVal > 0 ? ttlVal : null });
      }
      return { content: [{ type: "text", text: JSON.stringify(entries) }] };
    }
    // Fallback to in-memory
    const entries = [];
    for (const [k, v] of sessionCache) {
      entries.push({ key: k, expires_in_ms: v.expires - now, size: v.value.length });
    }
    return { content: [{ type: "text", text: JSON.stringify(entries) }] };
  }
  
  if (action === "get") {
    if (!key) return { content: [{ type: "text", text: "key required" }], isError: true };
    if (useRedis) {
      const val = await redisStore.get(`cache:${key}`);
      if (val === null) {
        return { content: [{ type: "text", text: "Cache miss: " + key }], isError: true };
      }
      return { content: [{ type: "text", text: redactSensitive(val) }] };
    }
    // Fallback to in-memory
    const entry = sessionCache.get(key);
    if (!entry || entry.expires < now) {
      if (entry) sessionCache.delete(key);
      return { content: [{ type: "text", text: "Cache miss: " + key }], isError: true };
    }
    return { content: [{ type: "text", text: redactSensitive(entry.value) }] };
  }
  
  if (action === "set") {
    if (!key || value === undefined) return { content: [{ type: "text", text: "key and value required" }], isError: true };
    const duration = parseDuration(ttl);
    const ttlSeconds = Math.ceil(duration / 1000);
    if (useRedis) {
      await redisStore.set(`cache:${key}`, String(value), ttlSeconds);
      return { content: [{ type: "text", text: "Cached " + key + " (TTL: " + ttl + ", redis)" }] };
    }
    // Fallback to in-memory
    sessionCache.set(key, { value: String(value), expires: now + duration });
    return { content: [{ type: "text", text: "Cached " + key + " (TTL: " + ttl + ")" }] };
  }
  
  return { content: [{ type: "text", text: "Invalid action. Use: get, set, clear, list" }], isError: true };
}

async function sidekick_summarize({ path: filePath, max_lines, strategy, pattern }) {
  const maxLines = max_lines || 50;
  const strat = strategy || "head";
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 50 * 1024 * 1024) {
    return { content: [{ type: "text", text: "File too large to summarize (>50MB): " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  let summary;
  if (strat === "head") {
    summary = lines.slice(0, maxLines).join("\n");
  } else if (strat === "tail") {
    summary = lines.slice(-maxLines).join("\n");
  } else if (strat === "grep") {
    if (!pattern) return { content: [{ type: "text", text: "pattern required for grep strategy" }], isError: true };
    const re = new RegExp(pattern, "i");
    const matched = [];
    for (let i = 0; i < lines.length && matched.length < maxLines; i++) {
      if (re.test(lines[i])) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 2);
        for (let j = start; j < end; j++) {
          if (!matched.includes(lines[j])) matched.push(lines[j]);
        }
      }
    }
    summary = matched.join("\n");
  } else if (strat === "stats") {
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    summary = [
      "File: " + filePath,
      "Size: " + stat.size + " bytes",
      "Total lines: " + lines.length,
      "Non-empty lines: " + nonEmpty.length,
      "First line: " + (lines[0] || "(empty)"),
      "Last line: " + (lines[lines.length - 1] || "(empty)")
    ].join("\n");
  } else {
    return { content: [{ type: "text", text: "Invalid strategy. Use: head, tail, grep, stats" }], isError: true };
  }
  const header = "[Summary: " + lines.length + " lines, strategy=" + strat + (strat === "grep" ? ", pattern=" + pattern : "") + "]\n";
  return { content: [{ type: "text", text: redactSensitive(header + summary) }] };
}

async function sidekick_filter({ path: targetPath, pattern, after, before, max_results }) {
  const maxResults = max_results || 50;
  const policyError = enforcePathPolicy(targetPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(targetPath)) {
    return { content: [{ type: "text", text: "Path not found: " + targetPath }], isError: true };
  }
  const stat = fs.statSync(targetPath);
  const results = [];
  if (stat.isFile()) {
    const content = fs.readFileSync(targetPath, "utf-8");
    const lines = content.split("\n");
    const re = pattern ? new RegExp(pattern, "i") : null;
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (!re || re.test(lines[i])) {
        results.push({ line: i + 1, text: lines[i].substring(0, 200) });
      }
    }
  } else if (stat.isDirectory()) {
    const afterDate = after ? new Date(after).getTime() : 0;
    const beforeDate = before ? new Date(before).getTime() : Infinity;
    const re = pattern ? new RegExp(pattern, "i") : null;
    function walkDir(dir, depth) {
      if (depth > 5 || results.length >= maxResults) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = path.join(dir, entry.name);
        try {
          const s = fs.statSync(fullPath);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
              walkDir(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            if (s.mtimeMs >= afterDate && s.mtimeMs <= beforeDate) {
              if (!re || re.test(entry.name)) {
                results.push({
                  path: fullPath,
                  size: s.size,
                  modified: s.mtime.toISOString().slice(0, 19)
                });
              }
            }
          }
        } catch (e) {}
      }
    }
    walkDir(targetPath, 0);
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
    const ctx = loadContext();
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

async function sidekick_memory_export({ project, type, include_disabled, automatic_only }) {
  const options = {};
  if (project) options.project = project;
  if (type) options.type = type;
  if (include_disabled === false) options.includeDisabled = false;
  if (automatic_only === true) options.automatic = true;

  const result = dbStore.exportMemories(options);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function sidekick_memory_import({ data, on_conflict, preserve_ids }) {
  let parsed;
  try {
    parsed = typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    return { content: [{ type: "text", text: "Invalid JSON: " + e.message }], isError: true };
  }

  const options = {
    onConflict: on_conflict || "merge",
    preserveIds: preserve_ids === true
  };

  const result = dbStore.importMemories(parsed, options);
  const summary = `Import complete: ${result.imported} imported, ${result.updated || 0} updated, ${result.skipped} skipped`;
  const errors = result.errors?.length ? `\nErrors: ${result.errors.join(", ")}` : "";
  return { content: [{ type: "text", text: summary + errors }] };
}

async function sidekick_memory_manage({ action, id, confirmed_by, days, reason, limit, project }) {
  if (action === "confirm") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const legacy = findContextItemById(loadContext(), id, "all");
    if (legacy) {
      return { content: [{ type: "text", text: `Unsupported memory id for confirm: ${id} is a legacy context ${legacy.type}. Use delete, disable, expire, or restore for legacy context entries.` }], isError: true };
    }
    const success = dbStore.confirmMemory(id, confirmed_by || "user");
    return { content: [{ type: "text", text: success ? `Memory ${id} confirmed` : `Memory not found: ${id}` }], isError: !success };
  }
  
  if (action === "set_requires_confirmation") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const legacy = findContextItemById(loadContext(), id, "all");
    if (legacy) {
      return { content: [{ type: "text", text: `Unsupported memory id for set_requires_confirmation: ${id} is a legacy context ${legacy.type}. Structured memories only support confirmation requirements.` }], isError: true };
    }
    const requires = reason !== "false";
    const success = dbStore.setMemoryRequiresConfirmation(id, requires);
    return { content: [{ type: "text", text: success ? `Memory ${id} requires_confirmation set to ${requires}` : `Memory not found: ${id}` }], isError: !success };
  }
  
  if (action === "delete") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const success = dbStore.softDeleteMemory(id, reason || "user_deleted");
    if (success) return { content: [{ type: "text", text: `Memory ${id} soft-deleted` }] };
    const legacy = updateLegacyContextItem(id, "delete", reason || "user_deleted");
    if (legacy.supported) return { content: [{ type: "text", text: `Legacy context ${legacy.type} ${id} soft-deleted` }] };
    return { content: [{ type: "text", text: `Memory or context id not found: ${id}` }], isError: true };
  }

  if (action === "disable") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const success = dbStore.disableMemory(id);
    if (success) return { content: [{ type: "text", text: `Memory ${id} disabled` }] };
    const legacy = updateLegacyContextItem(id, "disable", reason || "user_disabled");
    if (legacy.supported) return { content: [{ type: "text", text: `Legacy context ${legacy.type} ${id} disabled` }] };
    return { content: [{ type: "text", text: `Memory or context id not found: ${id}` }], isError: true };
  }
  
  if (action === "expire") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const success = dbStore.expireMemory(id, reason || "manual_expire");
    if (success) return { content: [{ type: "text", text: `Memory ${id} expired` }] };
    const legacy = updateLegacyContextItem(id, "expire", reason || "manual_expire");
    if (legacy.supported) return { content: [{ type: "text", text: `Legacy context ${legacy.type} ${id} expired` }] };
    return { content: [{ type: "text", text: `Memory or context id not found: ${id}` }], isError: true };
  }
  
  if (action === "restore") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const success = dbStore.restoreMemory(id);
    if (success) return { content: [{ type: "text", text: `Memory ${id} restored` }] };
    const legacy = updateLegacyContextItem(id, "restore");
    if (legacy.supported) return { content: [{ type: "text", text: `Legacy context ${legacy.type} ${id} restored` }] };
    return { content: [{ type: "text", text: `Memory or context id not found: ${id}` }], isError: true };
  }
  
  if (action === "set_auto_expire") {
    if (!id || !days) return { content: [{ type: "text", text: "id and days required" }], isError: true };
    const legacy = findContextItemById(loadContext(), id, "all");
    if (legacy) {
      return { content: [{ type: "text", text: `Unsupported memory id for set_auto_expire: ${id} is a legacy context ${legacy.type}. Structured memories only support auto-expiration.` }], isError: true };
    }
    const success = dbStore.setAutoExpire(id, days);
    return { content: [{ type: "text", text: success ? `Memory ${id} will expire in ${days} days` : `Memory not found: ${id}` }], isError: !success };
  }
  
  if (action === "list_by_state") {
    if (!id) return { content: [{ type: "text", text: "state required (passed as id param)" }], isError: true };
    const memories = dbStore.getMemoriesByState(id, { limit: limit || 50, project });
    return { content: [{ type: "text", text: JSON.stringify({ count: memories.length, memories }, null, 2) }] };
  }
  
  if (action === "pending_confirmations") {
    const memories = dbStore.getPendingConfirmations({ limit: limit || 50 });
    return { content: [{ type: "text", text: JSON.stringify({ count: memories.length, memories }, null, 2) }] };
  }
  
  if (action === "process_auto_expirations") {
    const result = dbStore.processAutoExpirations();
    return { content: [{ type: "text", text: `Processed auto-expirations: ${result.expired} memories expired` }] };
  }
  
  return { content: [{ type: "text", text: "Invalid action. Use: confirm, set_requires_confirmation, delete, disable, expire, restore, set_auto_expire, list_by_state, pending_confirmations, process_auto_expirations" }], isError: true };
}

async function sidekick_sync_identity({ action, user_id }) {
  if (action === "get") {
    const machineId = dbStore.getMachineId();
    const userId = dbStore.getUserId();
    return { content: [{ type: "text", text: JSON.stringify({ machine_id: machineId, user_id: userId }) }] };
  }
  
  if (action === "set_user") {
    if (!user_id) {
      return { content: [{ type: "text", text: "user_id required" }], isError: true };
    }
    dbStore.setUserId(user_id);
    return { content: [{ type: "text", text: `User ID set to: ${user_id}` }] };
  }
  
  return { content: [{ type: "text", text: "Invalid action. Use 'get' or 'set_user'" }], isError: true };
}

async function sidekick_sync_export({ project, since, include_disabled }) {
  const options = {};
  if (project) options.project = project;
  if (since) options.since = since;
  if (include_disabled === false) options.includeDisabled = false;
  
  const data = dbStore.exportForSync(options);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function sidekick_sync_import({ data, strategy, preserve_ids }) {
  let parsed;
  try {
    parsed = typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    return { content: [{ type: "text", text: "Invalid JSON: " + e.message }], isError: true };
  }
  
  const options = {
    strategy: strategy || "newest",
    preserveIds: preserve_ids === true
  };
  
  const result = dbStore.importFromSync(parsed, options);
  const summary = `Sync complete: ${result.imported} imported, ${result.conflicts} conflicts resolved, ${result.skipped} skipped`;
  const errors = result.errors?.length ? `\nErrors: ${result.errors.join(", ")}` : "";
  return { content: [{ type: "text", text: summary + errors }] };
}

async function sidekick_sync_diff({ since }) {
  if (!since) {
    return { content: [{ type: "text", text: "since parameter required (ISO timestamp)" }], isError: true };
  }
  
  const diff = dbStore.getSyncDiff(since);
  return { content: [{ type: "text", text: JSON.stringify(diff, null, 2) }] };
}

async function sidekick_tail({ source, pattern, lines, since }) {
  const maxLines = lines || 50;
  const re = pattern ? new RegExp(pattern, "i") : null;
  let content;
  if (source === "log.jsonl" || source === "log") {
    let parsed = dbStore.readToolLogs(1000);
    let filtered = parsed;
    if (since) {
      const sinceDate = new Date(since).getTime();
      filtered = parsed.filter(l => new Date(l.t).getTime() >= sinceDate);
    }
    if (re) {
      filtered = filtered.filter(l => re.test(l.n) || re.test(l.s) || re.test(l.a));
    }
    content = filtered.slice(-maxLines).map(l =>
      l.t.slice(11, 19) + " [" + (l.ok ? "OK" : "ERR") + "] " + l.n + ": " + l.s
    ).join("\n");
  } else if (source === "journalctl") {
    try {
      const svc = pattern || "sidekick-mcp";
      const stdout = execFileSync("journalctl", ["-u", svc, "-n", String(maxLines), "--no-pager"], {
        timeout: 10000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024
      });
      content = stdout;
    } catch (e) {
      content = e.stdout || e.message;
    }
  } else {
    const policyError = enforcePathPolicy(source, "read");
    if (policyError) return policyError;
    if (!fs.existsSync(source)) {
      return { content: [{ type: "text", text: "File not found: " + source }], isError: true };
    }
    const allLines = fs.readFileSync(source, "utf-8").split("\n");
    let filtered = allLines;
    if (re) filtered = allLines.filter(l => re.test(l));
    content = filtered.slice(-maxLines).join("\n");
  }
  return { content: [{ type: "text", text: redactSensitive(content || "(no matching entries)") }] };
}

async function sidekick_diff_files({ path_a, path_b, format }) {
  const policyErrorA = enforcePathPolicy(path_a, "read");
  if (policyErrorA) return policyErrorA;
  const policyErrorB = enforcePathPolicy(path_b, "read");
  if (policyErrorB) return policyErrorB;
  if (!fs.existsSync(path_a)) return { content: [{ type: "text", text: "File not found: " + path_a }], isError: true };
  if (!fs.existsSync(path_b)) return { content: [{ type: "text", text: "File not found: " + path_b }], isError: true };
  const contentA = fs.readFileSync(path_a, "utf-8");
  const contentB = fs.readFileSync(path_b, "utf-8");
  if (format === "summary") {
    const linesA = contentA.split("\n");
    const linesB = contentB.split("\n");
    let added = 0, removed = 0, changed = 0;
    const maxLen = Math.max(linesA.length, linesB.length);
    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i] || "";
      const b = linesB[i] || "";
      if (a === b) continue;
      if (i >= linesA.length) added++;
      else if (i >= linesB.length) removed++;
      else changed++;
    }
    return { content: [{ type: "text", text: JSON.stringify({
      file_a: path_a, file_b: path_b,
      lines_a: linesA.length, lines_b: linesB.length,
      added, removed, changed
    }) }] };
  }
  const linesA = contentA.split("\n");
  const linesB = contentB.split("\n");
  const diffLines = [];
  const maxLen = Math.max(linesA.length, linesB.length);
  let diffCount = 0;
  for (let i = 0; i < maxLen && diffCount < 100; i++) {
    const a = linesA[i];
    const b = linesB[i];
    if (a !== b) {
      diffCount++;
      if (a !== undefined) diffLines.push("- " + (i + 1) + ": " + a.substring(0, 200));
      if (b !== undefined) diffLines.push("+ " + (i + 1) + ": " + b.substring(0, 200));
    }
  }
  const header = "--- " + path_a + "\n+++ " + path_b + "\n";
  return { content: [{ type: "text", text: redactSensitive(header + diffLines.join("\n")) }] };
}

async function sidekick_find({ path: searchPath, name, modified_after, modified_before, size_min, size_max, content, max_results }) {
  const maxResults = max_results || 50;
  const policyError = enforcePathPolicy(searchPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(searchPath)) {
    return { content: [{ type: "text", text: "Path not found: " + searchPath }], isError: true };
  }
  const afterMs = modified_after ? new Date(modified_after).getTime() : 0;
  const beforeMs = modified_before ? new Date(modified_before).getTime() : Infinity;
  const sizeMin = size_min ? parseSize(size_min) : 0;
  const sizeMax = size_max ? parseSize(size_max) : Infinity;
  const nameRe = name ? new RegExp("^" + name.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
  const contentRe = content ? new RegExp(content, "i") : null;
  const results = [];
  function walk(dir, depth) {
    if (depth > 8 || results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const s = fs.statSync(fullPath);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          if (nameRe && !nameRe.test(entry.name)) continue;
          if (s.mtimeMs < afterMs || s.mtimeMs > beforeMs) continue;
          if (s.size < sizeMin || s.size > sizeMax) continue;
          if (contentRe) {
            try {
              const fileContent = fs.readFileSync(fullPath, "utf-8").substring(0, 1024 * 1024);
              if (!contentRe.test(fileContent)) continue;
            } catch (e) { continue; }
          }
          results.push({
            path: fullPath,
            size: s.size,
            modified: s.mtime.toISOString().slice(0, 19)
          });
        }
      } catch (e) {}
    }
  }
  walk(searchPath, 0);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

function parseSize(str) {
  if (typeof str === "number") return str;
  const match = String(str).match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] || "B").toUpperCase();
  const multipliers = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
  return Math.floor(val * (multipliers[unit] || 1));
}

async function sidekick_status({ include, services }) {
  const sections = (include || "services,disk").split(",").map(s => s.trim());
  const output = {};
  if (sections.includes("services")) {
    const svcList = (services || "sidekick-mcp,sidekick-dashboard,sidekick-agent").split(",").map(s => s.trim());
    output.services = {};
    for (const svc of svcList) {
      try {
        const stdout = execFileSync("systemctl", ["is-active", svc], { timeout: 5000, encoding: "utf-8" }).trim();
        output.services[svc] = stdout;
      } catch (e) {
        output.services[svc] = (e.stdout || "unknown").trim();
      }
    }
  }
  if (sections.includes("disk")) {
    try {
      const stdout = execFileSync("df", ["-h", "--output=target,size,used,avail,pcent", "/"], {
        timeout: 5000, encoding: "utf-8"
      }).trim();
      const lines = stdout.split("\n");
      if (lines.length > 1) {
        const parts = lines[1].trim().split(/\s+/);
        output.disk = { mount: parts[0], size: parts[1], used: parts[2], avail: parts[3], pct: parts[4] };
      }
    } catch (e) { output.disk = { error: e.message }; }
  }
  if (sections.includes("memory")) {
    try {
      const stdout = execFileSync("free", ["-h"], { timeout: 5000, encoding: "utf-8" }).trim();
      const lines = stdout.split("\n");
      if (lines.length > 1) {
        const parts = lines[1].trim().split(/\s+/);
        output.memory = { total: parts[1], used: parts[2], free: parts[3] };
      }
    } catch (e) { output.memory = { error: e.message }; }
  }
  if (sections.includes("load")) {
    try {
      const stdout = fs.readFileSync("/proc/loadavg", "utf-8").trim();
      const parts = stdout.split(/\s+/);
      output.load = { "1m": parts[0], "5m": parts[1], "15m": parts[2] };
    } catch (e) { output.load = { error: e.message }; }
  }
  if (sections.includes("uptime")) {
    try {
      const stdout = execFileSync("uptime", ["-p"], { timeout: 5000, encoding: "utf-8" }).trim();
      output.uptime = stdout;
    } catch (e) { output.uptime = { error: e.message }; }
  }
  if (sections.includes("processes")) {
    try {
      const stdout = execFileSync("ps", ["aux", "--sort=-%cpu"], { timeout: 5000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
      const lines = stdout.trim().split("\n").slice(0, 11);
      output.processes_top = lines.slice(1).map(l => {
        const p = l.trim().split(/\s+/);
        return { user: p[0], pid: p[1], cpu: p[2], mem: p[3], cmd: p.slice(10).join(" ").substring(0, 80) };
      });
    } catch (e) { output.processes_top = []; }
  }
  output.timestamp = new Date().toISOString();
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

const SIDEKICK_SERVICES = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"];
const SIDEKICK_DEPLOY_REPO_PATH = "/home/sidekick/sidekick";

function defaultRepoPath(repoPath) {
  return repoPath || process.env.SIDEKICK_REPO_DIR || path.join(__dirname, "..");
}

function deployScriptPath(repoPath) {
  return path.join(repoPath, "scripts", "git-deploy.js");
}

function parseOpsJson(result) {
  if (!result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return null;
  }
}

function runOpsCommand(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      timeout: options.timeout || 30000,
      encoding: "utf-8",
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      cwd: options.cwd
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || "").trim(),
      stderr: String(e.stderr || e.message || "").trim(),
      status: e.status
    };
  }
}

function runOpsCommandAsync(command, args, options = {}) {
  return new Promise(resolve => {
    execFile(command, args, {
      timeout: options.timeout || 30000,
      encoding: "utf-8",
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      cwd: options.cwd
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || error?.message || "").trim(),
        status: error?.code
      });
    });
  });
}

function getGitValue(repoPath, args) {
  const result = runOpsCommand("git", ["-C", repoPath, ...args], { timeout: 60000 });
  return result.ok ? result.stdout : null;
}

function getServiceStates(services = SIDEKICK_SERVICES) {
  const states = {};
  for (const service of services) {
    const result = runOpsCommand("systemctl", ["is-active", service], { timeout: 5000 });
    states[service] = result.ok ? result.stdout : (result.stdout || "unknown");
  }
  return states;
}

function allServicesActive(states) {
  return Object.values(states).every(state => state === "active");
}

function filterGitStatus(statusText) {
  return (statusText || "")
    .split("\n")
    .map(line => line.trimEnd())
    .filter(Boolean)
    .filter(line => !line.endsWith(" package-lock.json") && line !== "?? package-lock.json")
    .join("\n");
}

function formatOpsReport(title, rows, details = []) {
  const body = rows.map(([key, value]) => `${key}: ${value}`).join("\n");
  const detailText = details.filter(Boolean).join("\n\n");
  return `${title}\n${body}${detailText ? "\n\n" + detailText : ""}`;
}

function scheduleMcpRestart(delaySeconds = 2) {
  const child = spawn("sh", ["-c", `sleep ${Number(delaySeconds) || 2}; sudo systemctl restart sidekick-mcp`], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
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
    deploy: { tool: "sidekick_ops", args: { action: "deploy_current_main", repo_path: options.repo_path } },
    verify_deploy: { tool: "sidekick_ops", args: { action: "verify_deployed_commit", repo_path: options.repo_path } },
    status: { tool: "sidekick_status", args: { include: options.include || "services,disk,memory,load,uptime", services: options.services } },
    logs: { tool: "sidekick_log_query", args: { limit: options.limit || 20, tool: options.tool, source: options.source } },
    tools: { tool: "sidekick_tools", args: { action: options.query ? "search" : "overview", query: options.query, format: options.format || "text" } },
    policy: { tool: "sidekick_tools", args: { action: "policy", name: options.tool, source: options.source, format: options.format || "text", limit: options.limit } },
    project: { tool: "sidekick_project", args: { name: options.project || "sidekick", include: options.include || "kv,context" } },
    delete_key: { tool: "sidekick_delete", args: { key: options.key } }
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
      ? "No deterministic route matched. Use sidekick_tools action=search or a narrower tool."
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
      route.route === "unknown" ? "Clarify intent or use sidekick_tools search." : "Intent mapped deterministically.",
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

async function sidekick_ops({ action, repo_path, restart_mcp }) {
  const repoPath = repo_path || SIDEKICK_DEPLOY_REPO_PATH;
  if (repoPath !== SIDEKICK_DEPLOY_REPO_PATH) {
    return { content: [{ type: "text", text: `sidekick_ops deployments are restricted to ${SIDEKICK_DEPLOY_REPO_PATH}` }], isError: true };
  }
  const pathPolicyError = enforcePathPolicy(repoPath, action === "deploy_current_main" ? "write" : "read");
  if (pathPolicyError) return pathPolicyError;

  if (action === "verify_deployed_commit") {
    const script = deployScriptPath(repoPath);
    if (!fs.existsSync(script)) return { content: [{ type: "text", text: "Deployment helper not found: " + script }], isError: true };
    const verify = runOpsCommand("node", [script, "verify"], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    const parsed = parseOpsJson(verify);
    const ok = verify.ok && parsed?.status === "ok";

    return {
      content: [{
        type: "text",
        text: JSON.stringify(parsed || { status: "failed", error: verify.stderr || verify.stdout || "verify failed" }, null, 2)
      }],
      isError: !ok
    };
  }

  if (action === "restart_and_smoke_test") {
    const restarted = [];
    for (const service of ["sidekick-dashboard", "sidekick-agent"]) {
      const result = runOpsCommand("sudo", ["systemctl", "restart", service], { timeout: 30000 });
      restarted.push([service, result.ok ? "restarted" : "failed"]);
    }

    const states = getServiceStates();
    // This tool runs inside sidekick-mcp. Use an asynchronous child process so
    // the event loop remains free to answer its own /health request.
    const health = await runOpsCommandAsync(
      "curl",
      ["--max-time", "5", "-fsS", "http://127.0.0.1:4097/health"],
      { timeout: 7000 }
    );
    let mcpNote = "not requested";
    if (restart_mcp === true) {
      scheduleMcpRestart();
      mcpNote = "scheduled after response; next MCP call may reconnect";
    }

    const serviceOk = restarted.every(([, state]) => state === "restarted") && allServicesActive(states);
    const healthOk = health.ok;
    return {
      content: [{
        type: "text",
        text: formatOpsReport("RESTART SMOKE TEST", [
          ["RESULT", serviceOk ? (healthOk ? "passed" : "passed with warnings") : "failed"],
          ["MCP restart", mcpNote],
          ["MCP health", healthOk ? "passed" : "warning"],
          ["Services", allServicesActive(states) ? "all active" : "attention needed"],
          ["Action needed", serviceOk && healthOk ? "none" : (serviceOk ? "check MCP endpoint behavior" : "review output")]
        ], [
          "Restart results:\n" + restarted.map(([svc, state]) => `${svc}: ${state}`).join("\n"),
          "Service states:\n" + Object.entries(states).map(([svc, state]) => `${svc}: ${state}`).join("\n"),
          health.ok ? null : `MCP probe warning:\n${health.stdout || health.stderr || "no response"}`
        ])
      }],
      isError: !serviceOk
    };
  }

  if (action === "deploy_current_main") {
    const script = deployScriptPath(repoPath);
    if (!fs.existsSync(script)) return { content: [{ type: "text", text: "Deployment helper not found: " + script }], isError: true };
    const deployResult = runOpsCommand("node", [script, "deploy"], { timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
    const parsed = parseOpsJson(deployResult);
    const ok = deployResult.ok && parsed?.status === "ok";
    if (ok) scheduleMcpRestart();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(parsed || { status: "failed", error: deployResult.stderr || deployResult.stdout || "deploy failed" }, null, 2)
      }],
      isError: !ok
    };
  }

  if (action === "incident_snapshot") {
    const states = getServiceStates();
    const status = await sidekick_status({ include: "services,disk,memory,load,uptime,processes" });
    const logs = {};
    for (const service of SIDEKICK_SERVICES) {
      const result = runOpsCommand("journalctl", ["-u", service, "-n", "25", "--no-pager"], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      logs[service] = result.ok ? result.stdout : (result.stderr || result.stdout || "unavailable");
    }
    const git = fs.existsSync(repoPath) ? {
      head: getGitValue(repoPath, ["rev-parse", "HEAD"]),
      status: filterGitStatus(getGitValue(repoPath, ["status", "--short"]) || "")
    } : { head: "repo not found", status: "" };
    const ok = allServicesActive(states);

    return {
      content: [{
        type: "text",
        text: formatOpsReport("INCIDENT SNAPSHOT", [
          ["RESULT", ok ? "captured" : "captured with service issues"],
          ["Services", ok ? "all active" : "attention needed"],
          ["HEAD", git.head || "unknown"],
          ["Dirty files", git.status ? "yes" : "none"],
          ["Action needed", ok ? "review logs if symptoms persist" : "review service states and logs"]
        ], [
          "Status:\n" + status.content[0].text,
          git.status ? "Git status:\n" + git.status : "Git status: clean",
          "Recent logs:\n" + Object.entries(logs).map(([svc, text]) => `--- ${svc} ---\n${text}`).join("\n\n")
        ])
      }],
      isError: !ok
    };
  }

  return { content: [{ type: "text", text: "Invalid action. Use: verify_deployed_commit, restart_and_smoke_test, deploy_current_main, incident_snapshot" }], isError: true };
}

async function sidekick_extract({ path: filePath, fields }) {
  if (!filePath) return { content: [{ type: "text", text: "path required" }], isError: true };
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  let data;
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".json") {
      data = JSON.parse(content);
    } else if (ext === ".yaml" || ext === ".yml") {
      const yaml = require("yaml");
      data = yaml.parse(content);
    } else if (ext === ".ini" || ext === ".cfg") {
      const ini = require("ini");
      data = ini.parse(content);
    } else if (ext === ".xml") {
      const { XMLParser } = require("fast-xml-parser");
      const parser = new XMLParser();
      data = parser.parse(content);
    } else {
      data = JSON.parse(content);
    }
  } catch (e) {
    return { content: [{ type: "text", text: "Parse error: " + e.message }], isError: true };
  }
  if (!fields) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
  const fieldList = Array.isArray(fields) ? fields : fields.split(",").map(f => f.trim());
  const result = {};
  for (const fieldPath of fieldList) {
    const parts = fieldPath.replace(/\[(\d+)\]/g, ".$1").split(".");
    let val = data;
    for (const part of parts) {
      if (val === null || val === undefined) { val = undefined; break; }
      val = val[part];
    }
    result[fieldPath] = val !== undefined ? (typeof val === "object" ? JSON.stringify(val) : String(val)) : null;
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

const ANONYMIZE_PATTERNS_FILE = path.join(DATA_DIR, "anonymize_patterns.json");
const MAX_ANONYMIZE_INPUT_SIZE = 1024 * 1024;

function loadAnonymizePatterns() {
  try {
    if (fs.existsSync(ANONYMIZE_PATTERNS_FILE)) {
      return JSON.parse(fs.readFileSync(ANONYMIZE_PATTERNS_FILE, "utf8"));
    }
  } catch {}
  return { patterns: [] };
}

function saveAnonymizePatterns(data) {
  fs.writeFileSync(ANONYMIZE_PATTERNS_FILE, JSON.stringify(data, null, 2));
}

function buildConsistencyMap() {
  return {
    emails: new Map(),
    ips: new Map(),
    hostnames: new Map(),
    paths: new Map(),
    uuids: new Map(),
    phones: new Map(),
    names: new Map(),
    _counters: { email: 0, ip: 0, host: 0, path: 0, uuid: 0, phone: 0, name: 0 }
  };
}

function getOrAssign(map, key, counter, generator) {
  if (map.has(key)) return map.get(key);
  const val = generator(counter.value);
  counter.value++;
  map.set(key, val);
  return val;
}

function anonymizeText(text, consistency, customPatterns) {
  if (!text || typeof text !== "string") return text;
  
  if (text.length > MAX_ANONYMIZE_INPUT_SIZE) {
    return `[ANONYMIZE ERROR: Input exceeds maximum size of ${MAX_ANONYMIZE_INPUT_SIZE} bytes (${text.length} bytes)]`;
  }

  const cmap = buildConsistencyMap();
  let result = text;

  const uuidCounter = { value: 1 };
  result = result.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (match) => {
    if (consistency) {
      return getOrAssign(cmap.uuids, match.toLowerCase(), uuidCounter, (n) => 
        `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
      );
    }
    return `00000000-0000-0000-0000-${String(Math.floor(Math.random() * 999999999999)).padStart(12, "0")}`;
  });

  const ipCounter = { value: 1 };
  result = result.replace(/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, (match) => {
    if (match === "127.0.0.1" || match === "0.0.0.0" || match === "255.255.255.255") return match;
    if (consistency) {
      return getOrAssign(cmap.ips, match, ipCounter, (n) => `10.0.0.${n}`);
    }
    return `10.0.0.${Math.floor(Math.random() * 254) + 1}`;
  });

  const emailCounter = { value: 1 };
  result = result.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, (match) => {
    if (match.endsWith("@example.com") || match.endsWith("@localhost")) return match;
    if (consistency) {
      return getOrAssign(cmap.emails, match.toLowerCase(), emailCounter, (n) => `user${n}@example.com`);
    }
    return `user${Math.floor(Math.random() * 9999) + 1}@example.com`;
  });

  const phoneCounter = { value: 1 };
  result = result.replace(/(?<!\d[-\d])(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b(?!\d)/g, (match) => {
    if (consistency) {
      return getOrAssign(cmap.phones, match.replace(/\D/g, ""), phoneCounter, (n) => 
        `555-000-${String(n).padStart(4, "0")}`
      );
    }
    return `555-000-${String(Math.floor(Math.random() * 9999)).padStart(4, "0")}`;
  });

  const SYSTEM_USERS = ["sidekick", "root", "nobody", "admin", "www-data", "nginx", "apache", "mysql", "postgres", "redis", "daemon", "bin", "sys", "sync", "games", "man", "mail", "news", "proxy", "backup", "list", "irc", "gnats", "systemd", "messagebus", "sshd", "ntp", "avahi", "colord", "hplp", "pollinate", "landscape", "ubuntu"];
  const pathCounter = { value: 1 };
  result = result.replace(/\/(?:home|Users)\/([a-zA-Z0-9_\-]+)(?:\/[^\s]*)?/g, (match, userPart) => {
    if (SYSTEM_USERS.includes(userPart.toLowerCase())) return match;
    if (consistency) {
      const replacement = getOrAssign(cmap.paths, userPart, pathCounter, (n) => `user${n}`);
      return match.replace(`/${userPart}`, `/${replacement}`);
    }
    const replacement = `user${Math.floor(Math.random() * 99) + 1}`;
    return match.replace(`/${userPart}`, `/${replacement}`);
  });

  const hostnameCounter = { value: 1 };
  result = result.replace(/\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+(?:com|org|net|io|dev|app|local|internal)\b/g, (match) => {
    if (match === "example.com" || match === "localhost" || match.endsWith(".example.com")) return match;
    if (consistency) {
      return getOrAssign(cmap.hostnames, match.toLowerCase(), hostnameCounter, (n) => `host-${n}.internal`);
    }
    return `host-${Math.floor(Math.random() * 999) + 1}.internal`;
  });

  if (customPatterns && customPatterns.length > 0) {
    for (const cp of customPatterns) {
      try {
        const regex = new RegExp(cp.pattern, "g");
        result = result.replace(regex, cp.replacement);
      } catch {}
    }
  }

  const stored = loadAnonymizePatterns();
  for (const sp of stored.patterns) {
    try {
      const regex = new RegExp(sp.pattern, "g");
      result = result.replace(regex, sp.replacement);
    } catch {}
  }

  result = redactSensitive(result);

  return result;
}

async function sidekick_anonymize({ action, input, format, custom_patterns, consistency }) {
  if (action === "patterns") {
    const stored = loadAnonymizePatterns();
    if (stored.patterns.length === 0) {
      return { content: [{ type: "text", text: "No custom patterns defined.\n\nBuilt-in patterns:\n- IPv4 addresses → 10.0.0.x\n- Email addresses → user{n}@example.com\n- UUIDs → 00000000-0000-0000-0000-{n}\n- Phone numbers → 555-000-XXXX\n- File paths (/home/user, /Users/user) → /home/user{n}\n- Hostnames (*.com, *.org, etc.) → host-{n}.internal\n- SSH private keys → [REDACTED]\n- GitHub tokens → [REDACTED]\n- API keys → [REDACTED]\n- AWS keys → [REDACTED]\n- Passwords/secrets → [REDACTED]\n- Bearer tokens → [REDACTED]\n- Database connection strings → [REDACTED]\n- Stripe keys → [REDACTED]\n- JWT tokens → [REDACTED]" }] };
    }
    const list = stored.patterns.map((p, i) => `${i + 1}. Pattern: ${p.pattern}\n   Replacement: ${p.replacement}`).join("\n\n");
    return { content: [{ type: "text", text: `Custom patterns (${stored.patterns.length}):\n\n${list}` }] };
  }

  if (action === "add_pattern") {
    if (!custom_patterns || custom_patterns.length === 0) {
      return { content: [{ type: "text", text: "custom_patterns required (array of {pattern, replacement})" }], isError: true };
    }
    const stored = loadAnonymizePatterns();
    let added = 0;
    for (const cp of custom_patterns) {
      if (!cp.pattern || !cp.replacement) continue;
      try {
        new RegExp(cp.pattern);
      } catch (e) {
        return { content: [{ type: "text", text: `Invalid regex pattern: ${cp.pattern} (${e.message})` }], isError: true };
      }
      stored.patterns.push({ pattern: cp.pattern, replacement: cp.replacement, added: new Date().toISOString() });
      added++;
    }
    saveAnonymizePatterns(stored);
    return { content: [{ type: "text", text: `Added ${added} custom pattern(s). Total: ${stored.patterns.length}` }] };
  }

  if (action === "remove_pattern") {
    if (!custom_patterns || custom_patterns.length === 0) {
      return { content: [{ type: "text", text: "custom_patterns required with pattern field to remove" }], isError: true };
    }
    const stored = loadAnonymizePatterns();
    const before = stored.patterns.length;
    const toRemove = custom_patterns.map(cp => cp.pattern);
    stored.patterns = stored.patterns.filter(p => !toRemove.includes(p.pattern));
    const removed = before - stored.patterns.length;
    saveAnonymizePatterns(stored);
    return { content: [{ type: "text", text: `Removed ${removed} pattern(s). Remaining: ${stored.patterns.length}` }] };
  }

  if (action === "anonymize") {
    if (input === undefined || input === null) {
      return { content: [{ type: "text", text: "input required" }], isError: true };
    }

    const useConsistency = consistency !== false;
    let result = anonymizeText(input, useConsistency, custom_patterns);

    if (format === "json") {
      try {
        const parsed = JSON.parse(result);
        result = JSON.stringify(parsed, null, 2);
      } catch {}
    } else if (format === "yaml") {
      try {
        const yaml = require("yaml");
        const parsed = JSON.parse(result);
        result = yaml.stringify(parsed);
      } catch {}
    }

    const stats = {
      original_size: input.length,
      anonymized_size: result.length,
      consistency: useConsistency
    };

    return { content: [{ type: "text", text: `${result}\n\n--- Anonymization Stats ---\n${JSON.stringify(stats, null, 2)}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: anonymize, patterns, add_pattern, remove_pattern" }], isError: true };
}

const SANDBOX_FILE = path.join(DATA_DIR, "sandbox.json");
const SANDBOX_DIR = path.join(DATA_DIR, "sandboxes");
const MAX_ACTIVE_SANDBOXES = 5;
const MAX_ROLLBACKS_PER_SANDBOX = 50;
const SANDBOX_TTL_HOURS = 24;
const MAX_BACKUP_FILE_SIZE = 10 * 1024 * 1024;

fs.mkdirSync(SANDBOX_DIR, { recursive: true });

function loadSandboxes() {
  try {
    if (fs.existsSync(SANDBOX_FILE)) {
      return JSON.parse(fs.readFileSync(SANDBOX_FILE, "utf8"));
    }
  } catch {}
  return { sandboxes: {} };
}

function saveSandboxes(data) {
  fs.writeFileSync(SANDBOX_FILE, JSON.stringify(data, null, 2));
}

function purgeExpiredSandboxes(data) {
  const now = Date.now();
  const ttlMs = SANDBOX_TTL_HOURS * 60 * 60 * 1000;
  let purged = 0;
  for (const [id, sb] of Object.entries(data.sandboxes)) {
    if (now - sb.created > ttlMs) {
      const sbPath = path.join(SANDBOX_DIR, id);
      try { fs.rmSync(sbPath, { recursive: true, force: true }); } catch {}
      delete data.sandboxes[id];
      purged++;
    }
  }
  return purged;
}

function generateSandboxId() {
  return "sb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function sidekick_sandbox({ action, sandbox_name, command, files, auto_backup, rollback_id }) {
  const data = loadSandboxes();
  purgeExpiredSandboxes(data);

  if (action === "list") {
    const entries = Object.entries(data.sandboxes);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No active sandboxes" }] };
    }
    const list = entries.map(([id, sb]) => {
      const age = Math.round((Date.now() - sb.created) / 1000 / 60);
      return `${id} (${sb.name || "unnamed"}): ${sb.operations.length} ops, ${age}min old, ${sb.backups.length} backups`;
    }).join("\n");
    return { content: [{ type: "text", text: `Active sandboxes (${entries.length}/${MAX_ACTIVE_SANDBOXES}):\n\n${list}` }] };
  }

  if (action === "exec") {
    if (!command) {
      return { content: [{ type: "text", text: "command required" }], isError: true };
    }

    const name = sandbox_name || `sandbox_${Date.now()}`;
    let sbId = null;
    for (const [id, sb] of Object.entries(data.sandboxes)) {
      if (sb.name === name) { sbId = id; break; }
    }

    if (!sbId) {
      if (Object.keys(data.sandboxes).length >= MAX_ACTIVE_SANDBOXES) {
        return { content: [{ type: "text", text: `Max active sandboxes reached (${MAX_ACTIVE_SANDBOXES}). Clean up with action="clean" or wait for TTL expiry.` }], isError: true };
      }
      sbId = generateSandboxId();
      data.sandboxes[sbId] = {
        name,
        created: Date.now(),
        operations: [],
        backups: [],
        newFiles: []
      };
    }

    const sb = data.sandboxes[sbId];
    if (sb.operations.length >= MAX_ROLLBACKS_PER_SANDBOX) {
      return { content: [{ type: "text", text: `Max operations reached for this sandbox (${MAX_ROLLBACKS_PER_SANDBOX}). Create a new sandbox or clean this one.` }], isError: true };
    }

    const sbPath = path.join(SANDBOX_DIR, sbId);
    fs.mkdirSync(sbPath, { recursive: true });

    const filesToBackup = files || [];
    const backedUp = [];
    const skipped = [];

    if (auto_backup !== false && filesToBackup.length > 0) {
      for (const f of filesToBackup) {
        try {
          const readPolicyError = enforcePathPolicy(f, "read");
          if (readPolicyError) return readPolicyError;
          const writePolicyError = enforcePathPolicy(f, "write");
          if (writePolicyError) return writePolicyError;
          const stat = fs.statSync(f);
          if (!stat.isFile()) continue;
          if (stat.size > MAX_BACKUP_FILE_SIZE) {
            skipped.push({ file: f, reason: `exceeds ${MAX_BACKUP_FILE_SIZE} bytes` });
            continue;
          }
          const relPath = f.replace(/^\//, "").replace(/\//g, "_");
          const backupPath = path.join(sbPath, `backup_${sb.operations.length}_${relPath}`);
          fs.copyFileSync(f, backupPath);
          sb.backups.push({ original: f, backup: backupPath, size: stat.size, timestamp: Date.now() });
          backedUp.push(f);
        } catch (e) {
          if (e.code === "ENOENT") {
            sb.newFiles.push({ path: f, opIndex: sb.operations.length });
          }
        }
      }
    }

    const opRecord = {
      index: sb.operations.length,
      command,
      timestamp: Date.now(),
      backedUp,
      skipped
    };

    let output = "";
    let exitCode = 0;
    try {
      output = execSync(command, { timeout: 30000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      output = (e.stdout || "") + (e.stderr || "");
      exitCode = e.status || 1;
    }

    opRecord.exitCode = exitCode;
    opRecord.output = output.substring(0, 5000);
    sb.operations.push(opRecord);
    saveSandboxes(data);

    const summary = [
      `Sandbox: ${sbId} (${sb.name})`,
      `Command: ${command}`,
      `Exit: ${exitCode}`,
      `Backed up: ${backedUp.length} file(s)${backedUp.length > 0 ? " [" + backedUp.join(", ") + "]" : ""}`,
      skipped.length > 0 ? `Skipped: ${skipped.length} file(s) ${JSON.stringify(skipped)}` : "",
      `Operations: ${sb.operations.length}/${MAX_ROLLBACKS_PER_SANDBOX}`,
      "",
      output.substring(0, 2000)
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "rollback") {
    let targetId = rollback_id;
    
    if (!targetId && sandbox_name) {
      for (const [id, sb] of Object.entries(data.sandboxes)) {
        if (sb.name === sandbox_name) {
          targetId = id;
          break;
        }
      }
    }
    
    if (!targetId) {
      const entries = Object.entries(data.sandboxes);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No active sandboxes to rollback" }], isError: true };
      }
      targetId = entries[entries.length - 1][0];
    }

    const sb = data.sandboxes[targetId];
    if (!sb) {
      return { content: [{ type: "text", text: `Sandbox not found: ${targetId}` }], isError: true };
    }

    if (sb.backups.length === 0 && sb.newFiles.length === 0) {
      return { content: [{ type: "text", text: `No backups to rollback for sandbox ${targetId}` }] };
    }

    const restored = [];
    const removed = [];
    const errors = [];

    for (const backup of sb.backups) {
      const policyError = enforcePathPolicy(backup.original, "write");
      if (policyError) return policyError;
    }
    for (const nf of sb.newFiles) {
      const policyError = enforcePathPolicy(nf.path, "delete");
      if (policyError) return policyError;
    }

    for (const backup of sb.backups.reverse()) {
      try {
        fs.copyFileSync(backup.backup, backup.original);
        restored.push(backup.original);
      } catch (e) {
        errors.push({ file: backup.original, error: e.message });
      }
    }

    for (const nf of sb.newFiles.reverse()) {
      try {
        if (fs.existsSync(nf.path)) {
          fs.unlinkSync(nf.path);
          removed.push(nf.path);
        }
      } catch (e) {
        errors.push({ file: nf.path, error: e.message });
      }
    }

    sb.backups = [];
    sb.newFiles = [];
    saveSandboxes(data);

    const summary = [
      `Rollback complete for sandbox: ${targetId} (${sb.name})`,
      `Restored: ${restored.length} file(s)${restored.length > 0 ? " [" + restored.join(", ") + "]" : ""}`,
      `Removed: ${removed.length} new file(s)${removed.length > 0 ? " [" + removed.join(", ") + "]" : ""}`,
      errors.length > 0 ? `Errors: ${JSON.stringify(errors)}` : ""
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "diff") {
    let targetId = sandbox_name;
    if (!targetId) {
      return { content: [{ type: "text", text: "sandbox_name required for diff" }], isError: true };
    }
    
    for (const [id, sb] of Object.entries(data.sandboxes)) {
      if (sb.name === sandbox_name) {
        targetId = id;
        break;
      }
    }

    const sb = data.sandboxes[targetId];
    if (!sb) {
      return { content: [{ type: "text", text: `Sandbox not found: ${targetId}` }], isError: true };
    }

    if (sb.operations.length === 0) {
      return { content: [{ type: "text", text: `No operations recorded for sandbox ${targetId}` }] };
    }

    const diffs = sb.operations.map((op, i) => {
      return [
        `--- Operation ${op.index} ---`,
        `Command: ${op.command}`,
        `Time: ${new Date(op.timestamp).toISOString()}`,
        `Exit: ${op.exitCode}`,
        `Backed up: ${op.backedUp.join(", ") || "none"}`,
        op.output ? `Output:\n${op.output.substring(0, 500)}` : ""
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    return { content: [{ type: "text", text: `Sandbox: ${targetId} (${sb.name})\nOperations: ${sb.operations.length}\n\n${diffs}` }] };
  }

  if (action === "clean") {
    let targetId = sandbox_name;
    if (targetId) {
      for (const [id, sb] of Object.entries(data.sandboxes)) {
        if (sb.name === sandbox_name) {
          targetId = id;
          break;
        }
      }
      
      if (!data.sandboxes[targetId]) {
        return { content: [{ type: "text", text: `Sandbox not found: ${targetId}` }], isError: true };
      }
      const sbPath = path.join(SANDBOX_DIR, targetId);
      try { fs.rmSync(sbPath, { recursive: true, force: true }); } catch {}
      delete data.sandboxes[targetId];
      saveSandboxes(data);
      return { content: [{ type: "text", text: `Cleaned sandbox: ${targetId}` }] };
    } else {
      const count = Object.keys(data.sandboxes).length;
      for (const id of Object.keys(data.sandboxes)) {
        const sbPath = path.join(SANDBOX_DIR, id);
        try { fs.rmSync(sbPath, { recursive: true, force: true }); } catch {}
      }
      data.sandboxes = {};
      saveSandboxes(data);
      return { content: [{ type: "text", text: `Cleaned ${count} sandbox(es)` }] };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: exec, rollback, list, diff, clean" }], isError: true };
}

const COMMIT_TYPE_MAP = {
  feat: "Features",
  fix: "Bug Fixes",
  docs: "Documentation",
  style: "Styles",
  refactor: "Code Refactoring",
  perf: "Performance Improvements",
  test: "Tests",
  build: "Build System",
  ci: "Continuous Integration",
  chore: "Chores",
  revert: "Reverts",
  deps: "Dependencies"
};

function parseConventionalCommit(message) {
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!match) {
    return { type: "other", scope: null, breaking: false, description: message };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || null,
    breaking: !!match[3] || message.includes("BREAKING CHANGE:"),
    description: match[4]
  };
}

async function sidekick_changelog({ action, from, to, format, group_by, use_llm, include, path: repoPath }) {
  if (!from) {
    return { content: [{ type: "text", text: "from parameter required (starting ref: tag, commit, or branch)" }], isError: true };
  }

  const toRef = to || "HEAD";
  const fmt = format || "markdown";
  const groupBy = group_by || "type";
  const includeType = include || "all";
  const cwd = repoPath || process.cwd();
  const pathPolicyError = enforcePathPolicy(cwd, action === "save" ? "write" : "read");
  if (pathPolicyError) return pathPolicyError;

  let gitLogCmd = `git log ${from}..${toRef} --pretty=format:"%H|%s|%an|%ad" --date=short`;
  
  let logOutput = "";
  try {
    logOutput = execSync(gitLogCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], cwd });
  } catch (e) {
    return { content: [{ type: "text", text: `Git log failed: ${e.message}\n\nMake sure you're in a git repository and the refs exist.` }], isError: true };
  }

  if (!logOutput.trim()) {
    return { content: [{ type: "text", text: `No commits found between ${from} and ${toRef}` }] };
  }

  const commits = logOutput.trim().split("\n").map(line => {
    const [hash, message, author, date] = line.split("|");
    const parsed = parseConventionalCommit(message);
    return { hash, message, author, date, ...parsed };
  });

  let filtered = commits;
  if (includeType !== "all") {
    const typeFilter = {
      features: ["feat"],
      fixes: ["fix"],
      breaking: commits.filter(c => c.breaking).map(c => c.type),
      refactor: ["refactor"],
      deps: ["deps", "chore"]
    };
    const allowedTypes = typeFilter[includeType] || [];
    filtered = commits.filter(c => allowedTypes.includes(c.type) || (includeType === "breaking" && c.breaking));
  }

  if (filtered.length === 0) {
    return { content: [{ type: "text", text: `No commits matching filter "${includeType}" between ${from} and ${toRef}` }] };
  }

  const grouped = {};
  for (const commit of filtered) {
    let key;
    if (groupBy === "type") {
      key = COMMIT_TYPE_MAP[commit.type] || commit.type;
    } else if (groupBy === "scope") {
      key = commit.scope || "general";
    } else if (groupBy === "author") {
      key = commit.author;
    } else {
      key = "other";
    }
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(commit);
  }

  let changelog = "";
  
  if (fmt === "markdown") {
    const breaking = filtered.filter(c => c.breaking);
    if (breaking.length > 0) {
      changelog += "## ⚠ BREAKING CHANGES\n\n";
      for (const c of breaking) {
        changelog += `- ${c.description} (${c.hash.substring(0, 7)})\n`;
      }
      changelog += "\n";
    }

    for (const [group, commits] of Object.entries(grouped)) {
      if (groupBy === "type" && group === "other") continue;
      changelog += `## ${group}\n\n`;
      for (const c of commits) {
        const scope = c.scope ? `**${c.scope}:** ` : "";
        changelog += `- ${scope}${c.description} (${c.hash.substring(0, 7)})\n`;
      }
      changelog += "\n";
    }

    changelog += `---\n**${filtered.length} commits** from ${from} to ${toRef}\n`;
  } else if (fmt === "plain") {
    for (const [group, commits] of Object.entries(grouped)) {
      changelog += `${group}:\n`;
      for (const c of commits) {
        changelog += `  - ${c.description}\n`;
      }
      changelog += "\n";
    }
  } else if (fmt === "conventional") {
    for (const c of filtered) {
      changelog += `${c.message}\n`;
    }
  }

  if (use_llm && fmt === "markdown") {
    try {
      const summaryPrompt = `Summarize these ${filtered.length} git commits in 2-3 sentences for release notes. Focus on what changed and why it matters:\n\n${filtered.map(c => `- ${c.message}`).join("\n")}`;
      const llmResult = await sidekick_llm({
        prompt: summaryPrompt,
        system: "You are a technical writer creating release notes. Be concise and focus on user-facing changes.",
        temperature: 0.3
      });
      if (llmResult.content && llmResult.content[0]) {
        changelog = `## Summary\n\n${llmResult.content[0].text}\n\n${changelog}`;
      }
    } catch (e) {
      changelog += `\n*LLM summary failed: ${e.message}*\n`;
    }
  }

  if (action === "preview" || action === "generate") {
    return { content: [{ type: "text", text: changelog }] };
  }

  if (action === "save") {
    const changelogPath = path.join(cwd, "CHANGELOG.md");
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(changelogPath, "utf8");
    } catch {}

    const date = new Date().toISOString().split("T")[0];
    const header = `## ${date}\n\n`;
    const newEntry = header + changelog;

    const lines = existingContent.split("\n");
    let insertIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        insertIndex = i + 1;
        while (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex++;
        break;
      }
    }

    lines.splice(insertIndex, 0, newEntry);
    fs.writeFileSync(changelogPath, lines.join("\n"));

    return { content: [{ type: "text", text: `Changelog saved to ${changelogPath}\n\n${newEntry}` }] };
  }

  return { content: [{ type: "text", text: changelog }] };
}

const MAX_NETDIAG_COMMANDS = 15;
const COMMON_PORTS = [22, 80, 443, 3000, 3001, 4000, 5000, 8080, 8443, 9090];

function runNetDiagCommand(cmd, timeout = 5000) {
  try {
    const output = execSync(cmd, { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] });
    return { success: true, output: output.trim() };
  } catch (e) {
    return { success: false, output: (e.stdout || "") + (e.stderr || ""), error: e.message };
  }
}

async function sidekick_netdiag({ action, target, port_range, timeout, format }) {
  if (!target && action !== "listeners") {
    return { content: [{ type: "text", text: "target required (host, URL, or IP)" }], isError: true };
  }

  const fmt = format || "detailed";
  const to = timeout || 5000;
  let commandCount = 0;

  const checkLimit = () => {
    commandCount++;
    if (commandCount > MAX_NETDIAG_COMMANDS) {
      throw new Error(`Exceeded max commands per diagnostic (${MAX_NETDIAG_COMMANDS})`);
    }
  };

  if (action === "dns") {
    checkLimit();
    const dnsResult = runNetDiagCommand(`dig +short ${shellEscape(target)} A`, to);
    checkLimit();
    const dnsAny = runNetDiagCommand(`dig +short ${shellEscape(target)} ANY`, to);
    checkLimit();
    const reverse = runNetDiagCommand(`dig +short -x ${shellEscape(target)}`, to);

    let result = `DNS Resolution for: ${target}\n\n`;
    result += `A Records:\n${dnsResult.output || "None"}\n\n`;
    result += `ANY Records:\n${dnsAny.output || "None"}\n\n`;
    result += `Reverse DNS:\n${reverse.output || "None"}`;

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "route") {
    checkLimit();
    const traceResult = runNetDiagCommand(`traceroute -m 10 -w 2 ${shellEscape(target)}`, to * 2);
    
    let result = `Route to: ${target}\n\n`;
    result += traceResult.output || "Traceroute failed or timed out";

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "ports") {
    let ports = COMMON_PORTS;
    if (port_range) {
      const match = port_range.match(/(\d+)-(\d+)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = parseInt(match[2]);
        ports = [];
        for (let i = start; i <= end && ports.length < 20; i++) {
          ports.push(i);
        }
      }
    }

    checkLimit();
    const results = [];
    for (const port of ports) {
      const ncResult = runNetDiagCommand(`nc -z -w 2 ${shellEscape(target)} ${port} 2>&1`, 3000);
      const isOpen = ncResult.success && !ncResult.output.includes("failed");
      results.push({ port, open: isOpen });
    }

    let result = `Port Scan for: ${target}\n\n`;
    const openPorts = results.filter(r => r.open);
    const closedPorts = results.filter(r => !r.open);
    
    result += `Open: ${openPorts.length}\n`;
    if (openPorts.length > 0) {
      result += `  ${openPorts.map(r => r.port).join(", ")}\n`;
    }
    result += `\nClosed: ${closedPorts.length}\n`;
    if (fmt === "detailed" && closedPorts.length > 0) {
      result += `  ${closedPorts.map(r => r.port).join(", ")}\n`;
    }

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "listeners") {
    checkLimit();
    const ssResult = runNetDiagCommand("ss -tlnp", to);
    
    let result = "Local Listening Ports\n\n";
    result += ssResult.output || "No listeners found or ss command failed";

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "connectivity") {
    const targets = target.split(",").map(t => t.trim());
    const results = [];

    for (const t of targets) {
      checkLimit();
      const pingResult = runNetDiagCommand(`ping -c 2 -W 2 ${shellEscape(t)} 2>&1`, to);
      const isUp = pingResult.success && pingResult.output.includes("bytes from");
      results.push({ target: t, up: isUp, latency: isUp ? pingResult.output.match(/time[=<](\d+\.?\d*)/)?.[1] + "ms" : "N/A" });
    }

    let result = "Connectivity Check\n\n";
    for (const r of results) {
      result += `${r.target}: ${r.up ? "✓ UP" : "✗ DOWN"} (${r.latency})\n`;
    }

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "check") {
    let host = target;
    let url = null;
    if (target.startsWith("http://") || target.startsWith("https://")) {
      try {
        const parsed = new URL(target);
        host = parsed.hostname;
        url = target;
      } catch {}
    }

    const report = { target, host, timestamp: new Date().toISOString(), checks: {} };

    checkLimit();
    const dnsResult = runNetDiagCommand(`dig +short ${shellEscape(host)} A`, to);
    report.checks.dns = dnsResult.output || "Failed";

    checkLimit();
    const pingResult = runNetDiagCommand(`ping -c 2 -W 2 ${shellEscape(host)} 2>&1`, to);
    report.checks.ping = pingResult.success && pingResult.output.includes("bytes from") ? "OK" : "Failed";

    if (url) {
      checkLimit();
      const curlResult = runNetDiagCommand(`curl -s -o /dev/null -w "%{http_code}|%{time_total}|%{ssl_verify_result}" --max-time ${to / 1000} ${shellEscape(url)}`, to);
      if (curlResult.success) {
        const parts = curlResult.output.split("|");
        report.checks.http = {
          status: parts[0] || "N/A",
          time: parts[1] ? parseFloat(parts[1]).toFixed(3) + "s" : "N/A",
          ssl: parts[2] === "0" ? "Valid" : "Invalid"
        };
      } else {
        report.checks.http = "Failed";
      }
    }

    checkLimit();
    const portResult = runNetDiagCommand(`nc -z -w 2 ${shellEscape(host)} 22 2>&1`, 3000);
    report.checks.ssh = portResult.success && !portResult.output.includes("failed") ? "Open" : "Closed";

    let result = `Network Diagnostic Report\n`;
    result += `Target: ${target}\n`;
    result += `Time: ${report.timestamp}\n\n`;
    result += `DNS: ${report.checks.dns}\n`;
    result += `Ping: ${report.checks.ping}\n`;
    if (report.checks.http) {
      if (typeof report.checks.http === "object") {
        result += `HTTP: ${report.checks.http.status} (${report.checks.http.time}, SSL: ${report.checks.http.ssl})\n`;
      } else {
        result += `HTTP: ${report.checks.http}\n`;
      }
    }
    result += `SSH (22): ${report.checks.ssh}\n`;

    return { content: [{ type: "text", text: result }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: check, dns, route, ports, listeners, connectivity" }], isError: true };
}

const MAX_TIMELINE_EVENTS = 500;
const MAX_TIMELINE_RANGE_DAYS = 30;

function parseRelativeTime(str) {
  if (!str || str === "now") return new Date();
  const match = str.match(/^(\d+)([smhd])$/);
  if (match) {
    const val = parseInt(match[1]);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(Date.now() - val * multipliers[unit]);
  }
  return new Date(str);
}

function parseJournalctlLine(line) {
  const match = line.match(/^(\S+ \d+ \d+:\d+:\d+) (\S+) (.+)$/);
  if (!match) return null;
  const [_, timestamp, host, message] = match;
  const year = new Date().getFullYear();
  const date = new Date(`${year} ${timestamp}`);
  const severity = /error|fail|critical/i.test(message) ? "error" 
    : /warn/i.test(message) ? "warn" : "info";
  return { timestamp: date.toISOString(), source: "journalctl", severity, summary: message.substring(0, 200) };
}

function parseLogJsonlLine(line) {
  try {
    const entry = JSON.parse(line);
    return {
      timestamp: entry.t,
      source: "log.jsonl",
      severity: entry.ok ? "info" : "error",
      summary: `${entry.n}: ${(entry.s || "").substring(0, 150)}`
    };
  } catch {
    return null;
  }
}

function parseGitLogLine(line) {
  const match = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) return null;
  const [_, hash, date, message] = match;
  return {
    timestamp: new Date(date).toISOString(),
    source: "git",
    severity: "info",
    summary: `${hash.substring(0, 7)}: ${message.substring(0, 150)}`
  };
}

async function sidekick_timeline({ action, since, until, sources, pattern, severity, format, max_events }) {
  const maxEvents = max_events || MAX_TIMELINE_EVENTS;
  const startTime = parseRelativeTime(since);
  const endTime = parseRelativeTime(until || "now");
  
  const rangeDays = (endTime - startTime) / 86400000;
  if (rangeDays > MAX_TIMELINE_RANGE_DAYS) {
    return { content: [{ type: "text", text: `Time range exceeds maximum of ${MAX_TIMELINE_RANGE_DAYS} days` }], isError: true };
  }

  const useSources = sources && sources[0] !== "all" ? sources : ["log.jsonl", "journalctl", "git", "files"];
  const events = [];

  if (useSources.includes("log.jsonl")) {
    try {
      const toolLogs = dbStore.readToolLogs(1000);
      for (const log of toolLogs) {
        const event = {
          timestamp: log.t,
          source: "log.jsonl",
          tool: log.n,
          status: log.ok ? "success" : "error",
          summary: log.s,
          args: log.a
        };
        const eventTime = new Date(event.timestamp);
        if (eventTime >= startTime && eventTime <= endTime) {
          events.push(event);
        }
      }
    } catch {}
  }

  if (useSources.includes("journalctl")) {
    try {
      const sinceStr = startTime.toISOString();
      const result = execSync(`journalctl --since "${sinceStr}" --no-pager -n 500`, { 
        encoding: "utf8", 
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"] 
      });
      const lines = result.trim().split("\n").slice(4);
      for (const line of lines) {
        const event = parseJournalctlLine(line);
        if (event) {
          const eventTime = new Date(event.timestamp);
          if (eventTime >= startTime && eventTime <= endTime) {
            events.push(event);
          }
        }
      }
    } catch {}
  }

  if (useSources.includes("git")) {
    try {
      const sinceDate = startTime.toISOString();
      const result = execSync(`git log --since="${sinceDate}" --pretty=format:"%H %ad %s" --date=iso -n 100`, {
        encoding: "utf8",
        timeout: 10000,
        cwd: "/home/sidekick/sidekick",
        stdio: ["pipe", "pipe", "pipe"]
      });
      const lines = result.trim().split("\n");
      for (const line of lines) {
        const event = parseGitLogLine(line);
        if (event) events.push(event);
      }
    } catch {}
  }

  if (useSources.includes("files")) {
    try {
      const minutes = Math.ceil((Date.now() - startTime.getTime()) / 60000);
      const result = execSync(`find /home/sidekick/sidekick -type f -mmin -${minutes} -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -50`, {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const files = result.trim().split("\n").filter(Boolean);
      for (const file of files) {
        try {
          const stat = fs.statSync(file);
          events.push({
            timestamp: stat.mtime.toISOString(),
            source: "files",
            severity: "info",
            summary: `Modified: ${file}`
          });
        } catch {}
      }
    } catch {}
  }

  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let filtered = events;
  if (severity && severity !== "all") {
    filtered = filtered.filter(e => e.severity === severity);
  }
  if (pattern) {
    const regex = new RegExp(pattern, "i");
    filtered = filtered.filter(e => regex.test(e.summary));
  }

  if (filtered.length > maxEvents) {
    filtered = filtered.slice(0, maxEvents);
  }

  if (action === "filter") {
    return { content: [{ type: "text", text: `Found ${filtered.length} events matching filters` }] };
  }

  if (action === "export" && format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
  }

  if (filtered.length === 0) {
    return { content: [{ type: "text", text: `No events found between ${since} and ${until || "now"}` }] };
  }

  let output = `Timeline: ${startTime.toISOString()} to ${endTime.toISOString()}\n`;
  output += `Events: ${filtered.length}\n\n`;

  if (format === "detailed") {
    for (const event of filtered) {
      output += `[${event.timestamp}] [${event.source}] [${event.severity}]\n  ${event.summary}\n\n`;
    }
  } else {
    for (const event of filtered) {
      const time = event.timestamp.substring(11, 19);
      output += `${time} [${event.source.padEnd(10)}] ${event.summary}\n`;
    }
  }

  return { content: [{ type: "text", text: output }] };
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

const BASELINE_FILE = path.join(DATA_DIR, "baselines.json");
const MAX_TRACKED_METRICS = 50;
const MAX_DATA_POINTS_PER_METRIC = 1000;
const MIN_DATA_POINTS_FOR_LEARNING = 10;

function loadBaselines() {
  try {
    if (fs.existsSync(BASELINE_FILE)) {
      return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    }
  } catch {}
  return { metrics: {} };
}

function saveBaselines(data) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
}

function getTimeBucket(hour) {
  return Math.floor(hour / 4) * 4;
}

function calculateStats(values) {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  return { mean, stddev };
}

async function sidekick_baseline({ action, metric_name, value, source, command, window, sensitivity }) {
  const data = loadBaselines();
  const sens = sensitivity || "medium";
  const sigmaMultiplier = { low: 3, medium: 2, high: 1.5 }[sens] || 2;

  if (action === "record") {
    if (!metric_name || value === undefined) {
      return { content: [{ type: "text", text: "metric_name and value required" }], isError: true };
    }

    if (!data.metrics[metric_name]) {
      if (Object.keys(data.metrics).length >= MAX_TRACKED_METRICS) {
        return { content: [{ type: "text", text: `Max metrics reached (${MAX_TRACKED_METRICS})` }], isError: true };
      }
      data.metrics[metric_name] = {
        dataPoints: [],
        baseline: null,
        created: Date.now()
      };
    }

    const metric = data.metrics[metric_name];
    metric.dataPoints.push({
      value,
      timestamp: Date.now(),
      hour: new Date().getHours()
    });

    if (metric.dataPoints.length > MAX_DATA_POINTS_PER_METRIC) {
      metric.dataPoints = metric.dataPoints.slice(-MAX_DATA_POINTS_PER_METRIC);
    }

    saveBaselines(data);
    return { content: [{ type: "text", text: `Recorded ${value} for ${metric_name} (${metric.dataPoints.length} points total)` }] };
  }

  if (action === "learn") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }

    const metric = data.metrics[metric_name];
    if (!metric) {
      return { content: [{ type: "text", text: `Metric not found: ${metric_name}` }], isError: true };
    }

    if (metric.dataPoints.length < MIN_DATA_POINTS_FOR_LEARNING) {
      return { content: [{ type: "text", text: `Insufficient data: ${metric.dataPoints.length}/${MIN_DATA_POINTS_FOR_LEARNING} points needed` }], isError: true };
    }

    const buckets = {};
    for (const point of metric.dataPoints) {
      const bucket = getTimeBucket(point.hour);
      if (!buckets[bucket]) buckets[bucket] = [];
      buckets[bucket].push(point.value);
    }

    const baseline = {};
    for (const [bucket, values] of Object.entries(buckets)) {
      const stats = calculateStats(values);
      baseline[bucket] = {
        mean: stats.mean,
        stddev: stats.stddev,
        count: values.length
      };
    }

    metric.baseline = baseline;
    metric.learnedAt = Date.now();
    saveBaselines(data);

    const bucketSummary = Object.entries(baseline).map(([b, s]) => 
      `${b.toString().padStart(2, "0")}:00 - mean: ${s.mean.toFixed(2)}, σ: ${s.stddev.toFixed(2)} (n=${s.count})`
    ).join("\n");

    return { content: [{ type: "text", text: `Baseline learned for ${metric_name}\n\nTime buckets:\n${bucketSummary}` }] };
  }

  if (action === "check") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }

    let currentValue = value;
    if (currentValue === undefined && source === "command" && command) {
      try {
        const result = execSync(command, { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
        currentValue = parseFloat(result.trim());
      } catch (e) {
        return { content: [{ type: "text", text: `Command failed: ${e.message}` }], isError: true };
      }
    }

    if (currentValue === undefined || isNaN(currentValue)) {
      return { content: [{ type: "text", text: "value required (or use source=command with a command that outputs a number)" }], isError: true };
    }

    const metric = data.metrics[metric_name];
    if (!metric || !metric.baseline) {
      return { content: [{ type: "text", text: `No baseline for ${metric_name}. Use action=learn first.` }], isError: true };
    }

    const currentHour = new Date().getHours();
    const bucket = getTimeBucket(currentHour);
    const bucketStats = metric.baseline[bucket];

    if (!bucketStats) {
      return { content: [{ type: "text", text: `No baseline data for time bucket ${bucket}:00` }], isError: true };
    }

    const deviation = Math.abs(currentValue - bucketStats.mean);
    const sigmaDeviation = bucketStats.stddev > 0 ? deviation / bucketStats.stddev : 0;
    const isAnomaly = sigmaDeviation > sigmaMultiplier;

    const result = {
      metric: metric_name,
      current: currentValue,
      expected: bucketStats.mean.toFixed(2),
      deviation: sigmaDeviation.toFixed(2) + "σ",
      threshold: sigmaMultiplier + "σ",
      status: isAnomaly ? "ANOMALY" : "normal",
      timeBucket: `${bucket}:00-${bucket + 3}:59`
    };

    let output = `Baseline Check: ${metric_name}\n`;
    output += `Current: ${result.current}\n`;
    output += `Expected: ${result.expected} (±${bucketStats.stddev.toFixed(2)}σ)\n`;
    output += `Deviation: ${result.deviation} (threshold: ${result.threshold})\n`;
    output += `Time bucket: ${result.timeBucket}\n`;
    output += `Status: ${result.status}`;

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "status") {
    const entries = Object.entries(data.metrics);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No metrics tracked" }] };
    }
    const list = entries.map(([name, m]) => {
      const learned = m.baseline ? "✓" : "✗";
      return `${name}: ${m.dataPoints.length} points, baseline: ${learned}`;
    }).join("\n");
    return { content: [{ type: "text", text: `Tracked metrics (${entries.length}/${MAX_TRACKED_METRICS}):\n\n${list}` }] };
  }

  if (action === "reset") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }
    if (data.metrics[metric_name]) {
      delete data.metrics[metric_name];
      saveBaselines(data);
      return { content: [{ type: "text", text: `Reset metric: ${metric_name}` }] };
    }
    return { content: [{ type: "text", text: `Metric not found: ${metric_name}` }], isError: true };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: record, learn, check, status, reset" }], isError: true };
}

const MAX_DEPEND_DEPTH = 10;
const MAX_DEPEND_RESULTS = 100;

async function sidekick_depend({ action, type, target, depth, format }) {
  const maxDepth = Math.min(depth || 5, MAX_DEPEND_DEPTH);
  const fmt = format || "tree";

  if (action === "tree") {
    if (!type) {
      return { content: [{ type: "text", text: "type required (npm, service, process)" }], isError: true };
    }

    if (type === "npm") {
      const cwd = target || process.cwd();
      try {
        const result = execSync(`npm ls --depth=${maxDepth} --json`, { 
          encoding: "utf8", 
          cwd,
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);
        
        if (fmt === "json") {
          return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
        }
        
        const formatNpmTree = (node, indent = 0) => {
          let output = "";
          const prefix = "  ".repeat(indent);
          if (node.name) {
            output += `${prefix}${node.name}@${node.version || "?"}\n`;
          }
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              output += formatNpmTree(dep, indent + 1);
            }
          }
          return output;
        };
        
        return { content: [{ type: "text", text: formatNpmTree(tree) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `npm ls failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "service") {
      if (!target) {
        return { content: [{ type: "text", text: "target required for service tree" }], isError: true };
      }
      try {
        const result = execSync(`systemctl list-dependencies ${shellEscape(target)} --no-pager`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `systemctl failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "process") {
      const pid = target || "1";
      try {
        const result = execSync(`pstree -p ${shellEscape(pid)}`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `pstree failed: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown type. Use: npm, service, process" }], isError: true };
  }

  if (action === "reverse") {
    if (!type || !target) {
      return { content: [{ type: "text", text: "type and target required" }], isError: true };
    }

    if (type === "npm") {
      const cwd = process.cwd();
      try {
        const result = execSync(`npm ls --all --json`, {
          encoding: "utf8",
          cwd,
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);
        
        const findDependents = (node, targetName, path = []) => {
          const results = [];
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              if (name === targetName) {
                results.push([...path, node.name || "root"]);
              }
              results.push(...findDependents(dep, targetName, [...path, node.name || "root"]));
            }
          }
          return results;
        };
        
        const dependents = findDependents(tree, target);
        if (dependents.length === 0) {
          return { content: [{ type: "text", text: `No packages depend on ${target}` }] };
        }
        
        const unique = [...new Set(dependents.map(d => d.join(" → ")))];
        return { content: [{ type: "text", text: `Packages depending on ${target}:\n\n${unique.slice(0, MAX_DEPEND_RESULTS).join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `npm ls failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "service") {
      try {
        const result = execSync(`systemctl list-dependencies --reverse ${shellEscape(target)} --no-pager`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result || `No services depend on ${target}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `systemctl failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "process") {
      try {
        const result = execSync(`ps -o pid,ppid,comm --ppid ${shellEscape(target)}`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result || `No child processes for PID ${target}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `ps failed: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown type. Use: npm, service, process" }], isError: true };
  }

  if (action === "outdated") {
    if (type !== "npm") {
      return { content: [{ type: "text", text: "outdated only supported for npm" }], isError: true };
    }
    const cwd = target || process.cwd();
    try {
      const result = execSync(`npm outdated --json`, {
        encoding: "utf8",
        cwd,
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const outdated = JSON.parse(result);
      if (Object.keys(outdated).length === 0) {
        return { content: [{ type: "text", text: "All packages are up to date" }] };
      }
      const list = Object.entries(outdated).map(([name, info]) => 
        `${name}: ${info.current || "?"} → ${info.latest} (wanted: ${info.wanted || "?"})`
      ).join("\n");
      return { content: [{ type: "text", text: `Outdated packages:\n\n${list}` }] };
    } catch (e) {
      if (e.stdout) {
        try {
          const outdated = JSON.parse(e.stdout);
          const list = Object.entries(outdated).map(([name, info]) => 
            `${name}: ${info.current || "?"} → ${info.latest} (wanted: ${info.wanted || "?"})`
          ).join("\n");
          return { content: [{ type: "text", text: `Outdated packages:\n\n${list}` }] };
        } catch {}
      }
      return { content: [{ type: "text", text: `npm outdated failed: ${e.message}` }], isError: true };
    }
  }

  if (action === "impact") {
    if (!type || !target) {
      return { content: [{ type: "text", text: "type and target required" }], isError: true };
    }

    let impact = `Impact analysis for removing ${target}:\n\n`;
    
    if (type === "npm") {
      try {
        const result = execSync(`npm ls --all --json`, {
          encoding: "utf8",
          cwd: process.cwd(),
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);
        
        const findDependents = (node, targetName) => {
          const results = [];
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              if (name === targetName) {
                results.push(node.name || "root");
              }
              results.push(...findDependents(dep, targetName));
            }
          }
          return results;
        };
        
        const dependents = findDependents(tree, target);
        if (dependents.length === 0) {
          impact += "No packages depend on this. Safe to remove.";
        } else {
          const unique = [...new Set(dependents)];
          impact += `WARNING: ${unique.length} package(s) depend on this:\n`;
          impact += unique.slice(0, 20).map(d => `  - ${d}`).join("\n");
          if (unique.length > 20) impact += `\n  ... and ${unique.length - 20} more`;
        }
      } catch (e) {
        impact += `Analysis failed: ${e.message}`;
      }
    } else if (type === "service") {
      try {
        const result = execSync(`systemctl list-dependencies --reverse ${shellEscape(target)} --no-pager`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        if (result.trim()) {
          impact += `WARNING: The following services depend on ${target}:\n${result}`;
        } else {
          impact += "No services depend on this. Safe to remove.";
        }
      } catch (e) {
        impact += `Analysis failed: ${e.message}`;
      }
    } else {
      impact += "Impact analysis not supported for this type";
    }

    return { content: [{ type: "text", text: impact }] };
  }

  if (action === "orphans") {
    if (type !== "npm") {
      return { content: [{ type: "text", text: "orphans only supported for npm" }], isError: true };
    }
    const cwd = target || process.cwd();
    try {
      const pkgPath = path.join(cwd, "package.json");
      if (!fs.existsSync(pkgPath)) {
        return { content: [{ type: "text", text: "No package.json found" }], isError: true };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const declared = Object.keys(pkg.dependencies || {});
      
      const result = execSync(`npm ls --depth=0 --json`, {
        encoding: "utf8",
        cwd,
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const tree = JSON.parse(result);
      const installed = Object.keys(tree.dependencies || {});
      
      const orphans = installed.filter(dep => !declared.includes(dep));
      if (orphans.length === 0) {
        return { content: [{ type: "text", text: "No orphaned dependencies found" }] };
      }
      return { content: [{ type: "text", text: `Orphaned dependencies (installed but not in package.json):\n\n${orphans.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Analysis failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: tree, reverse, outdated, impact, orphans" }], isError: true };
}

const RUNBOOK_FILE = path.join(DATA_DIR, "runbooks.json");
const MAX_RUNBOOKS = 20;
const MAX_ACTIVE_INSTANCES = 5;
const MAX_STEPS_PER_RUNBOOK = 20;
const STEP_TIMEOUT_MS = 60000;

function loadRunbooks() {
  try {
    if (fs.existsSync(RUNBOOK_FILE)) {
      return JSON.parse(fs.readFileSync(RUNBOOK_FILE, "utf8"));
    }
  } catch {}
  return { definitions: {}, instances: {} };
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
      definitionId: rbId,
      status: "running",
      currentStep: 0,
      mode: execMode,
      started: Date.now(),
      results: []
    };
    saveRunbooks(data);

    if (execMode === "autonomous") {
      let output = `Starting autonomous runbook: ${rbId} (${rb.name})\n\n`;
      for (let i = 0; i < rb.steps.length; i++) {
        const step = rb.steps[i];
        output += `Step ${i + 1}/${rb.steps.length}: ${step.name}\n`;
        try {
          const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
          output += `  ✓ Success\n`;
          if (step.verify_command) {
            try {
              const verifyResult = execSync(step.verify_command, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
              output += `  ✓ Verified\n`;
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
              saveRunbooks(data);
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
          saveRunbooks(data);
          return { content: [{ type: "text", text: output }], isError: true };
        }
      }
      data.instances[instanceId].status = "completed";
      saveRunbooks(data);
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
        } else {
          data.instances[instanceId].status = "completed";
          output += `\n✓ Runbook completed`;
        }
      } catch (e) {
        output += `Failed: ${e.message}\n`;
        if (step.rollback) {
          output += `Use action="rollback" with runbook_id="${instanceId}" to rollback`;
        }
        data.instances[instanceId].status = "failed";
      }
      saveRunbooks(data);
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
    if (instance.mode !== "guided") {
      return { content: [{ type: "text", text: "Instance is not in guided mode" }], isError: true };
    }
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }

    instance.currentStep++;
    if (instance.currentStep >= rb.steps.length) {
      instance.status = "completed";
      saveRunbooks(data);
      return { content: [{ type: "text", text: `✓ Runbook completed` }] };
    }

    const step = rb.steps[instance.currentStep];
    let output = `Step ${instance.currentStep + 1}/${rb.steps.length}: ${step.name}\n`;
    output += `Command: ${step.command}\n`;
    try {
      const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
      output += `Result: ${result.substring(0, 500)}\n`;
      instance.results.push({ step: instance.currentStep, success: true, output: result });
      if (instance.currentStep < rb.steps.length - 1) {
        output += `\nUse action="next" to continue`;
      } else {
        instance.status = "completed";
        output += `\n✓ Runbook completed`;
      }
    } catch (e) {
      output += `Failed: ${e.message}\n`;
      if (step.rollback) {
        output += `Use action="rollback" to rollback`;
      }
      instance.status = "failed";
    }
    saveRunbooks(data);
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
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }

    let output = `Rolling back runbook: ${runbook_id}\n\n`;
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
    instance.status = "aborted";
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Aborted runbook: ${runbook_id}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: create, start, next, verify, rollback, abort, list, get, delete" }], isError: true };
}

const BLACKBOX_FILE = path.join(DATA_DIR, "blackbox.json");
const BLACKBOX_DIR = path.join(DATA_DIR, "blackbox");
const MAX_BLACKBOX_PER_DAY = 5;
const BLACKBOX_TTL_DAYS = 7;
const MAX_BLACKBOX_ACTIVE = 3;
const MAX_BLACKBOX_COMMANDS = 10;

fs.mkdirSync(BLACKBOX_DIR, { recursive: true });

function loadBlackbox() {
  try {
    if (fs.existsSync(BLACKBOX_FILE)) {
      return JSON.parse(fs.readFileSync(BLACKBOX_FILE, "utf8"));
    }
  } catch {}
  return { incidents: {} };
}

function saveBlackbox(data) {
  fs.writeFileSync(BLACKBOX_FILE, JSON.stringify(data, null, 2));
}

function purgeExpiredIncidents(data) {
  const now = Date.now();
  const ttlMs = BLACKBOX_TTL_DAYS * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const [id, incident] of Object.entries(data.incidents)) {
    if (now - incident.captured > ttlMs) {
      const incidentPath = path.join(BLACKBOX_DIR, id);
      try { fs.rmSync(incidentPath, { recursive: true, force: true }); } catch {}
      delete data.incidents[id];
      purged++;
    }
  }
  return purged;
}

function generateIncidentId() {
  return "bb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function sidekick_black_box({ action, name, include, analyze_with_llm, incident_id }) {
  const data = loadBlackbox();
  purgeExpiredIncidents(data);

  if (action === "list") {
    const entries = Object.entries(data.incidents);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No incidents captured" }] };
    }
    const list = entries.map(([id, inc]) => {
      const age = Math.round((Date.now() - inc.captured) / 1000 / 60);
      return `${id}: ${inc.name || "unnamed"} (${age}min ago, ${inc.sources.length} sources)`;
    }).join("\n");
    return { content: [{ type: "text", text: `Incidents (${entries.length}/${MAX_BLACKBOX_ACTIVE}):\n\n${list}` }] };
  }

  if (action === "get") {
    if (!incident_id) {
      return { content: [{ type: "text", text: "incident_id required" }], isError: true };
    }
    const incident = data.incidents[incident_id];
    if (!incident) {
      return { content: [{ type: "text", text: `Incident not found: ${incident_id}` }], isError: true };
    }
    const incidentPath = path.join(BLACKBOX_DIR, incident_id);
    let content = "";
    try {
      content = fs.readFileSync(incidentPath, "utf8");
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to read incident data: ${e.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: content }] };
  }

  if (action === "delete") {
    if (!incident_id) {
      return { content: [{ type: "text", text: "incident_id required" }], isError: true };
    }
    if (!data.incidents[incident_id]) {
      return { content: [{ type: "text", text: `Incident not found: ${incident_id}` }], isError: true };
    }
    const incidentPath = path.join(BLACKBOX_DIR, incident_id);
    try { fs.rmSync(incidentPath, { recursive: true, force: true }); } catch {}
    delete data.incidents[incident_id];
    saveBlackbox(data);
    return { content: [{ type: "text", text: `Deleted incident: ${incident_id}` }] };
  }

  if (action === "capture") {
    const today = new Date().toISOString().split("T")[0];
    const todayIncidents = Object.values(data.incidents).filter(inc => {
      const incDate = new Date(inc.captured).toISOString().split("T")[0];
      return incDate === today;
    });

    if (todayIncidents.length >= MAX_BLACKBOX_PER_DAY) {
      return { content: [{ type: "text", text: `Rate limit exceeded: max ${MAX_BLACKBOX_PER_DAY} captures per day` }], isError: true };
    }

    if (Object.keys(data.incidents).length >= MAX_BLACKBOX_ACTIVE) {
      return { content: [{ type: "text", text: `Max active incidents reached (${MAX_BLACKBOX_ACTIVE}). Delete old incidents or wait for TTL expiry.` }], isError: true };
    }

    const id = generateIncidentId();
    const incidentName = name || `incident_${Date.now()}`;
    const sources = include && include[0] !== "all" ? include : ["services", "processes", "logs", "disk", "network"];
    
    let commandCount = 0;
    const checkLimit = () => {
      commandCount++;
      if (commandCount > MAX_BLACKBOX_COMMANDS) {
        throw new Error(`Exceeded max commands per capture (${MAX_BLACKBOX_COMMANDS})`);
      }
    };

    let content = `# Incident Report: ${incidentName}\n`;
    content += `ID: ${id}\n`;
    content += `Time: ${new Date().toISOString()}\n`;
    content += `Sources: ${sources.join(", ")}\n\n`;

    try {
      if (sources.includes("services")) {
        checkLimit();
        content += "## Services\n\n";
        try {
          const result = execSync("systemctl list-units --type=service --no-pager --state=running", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get services: ${e.message}\n`;
        }
      }

      if (sources.includes("processes")) {
        checkLimit();
        content += "## Top Processes\n\n";
        try {
          const result = execSync("ps aux --sort=-%cpu | head -20", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get processes: ${e.message}\n`;
        }
      }

      if (sources.includes("logs")) {
        checkLimit();
        content += "## Recent Logs (journalctl)\n\n";
        try {
          const result = execSync("journalctl -n 100 --no-pager", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get journalctl: ${e.message}\n`;
        }

        checkLimit();
        content += "## Recent Tool Calls (log.jsonl)\n\n";
        try {
          const toolLogs = dbStore.readToolLogs(100);
          content += toolLogs.map(l =>
            l.t + " [" + (l.ok ? "OK" : "ERR") + "] " + l.n + ": " + l.s
          ).join("\n") + "\n";
        } catch (e) {
          content += `Failed to read tool logs: ${e.message}\n`;
        }
      }

      if (sources.includes("disk")) {
        checkLimit();
        content += "## Disk Usage\n\n";
        try {
          const result = execSync("df -h", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get disk: ${e.message}\n`;
        }
      }

      if (sources.includes("network")) {
        checkLimit();
        content += "## Network Listeners\n\n";
        try {
          const result = execSync("ss -tlnp", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get network: ${e.message}\n`;
        }
      }
    } catch (e) {
      content += `\n\nCapture error: ${e.message}\n`;
    }

    const incidentPath = path.join(BLACKBOX_DIR, id);
    fs.writeFileSync(incidentPath, content);

    data.incidents[id] = {
      name: incidentName,
      captured: Date.now(),
      sources,
      size: content.length
    };
    saveBlackbox(data);

    let result = `Incident captured: ${id}\n`;
    result += `Name: ${incidentName}\n`;
    result += `Sources: ${sources.join(", ")}\n`;
    result += `Size: ${content.length} bytes\n`;
    result += `Commands executed: ${commandCount}\n`;

    if (analyze_with_llm) {
      try {
        const summaryPrompt = `Analyze this incident report and identify potential issues or anomalies:\n\n${content.substring(0, 5000)}`;
        const llmResult = await sidekick_llm({
          prompt: summaryPrompt,
          system: "You are a senior systems engineer analyzing an incident report. Identify key issues, anomalies, and potential root causes. Be concise and actionable.",
          temperature: 0.3
        });
        if (llmResult.content && llmResult.content[0]) {
          result += `\n## LLM Analysis\n\n${llmResult.content[0].text}`;
        }
      } catch (e) {
        result += `\nLLM analysis failed: ${e.message}`;
      }
    }

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "analyze") {
    if (!incident_id) {
      return { content: [{ type: "text", text: "incident_id required" }], isError: true };
    }
    const incident = data.incidents[incident_id];
    if (!incident) {
      return { content: [{ type: "text", text: `Incident not found: ${incident_id}` }], isError: true };
    }
    const incidentPath = path.join(BLACKBOX_DIR, incident_id);
    let content = "";
    try {
      content = fs.readFileSync(incidentPath, "utf8");
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to read incident data: ${e.message}` }], isError: true };
    }

    try {
      const summaryPrompt = `Analyze this incident report and identify potential issues or anomalies:\n\n${content.substring(0, 5000)}`;
      const llmResult = await sidekick_llm({
        prompt: summaryPrompt,
        system: "You are a senior systems engineer analyzing an incident report. Identify key issues, anomalies, and potential root causes. Be concise and actionable.",
        temperature: 0.3
      });
      if (llmResult.content && llmResult.content[0]) {
        return { content: [{ type: "text", text: `## LLM Analysis for ${incident_id}\n\n${llmResult.content[0].text}` }] };
      }
    } catch (e) {
      return { content: [{ type: "text", text: `LLM analysis failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: capture, list, get, delete, analyze" }], isError: true };
}

// Simple respond tool for agent to return text without calling other tools
async function sidekick_respond({ text }) {
  if (!text) {
    return { content: [{ type: "text", text: "text parameter required" }], isError: true };
  }
  return { content: [{ type: "text", text: text }] };
}

// --- Database Tools ---

async function sidekick_db_schema({ table, verbose, database }) {
  try {
    if (database === "postgres") {
      if (table) {
        const info = await pgStore.getTableInfo(table);
        return { content: [{ type: "text", text: JSON.stringify({ table, ...info }, null, 2) }] };
      }
      const tables = await pgStore.getTableList();
      if (verbose) {
        const detailed = [];
        for (const t of tables) {
          const info = await pgStore.getTableInfo(t.name);
          detailed.push({ name: t.name, type: t.type, ...info });
        }
        return { content: [{ type: "text", text: JSON.stringify(detailed, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
    }
    if (table) {
      const info = dbStore.getTableInfo(table);
      return { content: [{ type: "text", text: JSON.stringify({ table, ...info }, null, 2) }] };
    }
    const tables = dbStore.getTableList();
    if (verbose) {
      const detailed = tables.map(t => ({
        name: t.name,
        type: t.type,
        ...dbStore.getTableInfo(t.name)
      }));
      return { content: [{ type: "text", text: JSON.stringify(detailed, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_query({ sql, params, readonly, limit, timeout, database }) {
  try {
    if (database === "postgres") {
      const results = await pgStore.executeQuery(sql, params || [], {
        readonly: readonly !== false,
        limit: limit || 1000,
        timeout: timeout || 5000
      });
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
    const results = dbStore.executeQuery(sql, params || [], {
      readonly: readonly !== false,
      limit: limit || 1000,
      timeout: timeout || 5000
    });
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_stats({ detailed, database }) {
  try {
    if (database === "postgres") {
      const stats = await pgStore.getDatabaseStats();
      if (!detailed) {
        delete stats.tables;
      }
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }
    const stats = dbStore.getDatabaseStats();
    if (!detailed) {
      delete stats.tables;
    }
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_backup({ path: destPath, compress }) {
  try {
    if (destPath) {
      const policyError = enforcePathPolicy(destPath, "write");
      if (policyError) return policyError;
    }
    const result = dbStore.createBackup(destPath, compress !== false);
    return { content: [{ type: "text", text: `Backup created: ${result.path} (${result.size} bytes, compressed: ${result.compressed})` }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_restore({ path: backupPath, verify }) {
  try {
    const policyError = enforcePathPolicy(backupPath, "read");
    if (policyError) return policyError;
    const result = dbStore.restoreBackup(backupPath, verify !== false);
    return { content: [{ type: "text", text: `Restored from: ${backupPath}\nPre-restore backup: ${result.preBackupPath}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_log_query({ tool, source, success, since, until, limit }) {
  try {
    const logs = dbStore.queryToolLogs({ tool, source, success, since, until, limit: limit || 100 });
    return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_export({ table, format, path: outputPath, database }) {
  try {
    const fmt = format || "json";
    if (outputPath) {
      const policyError = enforcePathPolicy(outputPath, "write");
      if (policyError) return policyError;
    }
    if (database === "postgres") {
      if (table) {
        const data = await pgStore.exportTable(table, fmt);
        if (outputPath) {
          fs.writeFileSync(outputPath, data);
          return { content: [{ type: "text", text: `Exported ${table} to ${outputPath}` }] };
        }
        return { content: [{ type: "text", text: data }] };
      }
      const tables = await pgStore.getTableList();
      const allData = {};
      for (const t of tables) {
        allData[t.name] = JSON.parse(await pgStore.exportTable(t.name, "json"));
      }
      const output = JSON.stringify(allData, null, 2);
      if (outputPath) {
        fs.writeFileSync(outputPath, output);
        return { content: [{ type: "text", text: `Exported all tables to ${outputPath}` }] };
      }
      return { content: [{ type: "text", text: output }] };
    }
    if (table) {
      const data = dbStore.exportTable(table, fmt);
      if (outputPath) {
        fs.writeFileSync(outputPath, data);
        return { content: [{ type: "text", text: `Exported ${table} to ${outputPath}` }] };
      }
      return { content: [{ type: "text", text: data }] };
    }
    const tables = dbStore.getTableList().filter(t => t.type === "table");
    const allData = {};
    for (const t of tables) {
      allData[t.name] = JSON.parse(dbStore.exportTable(t.name, "json"));
    }
    const output = JSON.stringify(allData, null, 2);
    if (outputPath) {
      fs.writeFileSync(outputPath, output);
      return { content: [{ type: "text", text: `Exported all tables to ${outputPath}` }] };
    }
    return { content: [{ type: "text", text: output }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_search({ query, tables, limit, database }) {
  try {
    if (database === "postgres") {
      const results = await pgStore.searchAllTables(query, { tables: tables ? tables.split(",").map(t => t.trim()) : null, limit: limit || 50 });
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
    dbStore.setupFTS5();
    const results = dbStore.searchAllTables(query, { tables: tables ? tables.split(",").map(t => t.trim()) : null, limit: limit || 50 });
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_migrate({ action, version, name }) {
  try {
    if (action === "status") {
      const current = dbStore.getMigrationVersion();
      const migrations = dbStore.listMigrations();
      return { content: [{ type: "text", text: JSON.stringify({ currentVersion: current, migrations }, null, 2) }] };
    }
    if (action === "list") {
      const migrations = dbStore.listMigrations();
      return { content: [{ type: "text", text: JSON.stringify(migrations, null, 2) }] };
    }
    if (action === "up") {
      if (!name) {
        return { content: [{ type: "text", text: "name required for up migration" }], isError: true };
      }
      const migrationPath = path.join(dbStore.MIGRATIONS_DIR, name);
      if (!fs.existsSync(migrationPath)) {
        return { content: [{ type: "text", text: `Migration not found: ${name}` }], isError: true };
      }
      const sql = fs.readFileSync(migrationPath, "utf-8");
      const result = dbStore.runMigration(name, sql, "");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    return { content: [{ type: "text", text: "Unknown action. Use: status, list, up" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_diff({ snapshot_a, snapshot_b, table }) {
  try {
    if (snapshot_a && snapshot_a !== "current") {
      const policyError = enforcePathPolicy(snapshot_a, "read");
      if (policyError) return policyError;
    }
    if (snapshot_b && snapshot_b !== "current") {
      const policyError = enforcePathPolicy(snapshot_b, "read");
      if (policyError) return policyError;
    }
    const snapA = snapshot_a === "current" || !snapshot_a ? dbStore.createSnapshot() : JSON.parse(fs.readFileSync(snapshot_a, "utf-8"));
    const snapB = snapshot_b === "current" || !snapshot_b ? dbStore.createSnapshot() : JSON.parse(fs.readFileSync(snapshot_b, "utf-8"));
    
    const diff = dbStore.compareSnapshots(snapA, snapB);
    
    if (table) {
      return { content: [{ type: "text", text: JSON.stringify({ [table]: diff[table] || { added: [], removed: [] } }, null, 2) }] };
    }
    
    const summary = {};
    for (const [t, changes] of Object.entries(diff)) {
      summary[t] = { added: changes.added.length, removed: changes.removed.length };
    }
    
    return { content: [{ type: "text", text: JSON.stringify({ summary, details: diff }, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Redis Tools ---

async function sidekick_redis({ action, key, value, ttl, pattern }) {
  try {
    const conn = await redisStore.testConnection();
    if (!conn.connected) {
      return { content: [{ type: "text", text: `Error: Redis not available (${conn.error}). Start with: sudo systemctl start sidekick-redis` }], isError: true };
    }

    if (action === "get") {
      if (!key) return { content: [{ type: "text", text: "Error: key is required for get" }], isError: true };
      const val = await redisStore.get(key);
      return { content: [{ type: "text", text: val !== null ? val : "(nil)" }] };
    }

    if (action === "set") {
      if (!key || value === undefined) return { content: [{ type: "text", text: "Error: key and value are required for set" }], isError: true };
      const ttlSec = ttl ? parseInt(ttl) : undefined;
      await redisStore.set(key, value, ttlSec);
      return { content: [{ type: "text", text: `OK${ttlSec ? ` (TTL: ${ttlSec}s)` : ""}` }] };
    }

    if (action === "del") {
      if (!key) return { content: [{ type: "text", text: "Error: key is required for del" }], isError: true };
      const deleted = await redisStore.del(key);
      return { content: [{ type: "text", text: `Deleted: ${deleted}` }] };
    }

    if (action === "keys") {
      const keys = await redisStore.keys(pattern || "*");
      return { content: [{ type: "text", text: JSON.stringify(keys, null, 2) }] };
    }

    if (action === "ttl") {
      if (!key) return { content: [{ type: "text", text: "Error: key is required for ttl" }], isError: true };
      const ttlVal = await redisStore.ttl(key);
      return { content: [{ type: "text", text: `${ttlVal}` }] };
    }

    if (action === "info") {
      const info = await redisStore.info();
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }

    if (action === "flush") {
      await redisStore.flush();
      return { content: [{ type: "text", text: "Redis database flushed" }] };
    }

    return { content: [{ type: "text", text: "Error: unknown action. Use: get, set, del, keys, ttl, info, flush" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- OCR Tool ---

async function sidekick_ocr({ path: imagePath, language, psm }) {
  try {
    const policyError = enforcePathPolicy(imagePath, "read");
    if (policyError) return policyError;
    if (!fs.existsSync(imagePath)) {
      return { content: [{ type: "text", text: `Error: File not found: ${imagePath}` }], isError: true };
    }

    const lang = language || "eng";
    const psmFlag = psm !== undefined ? `--psm ${psm}` : "";
    const cmd = `tesseract "${imagePath}" stdout -l ${lang} ${psmFlag} 2>/dev/null`;
    const result = execSync(cmd, { timeout: 30000 }).toString().trim();

    return { content: [{ type: "text", text: result || "(no text detected)" }] };
  } catch (e) {
    if (e.message.includes("not found") || e.message.includes("ENOENT")) {
      return { content: [{ type: "text", text: "Error: tesseract not installed. Run: sudo apt install tesseract-ocr" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Media Tool ---

async function sidekick_media({ action, input, output, options }) {
  try {
    if (!input) {
      return { content: [{ type: "text", text: "Error: input is required" }], isError: true };
    }
    const inputPolicyError = enforcePathPolicy(input, "read");
    if (inputPolicyError) return inputPolicyError;
    if (output) {
      const outputPolicyError = enforcePathPolicy(output, "write");
      if (outputPolicyError) return outputPolicyError;
    }

    if (action === "info") {
      const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${input}" 2>/dev/null`;
      const result = execSync(cmd, { timeout: 15000 }).toString();
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "convert") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for convert" }], isError: true };
      const opts = options || "";
      const cmd = `ffmpeg -y -i "${input}" ${opts} "${output}" 2>&1`;
      execSync(cmd, { timeout: 300000 });
      return { content: [{ type: "text", text: `Converted: ${input} -> ${output}` }] };
    }

    if (action === "extract_audio") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for extract_audio" }], isError: true };
      const opts = options || "-vn -acodec libmp3lame -q:a 2";
      const cmd = `ffmpeg -y -i "${input}" ${opts} "${output}" 2>&1`;
      execSync(cmd, { timeout: 300000 });
      return { content: [{ type: "text", text: `Extracted audio: ${input} -> ${output}` }] };
    }

    if (action === "thumbnail") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for thumbnail" }], isError: true };
      const time = options || "00:00:01";
      const cmd = `ffmpeg -y -i "${input}" -ss ${time} -vframes 1 -q:v 2 "${output}" 2>&1`;
      execSync(cmd, { timeout: 30000 });
      return { content: [{ type: "text", text: `Thumbnail created: ${input} -> ${output}` }] };
    }

    if (action === "resize") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for resize" }], isError: true };
      const scale = options || "800:-1";
      const cmd = `ffmpeg -y -i "${input}" -vf scale=${scale} "${output}" 2>&1`;
      execSync(cmd, { timeout: 120000 });
      return { content: [{ type: "text", text: `Resized: ${input} -> ${output} (${scale})` }] };
    }

    if (action === "trim") {
      if (!output) return { content: [{ type: "text", text: "Error: output is required for trim" }], isError: true };
      const opts = options || "";
      const cmd = `ffmpeg -y -i "${input}" ${opts} "${output}" 2>&1`;
      execSync(cmd, { timeout: 300000 });
      return { content: [{ type: "text", text: `Trimmed: ${input} -> ${output}` }] };
    }

    return { content: [{ type: "text", text: "Error: unknown action. Use: info, convert, extract_audio, thumbnail, resize, trim" }], isError: true };
  } catch (e) {
    if (e.message.includes("not found") || e.message.includes("ENOENT")) {
      return { content: [{ type: "text", text: "Error: ffmpeg not installed. Run: sudo apt install ffmpeg" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Transcribe Tool ---

async function sidekick_transcribe({ path: audioPath, model, language }) {
  try {
    const policyError = enforcePathPolicy(audioPath, "read");
    if (policyError) return policyError;
    if (!fs.existsSync(audioPath)) {
      return { content: [{ type: "text", text: `Error: File not found: ${audioPath}` }], isError: true };
    }

    const m = model || "base";
    const langFlag = language ? `--language ${language}` : "";
    const venvPath = "/home/sidekick/.sidekick-tools/bin/whisper";
    const whisperCmd = fs.existsSync(venvPath) ? venvPath : "whisper";
    const cmd = `${whisperCmd} "${audioPath}" --model ${m} ${langFlag} --output_format txt --output_dir /tmp 2>&1`;
    const result = execSync(cmd, { timeout: 600000 }).toString();

    const txtPath = audioPath.replace(/\.[^.]+$/, ".txt");
    const tmpTxtPath = `/tmp/${path.basename(audioPath).replace(/\.[^.]+$/, ".txt")}`;
    if (fs.existsSync(tmpTxtPath)) {
      const text = fs.readFileSync(tmpTxtPath, "utf-8").trim();
      fs.unlinkSync(tmpTxtPath);
      return { content: [{ type: "text", text: text || "(no speech detected)" }] };
    }

    return { content: [{ type: "text", text: result || "(no speech detected)" }] };
  } catch (e) {
    if (e.message.includes("not found") || e.message.includes("ENOENT")) {
      return { content: [{ type: "text", text: "Error: whisper not installed. Run: pip3 install openai-whisper" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Analytics Tool ---

async function sidekick_analytics({ query, file, format }) {
  try {
    const venvPath = "/home/sidekick/.sidekick-tools/bin/python3";
    const pythonCmd = fs.existsSync(venvPath) ? venvPath : "python3";

    // Helper: run Python script via temp file to avoid shell escaping issues
    const runPyScript = (pyScript) => {
      const tmpFile = path.join(os.tmpdir(), "sidekick_analytics_" + Date.now() + ".py");
      try {
        fs.writeFileSync(tmpFile, pyScript);
        return execSync(pythonCmd + " " + tmpFile + " 2>&1", { timeout: 60000 }).toString();
      } finally {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
      }
    };

    if (file) {
      const policyError = enforcePathPolicy(file, "read");
      if (policyError) return policyError;
      if (!fs.existsSync(file)) {
        return { content: [{ type: "text", text: "Error: File not found: " + file }], isError: true };
      }

      const sql = query || "SELECT * FROM data LIMIT 100";
      const fmt = format || "csv";
      // Pass all parameters via JSON to avoid escaping issues
      const params = JSON.stringify({ file, sql, fmt });
      const pyScript = `import duckdb, json, sys
params = json.loads(${JSON.stringify(params)})
con = duckdb.connect()
f = params["file"]
if params["fmt"] == "csv":
    con.execute(f"CREATE TABLE data AS SELECT * FROM read_csv_auto('{f}')")
elif params["fmt"] == "json":
    con.execute(f"CREATE TABLE data AS SELECT * FROM read_json_auto('{f}')")
elif params["fmt"] == "parquet":
    con.execute(f"CREATE TABLE data AS SELECT * FROM read_parquet('{f}')")
result = con.execute(params["sql"]).fetchdf()
print(result.to_string(index=False))
`;
      const result = runPyScript(pyScript);
      return { content: [{ type: "text", text: result }] };
    }

    if (query) {
      const params = JSON.stringify({ query });
      const pyScript = `import duckdb, json, sys
params = json.loads(${JSON.stringify(params)})
con = duckdb.connect()
result = con.execute(params["query"]).fetchdf()
print(result.to_string(index=False))
`;
      const result = runPyScript(pyScript);
      return { content: [{ type: "text", text: result }] };
    }

    return { content: [{ type: "text", text: "Error: query or file is required" }], isError: true };
  } catch (e) {
    if (e.message.includes("not found") || e.message.includes("ModuleNotFoundError")) {
      return { content: [{ type: "text", text: "Error: DuckDB not installed. Run: pip3 install duckdb" }], isError: true };
    }
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}


// --- Insight Report Tool ---

const INSIGHT_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".log", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".ini", ".csv", ".tsv"]);
const INSIGHT_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"]);
const INSIGHT_MAX_BYTES = 512 * 1024;

function normalizeInsightPaths(paths) {
  if (Array.isArray(paths)) return paths.map(String).map(s => s.trim()).filter(Boolean);
  return String(paths || "").split(",").map(s => s.trim()).filter(Boolean);
}

function inferInsightType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (INSIGHT_IMAGE_EXTENSIONS.has(ext)) return "image";
  if ([".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".ini"].includes(ext)) return "data";
  if (INSIGHT_TEXT_EXTENSIONS.has(ext)) return "text";
  return "unknown";
}

function readInsightTextFile(filePath) {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, INSIGHT_MAX_BYTES);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return {
      text: buffer.toString("utf-8").replace(/\0/g, ""),
      truncated: stat.size > INSIGHT_MAX_BYTES,
      bytes: stat.size
    };
  } finally {
    fs.closeSync(fd);
  }
}

function summarizeInsightText(text) {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.map(line => line.trim()).filter(Boolean);
  const errorLines = nonEmpty.filter(line => /\b(error|failed|exception|fatal|warn|timeout|denied)\b/i.test(line)).slice(0, 8);
  const counts = new Map();
  for (const line of nonEmpty) counts.set(line, (counts.get(line) || 0) + 1);
  const repeated = [...counts.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    lines: lines.length,
    nonEmpty: nonEmpty.length,
    sample: nonEmpty.slice(0, 6),
    errorLines,
    repeated
  };
}

function extractInsightTimeline(text) {
  const important = /\b(error|failed|exception|fatal|warn|timeout|denied|restart|started|listening|initialize|session|stale|replacement|invalid|deploy|crash|oom)\b/i;
  const timestamped = /^.*(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}).*$/;
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && timestamped.test(line) && important.test(line))
    .slice(0, 12);
}

function inferInsightAnalysis(evidenceItems) {
  const valid = evidenceItems.filter(item => !item.error);
  const allText = valid.map(item => [
    ...(item.sample || []),
    ...(item.errorLines || []),
    ...(item.timeline || []),
    item.ocrText || ""
  ].join("\n")).join("\n");
  const lower = allText.toLowerCase();
  const hasRestart = /\b(restart|systemctl restart|started|listening|deployment|deploy)\b/.test(lower);
  const hasStaleSession = /stale_session|stale session|invalid_session|invalid session|replacement session|replacementid|created_replacement_session/i.test(allText);
  const hasSuccessAfter = /reuse_session|session_initialized|created_new_transport|accepted|succeed|success/i.test(allText);
  const hasResourcePressure = /\b(oom|out of memory|disk full|no space|cpu|load average|killed process)\b/i.test(allText);
  const hasErrors = valid.some(item => item.errorLines?.length);

  let summary = "The supplied evidence was analyzed for timeline, failure signals, likely cause, and follow-up actions.";
  let rootCause = "No single root cause is proven by the supplied files. The strongest signals are the cited errors, warnings, repeated lines, and event ordering below.";
  let confidence = hasErrors ? "Medium" : "Low";
  const actions = [
    "Collect a narrower time window around the next occurrence, including service logs before and after the first failure.",
    "Add or verify log lines that include request/session identifiers, response status, and recovery outcome.",
    "Re-run this report with deployment logs, service logs, and any client-side error output together."
  ];

  if (hasRestart && hasStaleSession) {
    summary = "The intermittent failures align with clients reusing MCP session IDs that existed before a service restart.";
    rootCause = "The likely root cause is post-deployment session invalidation: restarting sidekick-mcp clears the in-memory session registry, while existing clients continue sending pre-restart session IDs. The server then returns an invalid-session response until the client adopts the replacement session or initializes a new one.";
    confidence = hasSuccessAfter ? "High" : "Medium-High";
    actions.splice(0, actions.length,
      "Verify clients reliably retry with the replacement session ID after invalid-session responses.",
      "Make deployment/restart workflows warn that active MCP sessions may be briefly invalidated.",
      "Consider graceful drain/restart behavior so active sessions finish before the MCP process exits.",
      "If seamless restarts are required, persist enough session metadata to recover or explicitly force client reinitialization.",
      "Track invalid-session responses as a deployment-adjacent metric so expected recovery can be distinguished from real outages."
    );
  } else if (hasResourcePressure) {
    summary = "The evidence contains resource-pressure indicators that may explain intermittent failures.";
    rootCause = "The likely root cause is resource exhaustion or process interruption, based on memory/disk/CPU/process-kill signals in the supplied evidence.";
    confidence = "Medium";
    actions.splice(0, actions.length,
      "Check host memory, disk, CPU, and service restart history for the failure window.",
      "Add alerts for the specific pressure signal seen in the evidence.",
      "Capture process logs and system journal entries immediately before the next failure."
    );
  }

  return { summary, rootCause, confidence, actions };
}

function summarizeInsightData(text, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const trimmed = text.trim();
  if ((ext === ".json" || trimmed.startsWith("{") || trimmed.startsWith("[")) && ext !== ".jsonl") {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const keys = [...new Set(parsed.slice(0, 50).flatMap(row => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []))];
      return { format: "json", rows: parsed.length, fields: keys.slice(0, 20), sample: parsed.slice(0, 3) };
    }
    return { format: "json", topLevelKeys: Object.keys(parsed || {}).slice(0, 20), sample: parsed };
  }
  if (ext === ".jsonl") {
    const rows = trimmed.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const keys = [...new Set(rows.slice(0, 50).flatMap(row => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []))];
    return { format: "jsonl", rows: rows.length, fields: keys.slice(0, 20), sample: rows.slice(0, 3) };
  }
  if (ext === ".csv" || ext === ".tsv" || detectFormat(text) === "csv") {
    const delimiter = ext === ".tsv" ? "\t" : ",";
    const rows = text.trim().split(/\r?\n/).filter(Boolean);
    const headers = rows[0] ? rows[0].split(delimiter).map(h => h.trim().replace(/^"(.*)"$/, "$1")) : [];
    return { format: ext === ".tsv" ? "tsv" : "csv", rows: Math.max(rows.length - 1, 0), columns: headers.length, fields: headers.slice(0, 20), sample: rows.slice(1, 4) };
  }
  if (ext === ".yaml" || ext === ".yml") {
    const parsed = YAML.parse(text);
    return { format: "yaml", topLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : [], sample: parsed };
  }
  if (ext === ".ini") {
    const parsed = INI.parse(text);
    return { format: "ini", topLevelKeys: Object.keys(parsed || {}).slice(0, 20), sample: parsed };
  }
  if (ext === ".xml") {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(text);
    return { format: "xml", topLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : [], sample: parsed };
  }
  return null;
}

function formatInsightValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "N/A";
  return text.length > 220 ? text.slice(0, 217) + "..." : text;
}

async function collectInsightEvidence(filePath) {
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return { path: filePath, error: policyError.content[0].text };
  if (!fs.existsSync(filePath)) return { path: filePath, error: "File not found" };

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { path: filePath, error: "Path is not a file" };

  const type = inferInsightType(filePath);
  const evidence = { path: filePath, type, bytes: stat.size, findings: [] };

  if (type === "image") {
    evidence.findings.push(`image file, ${stat.size} bytes`);
    const ocr = await sidekick_ocr({ path: filePath });
    if (ocr.isError) {
      evidence.findings.push("OCR unavailable: " + ocr.content[0].text.replace(/^Error:\s*/, ""));
    } else {
      const text = ocr.content[0].text.trim();
      evidence.ocrText = text;
      evidence.findings.push(text && text !== "(no text detected)" ? `OCR text: ${formatInsightValue(text)}` : "OCR found no text");
    }
    return evidence;
  }

  if (type === "unknown") {
    evidence.findings.push("unsupported file extension for deterministic inspection");
    return evidence;
  }

  const file = readInsightTextFile(filePath);
  evidence.truncated = file.truncated;
  const textSummary = summarizeInsightText(file.text);
  evidence.findings.push(`${textSummary.lines} lines, ${textSummary.nonEmpty} non-empty lines${file.truncated ? ", sampled first 512 KiB" : ""}`);

  if (type === "data") {
    try {
      const dataSummary = summarizeInsightData(file.text, filePath);
      if (dataSummary) {
        evidence.data = dataSummary;
        if (dataSummary.rows !== undefined) evidence.findings.push(`${dataSummary.format} data with ${dataSummary.rows} rows`);
        if (dataSummary.fields?.length) evidence.findings.push(`fields: ${dataSummary.fields.join(", ")}`);
        if (dataSummary.topLevelKeys?.length) evidence.findings.push(`top-level keys: ${dataSummary.topLevelKeys.join(", ")}`);
      }
    } catch (e) {
      evidence.findings.push("data parse failed: " + e.message);
    }
  }

  if (textSummary.errorLines.length) evidence.findings.push(`${textSummary.errorLines.length} error/warning-looking lines found`);
  if (textSummary.repeated.length) evidence.findings.push(`repeated lines: ${textSummary.repeated.map(([line, count]) => `${count}x ${formatInsightValue(line)}`).join("; ")}`);
  evidence.sample = textSummary.sample;
  evidence.errorLines = textSummary.errorLines;
  evidence.timeline = extractInsightTimeline(file.text);
  return evidence;
}

function formatInsightReport(evidenceItems, title) {
  const valid = evidenceItems.filter(item => !item.error);
  const errored = evidenceItems.filter(item => item.error);
  const analysis = inferInsightAnalysis(evidenceItems);
  const lines = [`# ${title || "Insight Report"}`, "", "## Summary"];
  lines.push(`- Analyzed ${valid.length} file(s); ${errored.length} file(s) had errors.`);
  const dataCount = valid.filter(item => item.type === "data").length;
  const imageCount = valid.filter(item => item.type === "image").length;
  const textCount = valid.filter(item => item.type === "text").length;
  lines.push(`- Inputs by type: ${textCount} text, ${dataCount} data, ${imageCount} image.`);
  lines.push(`- ${analysis.summary}`);

  const timeline = valid.flatMap(item => (item.timeline || []).map(event => ({ path: item.path, event })));
  if (timeline.length) {
    lines.push("", "## Timeline");
    for (const item of timeline.slice(0, 12)) lines.push(`- ${formatInsightValue(item.event)} [${item.path}]`);
  }

  lines.push("", "## Likely Root Cause");
  lines.push(`- ${analysis.rootCause}`);

  lines.push("", "## Confidence");
  lines.push(`- ${analysis.confidence}`);

  const notable = valid.flatMap(item => item.findings.map(finding => ({ path: item.path, finding })));
  if (notable.length) {
    lines.push("", "## Key Findings");
    for (const item of notable.slice(0, 12)) lines.push(`- ${item.finding} [${item.path}]`);
  }

  lines.push("", "## Evidence");
  for (const item of evidenceItems) {
    lines.push(`- ${item.path}`);
    if (item.error) {
      lines.push(`  Error: ${item.error}`);
      continue;
    }
    lines.push(`  Type: ${item.type}; Size: ${item.bytes} bytes`);
    if (item.sample?.length) lines.push(`  Sample: ${item.sample.map(formatInsightValue).join(" | ")}`);
    if (item.errorLines?.length) lines.push(`  Error evidence: ${item.errorLines.map(formatInsightValue).join(" | ")}`);
    if (item.data?.sample) lines.push(`  Data sample: ${formatInsightValue(item.data.sample)}`);
    if (item.ocrText) lines.push(`  OCR evidence: ${formatInsightValue(item.ocrText)}`);
  }

  lines.push("", "## Limits");
  lines.push(`- Text/data files are bounded to the first ${INSIGHT_MAX_BYTES} bytes.`);
  lines.push("- Analysis is deterministic and evidence-pattern based; it does not use an LLM or external context.");

  lines.push("", "## Next Actions");
  for (const action of analysis.actions) lines.push(`- ${action}`);
  return lines.join("\n");
}

async function sidekick_insight_report({ paths, title }) {
  try {
    const selectedPaths = normalizeInsightPaths(paths);
    if (selectedPaths.length === 0) {
      return { content: [{ type: "text", text: "Error: paths is required" }], isError: true };
    }
    if (selectedPaths.length > 10) {
      return { content: [{ type: "text", text: "Error: at most 10 paths are supported per report" }], isError: true };
    }
    const evidence = [];
    for (const filePath of selectedPaths) evidence.push(await collectInsightEvidence(filePath));
    return { content: [{ type: "text", text: formatInsightReport(evidence, title) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}


// --- Embed Tool ---

async function sidekick_embed({ text, model }) {
  try {
    const m = model || "nomic-embed-text";
    const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

    const response = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, prompt: text }),
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 404) {
        return { content: [{ type: "text", text: `Error: Model '${m}' not found. Pull it with: ollama pull ${m}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Error: Ollama request failed (${response.status}): ${errText}` }], isError: true };
    }

    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify({ embedding: data.embedding, dimensions: data.embedding?.length, model: m }, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Ollama Tool ---

async function sidekick_ollama({ action, model }) {
  try {
    const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

    if (action === "list") {
      const response = await fetch(`${ollamaUrl}/api/tags`);
      if (!response.ok) {
        return { content: [{ type: "text", text: `Error: Failed to list models (${response.status})` }], isError: true };
      }
      const data = await response.json();
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
        digest: m.digest?.substring(0, 12)
      }));
      return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
    }

    if (action === "ps") {
      const response = await fetch(`${ollamaUrl}/api/ps`);
      if (!response.ok) {
        return { content: [{ type: "text", text: `Error: Failed to list running models (${response.status})` }], isError: true };
      }
      const data = await response.json();
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        digest: m.digest?.substring(0, 12),
        expires_at: m.expires_at
      }));
      return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
    }

    if (action === "pull") {
      if (!model) {
        return { content: [{ type: "text", text: "Error: model name required" }], isError: true };
      }
      const response = await fetch(`${ollamaUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model, stream: false }),
      });
      if (!response.ok) {
        const errText = await response.text();
        return { content: [{ type: "text", text: `Error: Failed to pull model (${response.status}): ${errText}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Successfully pulled model: ${model}` }] };
    }

    if (action === "show") {
      if (!model) {
        return { content: [{ type: "text", text: "Error: model name required" }], isError: true };
      }
      const response = await fetch(`${ollamaUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
      });
      if (!response.ok) {
        return { content: [{ type: "text", text: `Error: Failed to show model (${response.status})` }], isError: true };
      }
      const data = await response.json();
      return { content: [{ type: "text", text: JSON.stringify({
        name: data.details?.family,
        parameter_size: data.details?.parameter_size,
        quantization_level: data.details?.quantization_level,
        template: data.template,
        system: data.system
      }, null, 2) }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: list, ps, pull, show" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Cloudflared Tool ---

async function sidekick_tunnel({ action, url, port, name }) {
  try {
    if (action === "start") {
      if (!port) {
        return { content: [{ type: "text", text: "Error: port required" }], isError: true };
      }
      const tunnelName = name || `tunnel-${Date.now()}`;
      const cmd = `cloudflared tunnel --url http://localhost:${port} --name ${tunnelName} > /tmp/${tunnelName}.log 2>&1 &`;
      execSync(cmd, { timeout: 5000 });
      // Wait a moment for tunnel to establish
      await new Promise(resolve => setTimeout(resolve, 3000));
      // Try to get the tunnel URL from logs
      try {
        const logContent = fs.readFileSync(`/tmp/${tunnelName}.log`, 'utf8');
        const urlMatch = logContent.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        const tunnelUrl = urlMatch ? urlMatch[0] : null;
        return { content: [{ type: "text", text: JSON.stringify({
          name: tunnelName,
          port: port,
          url: tunnelUrl,
          status: "started",
          log: `/tmp/${tunnelName}.log`
        }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({
          name: tunnelName,
          port: port,
          status: "started",
          note: "Tunnel started but URL not yet available. Check logs with: cat /tmp/" + tunnelName + ".log"
        }, null, 2) }] };
      }
    }

    if (action === "stop") {
      if (!name) {
        return { content: [{ type: "text", text: "Error: tunnel name required" }], isError: true };
      }
      try {
        execSync(`pkill -f "cloudflared tunnel.*--name ${name}"`, { timeout: 5000 });
        return { content: [{ type: "text", text: `Stopped tunnel: ${name}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Tunnel not found or already stopped: ${name}` }] };
      }
    }

    if (action === "list") {
      try {
        const result = execSync('ps aux | grep "cloudflared tunnel" | grep -v grep', { timeout: 5000 }).toString();
        const tunnels = result.split('\n').filter(line => line.trim()).map(line => {
          const nameMatch = line.match(/--name\s+(\S+)/);
          const portMatch = line.match(/--url\s+http:\/\/localhost:(\d+)/);
          return {
            name: nameMatch ? nameMatch[1] : "unknown",
            port: portMatch ? portMatch[1] : "unknown",
            pid: line.split(/\s+/)[1]
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(tunnels, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "No active tunnels" }] };
      }
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: start, stop, list" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- yt-dlp Tool ---

async function sidekick_download({ url, output, format, audio_only }) {
  try {
    if (!url) {
      return { content: [{ type: "text", text: "Error: url required" }], isError: true };
    }
    const outputTarget = output || "/tmp/%(title)s.%(ext)s";
    const outputPolicyError = enforcePathPolicy(outputTarget, "write");
    if (outputPolicyError) return outputPolicyError;

    const venvPath = "/home/sidekick/.sidekick-tools/bin/yt-dlp";
    const ytdlpCmd = fs.existsSync(venvPath) ? venvPath : "yt-dlp";
    
    let cmd = `${ytdlpCmd} --no-playlist`;
    
    if (audio_only) {
      cmd += " -x --audio-format mp3";
    } else if (format) {
      cmd += ` -f "${format}"`;
    }
    
    cmd += ` -o "${outputTarget}"`;
    
    cmd += ` "${url}"`;
    
    const result = execSync(cmd, { timeout: 300000 }).toString();
    
    // Try to find the output file
    const outputMatch = result.match(/\[download\] Destination: (.+)/);
    const downloadedFile = outputMatch ? outputMatch[1] : null;
    
    return { content: [{ type: "text", text: JSON.stringify({
      status: "success",
      url: url,
      output: downloadedFile || "Downloaded",
      log: result.substring(0, 500)
    }, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- WireGuard Tool ---

async function sidekick_wireguard({ action, interface_name, peer_name, public_key, endpoint, allowed_ips }) {
  try {
    if (action === "status") {
      const result = execSync("sudo wg show all 2>&1", { timeout: 5000 }).toString();
      if (!result.trim()) {
        return { content: [{ type: "text", text: "No WireGuard interfaces found" }] };
      }
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "list_peers") {
      if (!interface_name) {
        return { content: [{ type: "text", text: "Error: interface_name required" }], isError: true };
      }
      const result = execSync(`sudo wg show ${interface_name} peers 2>&1`, { timeout: 5000 }).toString();
      const peers = result.trim().split('\n').filter(line => line && !line.startsWith('Warning')).map(line => {
        const parts = line.split('\t');
        return {
          public_key: parts[0],
          endpoint: parts[1] || 'none',
          allowed_ips: parts[2] || 'none',
          latest_handshake: parts[3] || 'never',
          transfer_rx: parts[4] || '0',
          transfer_tx: parts[5] || '0'
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(peers, null, 2) }] };
    }

    if (action === "add_peer") {
      if (!interface_name || !peer_name || !public_key) {
        return { content: [{ type: "text", text: "Error: interface_name, peer_name, and public_key required" }], isError: true };
      }
      const cmd = `sudo wg set ${interface_name} peer ${public_key} allowed-ips ${allowed_ips || '10.0.0.0/24'}${endpoint ? ` endpoint ${endpoint}` : ''}`;
      execSync(cmd, { timeout: 5000 });
      return { content: [{ type: "text", text: `Added peer ${peer_name} to ${interface_name}` }] };
    }

    if (action === "remove_peer") {
      if (!interface_name || !public_key) {
        return { content: [{ type: "text", text: "Error: interface_name and public_key required" }], isError: true };
      }
      execSync(`sudo wg set ${interface_name} peer ${public_key} remove`, { timeout: 5000 });
      return { content: [{ type: "text", text: `Removed peer from ${interface_name}` }] };
    }

    if (action === "generate_keypair") {
      const privateKey = execSync("wg genkey", { timeout: 5000 }).toString().trim();
      const publicKey = execSync(`echo "${privateKey}" | wg pubkey`, { timeout: 5000 }).toString().trim();
      return { content: [{ type: "text", text: JSON.stringify({ private_key: privateKey, public_key: publicKey }, null, 2) }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: status, list_peers, add_peer, remove_peer, generate_keypair" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Nginx Tool ---

async function sidekick_nginx({ action, site_name, domain, upstream_port, ssl_email }) {
  try {
    if (action === "status") {
      const result = execSync("sudo systemctl status nginx 2>&1 | head -20", { timeout: 5000 }).toString();
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "list_sites") {
      const result = execSync("ls -1 /etc/nginx/sites-enabled/ 2>&1", { timeout: 5000 }).toString();
      const sites = result.trim().split('\n').filter(s => s && s !== 'default');
      return { content: [{ type: "text", text: JSON.stringify(sites, null, 2) }] };
    }

    if (action === "add_site") {
      if (!site_name || !domain || !upstream_port) {
        return { content: [{ type: "text", text: "Error: site_name, domain, and upstream_port required" }], isError: true };
      }
      
      const config = `server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${upstream_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}`;

      fs.writeFileSync(`/tmp/${site_name}`, config);
      execSync(`sudo mv /tmp/${site_name} /etc/nginx/sites-available/${site_name}`);
      execSync(`sudo ln -sf /etc/nginx/sites-available/${site_name} /etc/nginx/sites-enabled/${site_name}`);
      
      // Test config
      const testResult = execSync("sudo nginx -t 2>&1", { timeout: 5000 }).toString();
      if (testResult.includes('successful')) {
        execSync("sudo systemctl reload nginx 2>&1", { timeout: 5000 });
        return { content: [{ type: "text", text: `Added site ${site_name} for ${domain} -> port ${upstream_port}` }] };
      } else {
        // Rollback
        execSync(`sudo rm -f /etc/nginx/sites-enabled/${site_name} /etc/nginx/sites-available/${site_name}`);
        return { content: [{ type: "text", text: `Error: Invalid nginx config: ${testResult}` }], isError: true };
      }
    }

    if (action === "remove_site") {
      if (!site_name) {
        return { content: [{ type: "text", text: "Error: site_name required" }], isError: true };
      }
      execSync(`sudo rm -f /etc/nginx/sites-enabled/${site_name} /etc/nginx/sites-available/${site_name}`);
      execSync("sudo systemctl reload nginx 2>&1", { timeout: 5000 });
      return { content: [{ type: "text", text: `Removed site ${site_name}` }] };
    }

    if (action === "test_config") {
      const result = execSync("sudo nginx -t 2>&1", { timeout: 5000 }).toString();
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "reload") {
      execSync("sudo systemctl reload nginx 2>&1", { timeout: 5000 });
      return { content: [{ type: "text", text: "Nginx reloaded" }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: status, list_sites, add_site, remove_site, test_config, reload" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Knowledge Tool ---

async function sidekick_knowledge({ action, id, category, title, content, tags, query, limit }) {
  try {
    const db = dbStore.getDb();
    const now = new Date().toISOString();

    if (action === "search") {
      if (!query) return { content: [{ type: "text", text: "Error: query is required for search" }], isError: true };
      const searchLimit = limit || 10;
      
      // Search in title, content, and tags
      const rows = db.prepare(`
        SELECT id, category, title, content, tags, updated_at
        FROM knowledge
        WHERE enabled = 1 AND (
          title LIKE ? OR
          content LIKE ? OR
          tags LIKE ?
        )
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, `%${query}%`, searchLimit);
      
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (action === "get") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for get" }], isError: true };
      const row = db.prepare(`
        SELECT id, category, title, content, tags, updated_at
        FROM knowledge
        WHERE id = ? AND enabled = 1
      `).get(id);
      
      if (!row) return { content: [{ type: "text", text: "Error: knowledge entry not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    }

    if (action === "list") {
      const listLimit = limit || 50;
      let rows;
      
      if (category) {
        rows = db.prepare(`
          SELECT id, category, title, tags, updated_at
          FROM knowledge
          WHERE enabled = 1 AND category = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(category, listLimit);
      } else {
        rows = db.prepare(`
          SELECT id, category, title, tags, updated_at
          FROM knowledge
          WHERE enabled = 1
          ORDER BY category, updated_at DESC
          LIMIT ?
        `).all(listLimit);
      }
      
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (action === "add") {
      if (!category || !title || !content) {
        return { content: [{ type: "text", text: "Error: category, title, and content are required for add" }], isError: true };
      }
      
      const result = db.prepare(`
        INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(category, title, content, tags || '', now, now);
      
      return { content: [{ type: "text", text: `Added knowledge entry with id: ${result.lastInsertRowid}` }] };
    }

    if (action === "update") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
      
      const updates = [];
      const params = [];
      
      if (category !== undefined) { updates.push("category = ?"); params.push(category); }
      if (title !== undefined) { updates.push("title = ?"); params.push(title); }
      if (content !== undefined) { updates.push("content = ?"); params.push(content); }
      if (tags !== undefined) { updates.push("tags = ?"); params.push(tags); }
      
      if (updates.length === 0) {
        return { content: [{ type: "text", text: "Error: at least one field to update is required" }], isError: true };
      }
      
      updates.push("updated_at = ?");
      params.push(now);
      params.push(id);
      
      db.prepare(`UPDATE knowledge SET ${updates.join(", ")} WHERE id = ? AND enabled = 1`).run(...params);
      
      return { content: [{ type: "text", text: `Updated knowledge entry ${id}` }] };
    }

    if (action === "delete") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
      db.prepare("UPDATE knowledge SET enabled = 0, updated_at = ? WHERE id = ?").run(now, id);
      return { content: [{ type: "text", text: `Soft-deleted knowledge entry ${id}` }] };
    }

    if (action === "purge") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for purge" }], isError: true };
      const row = db.prepare("SELECT id, enabled FROM knowledge WHERE id = ?").get(id);
      if (!row) return { content: [{ type: "text", text: "Error: knowledge entry not found" }], isError: true };
      if (row.enabled) {
        return { content: [{ type: "text", text: "Error: purge only removes disabled entries. Run action=delete first to soft-delete the entry." }], isError: true };
      }
      db.prepare("DELETE FROM knowledge WHERE id = ? AND enabled = 0").run(id);
      return { content: [{ type: "text", text: `Purged disabled knowledge entry ${id}` }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: search, get, list, add, update, delete, purge" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

// --- Metrics Tool ---

async function sidekick_metrics({ action, measurement, fields, tags, timestamp, query, time_range }) {
  try {
    const INFLUX_URL = process.env.SIDEKICK_INFLUX_URL || 'http://localhost:8086';
    const INFLUX_TOKEN = process.env.SIDEKICK_INFLUX_TOKEN || '';
    const INFLUX_ORG = process.env.SIDEKICK_INFLUX_ORG || 'sidekick';
    const INFLUX_BUCKET = process.env.SIDEKICK_INFLUX_BUCKET || 'sidekick';

    if (!INFLUX_TOKEN || INFLUX_TOKEN === 'sidekick-influx-token') {
      return { content: [{ type: "text", text: "Error: SIDEKICK_INFLUX_TOKEN must be set to a non-placeholder value" }], isError: true };
    }

    if (action === "write") {
      if (!measurement || !fields || typeof fields !== 'object') {
        return { content: [{ type: "text", text: "Error: measurement and fields object are required for write" }], isError: true };
      }

      // Build line protocol
      let line = measurement;
      
      // Add tags
      if (tags && typeof tags === 'object') {
        const tagPairs = Object.entries(tags).map(([k, v]) => `${k}=${v}`);
        if (tagPairs.length > 0) {
          line += ',' + tagPairs.join(',');
        }
      }
      
      // Add fields
      const fieldPairs = Object.entries(fields).map(([k, v]) => {
        if (typeof v === 'number') {
          return `${k}=${v}`;
        } else if (typeof v === 'boolean') {
          return `${k}=${v}`;
        } else {
          return `${k}="${String(v).replace(/"/g, '\\"')}"`;
        }
      });
      line += ' ' + fieldPairs.join(',');
      
      // Add timestamp
      const ts = timestamp || Date.now() * 1000000; // nanoseconds
      line += ' ' + ts;

      // Write to InfluxDB
      const response = await fetch(`${INFLUX_URL}/api/v2/write?org=${INFLUX_ORG}&bucket=${INFLUX_BUCKET}&precision=ns`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${INFLUX_TOKEN}`,
          'Content-Type': 'text/plain; charset=utf-8'
        },
        body: line
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: "text", text: `Error writing to InfluxDB: ${response.status} - ${errorText}` }], isError: true };
      }

      return { content: [{ type: "text", text: `Successfully wrote metric: ${measurement}` }] };
    }

    if (action === "query") {
      if (!query) {
        return { content: [{ type: "text", text: "Error: query is required for query action" }], isError: true };
      }

      const response = await fetch(`${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${INFLUX_TOKEN}`,
          'Content-Type': 'application/vnd.flux',
          'Accept': 'application/json'
        },
        body: query
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: "text", text: `Error querying InfluxDB: ${response.status} - ${errorText}` }], isError: true };
      }

      const result = await response.text();
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "list_measurements") {
      const fluxQuery = `from(bucket: "${INFLUX_BUCKET}")
  |> range(start: -30d)
  |> group()
  |> distinct(column: "_measurement")
  |> keep(columns: ["_measurement"])`;

      const response = await fetch(`${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${INFLUX_TOKEN}`,
          'Content-Type': 'application/vnd.flux',
          'Accept': 'application/json'
        },
        body: fluxQuery
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: "text", text: `Error listing measurements: ${response.status} - ${errorText}` }], isError: true };
      }

      const result = await response.text();
      return { content: [{ type: "text", text: result }] };
    }

    if (action === "list_fields") {
      if (!measurement) {
        return { content: [{ type: "text", text: "Error: measurement is required for list_fields" }], isError: true };
      }

      const range = time_range || '-30d';
      const fluxQuery = `from(bucket: "${INFLUX_BUCKET}")
  |> range(start: ${range})
  |> filter(fn: (r) => r._measurement == "${measurement}")
  |> group()
  |> distinct(column: "_field")
  |> keep(columns: ["_field"])`;

      const response = await fetch(`${INFLUX_URL}/api/v2/query?org=${INFLUX_ORG}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${INFLUX_TOKEN}`,
          'Content-Type': 'application/vnd.flux',
          'Accept': 'application/json'
        },
        body: fluxQuery
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: "text", text: `Error listing fields: ${response.status} - ${errorText}` }], isError: true };
      }

      const result = await response.text();
      return { content: [{ type: "text", text: result }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: write, query, list_measurements, list_fields" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

const TOOLS = {
  sidekick_bash,
  sidekick_tools,
  sidekick_read,
  sidekick_write,
  sidekick_store,
  sidekick_get,
  sidekick_delete,
  sidekick_resume,
  sidekick_list,
  sidekick_web_fetch,
  sidekick_llm,
  sidekick_list_projects,
  sidekick_get_by_project,
  sidekick_search,
  sidekick_git,
  sidekick_notify,
  sidekick_process,
  sidekick_service,
  sidekick_archive,
  sidekick_cron,
  sidekick_github,
  sidekick_ci_status,
  sidekick_webhook,
  sidekick_context,
  sidekick_teach,
  sidekick_transform,
  sidekick_health,
  sidekick_delay,
  sidekick_snapshot,
  sidekick_watch,
  sidekick_secret,
  sidekick_security_scan,
  sidekick_parse,
  sidekick_diff,
  sidekick_hash,
  sidekick_validate,
  sidekick_template,
  sidekick_queue,
  sidekick_retry,
  sidekick_evolve,
  sidekick_orchestrate,
  sidekick_predict,
  sidekick_debug_tool,
  sidekick_fresheyes,
  sidekick_batch,
  sidekick_cache,
  sidekick_summarize,
  sidekick_filter,
  sidekick_project,
  sidekick_memory_export,
  sidekick_memory_import,
  sidekick_memory_manage,
  sidekick_sync_identity,
  sidekick_sync_export,
  sidekick_sync_import,
  sidekick_sync_diff,
  sidekick_tail,
  sidekick_diff_files,
  sidekick_find,
  sidekick_status,
  sidekick_extract,
  sidekick_anonymize,
  sidekick_sandbox,
  sidekick_changelog,
  sidekick_netdiag,
  sidekick_timeline,
  sidekick_circuit,
  sidekick_baseline,
  sidekick_depend,
  sidekick_runbook,
  sidekick_ops,
  sidekick_mission,
  sidekick_black_box,
  sidekick_respond,
  sidekick_db_schema,
  sidekick_db_query,
  sidekick_db_stats,
  sidekick_db_backup,
  sidekick_db_restore,
  sidekick_log_query,
  sidekick_db_export,
  sidekick_db_search,
  sidekick_db_migrate,
  sidekick_db_diff,
  sidekick_redis,
  sidekick_ocr,
  sidekick_media,
  sidekick_transcribe,
  sidekick_analytics,
  sidekick_insight_report,
  sidekick_embed,
  sidekick_ollama,
  sidekick_tunnel,
  sidekick_download,
  sidekick_wireguard,
  sidekick_nginx,
  sidekick_knowledge,
  sidekick_metrics,
};

const TOOL_DEFS = [
  { name: "sidekick_bash", description: "Execute a shell command on the remote machine", args: { command: "string" } },
  { name: "sidekick_tools", description: "Tool catalog, discovery manifest, and policy inspector. Use for broad questions like 'what Sidekick tools are available?', 'list available tools', 'tool overview', 'tool manifest', or 'why is this tool blocked?'. Lists tools grouped by category, searches by capability, gets exact tool metadata, and inspects effective policy/approval decisions.", args: { action: "string (overview|search|get|policy - default overview)", query: "string (optional, search terms for action=search)", name: "string (optional, tool name for action=get or action=policy)", category: "string (optional, filter by category)", source: "string (optional, comma-separated sources for action=policy; default mcp,dashboard,agent)", format: "string (optional, text|json - default text)", include_disabled: "boolean (optional, include policy-disabled tools - default false; action=policy includes them by default)", limit: "number (optional, max search results - default 100)" } },
  { name: "sidekick_read", description: "Read a file from the remote filesystem", args: { path: "string" } },
  { name: "sidekick_write", description: "Write content to a file on the remote machine", args: { path: "string", content: "string" } },
  { name: "sidekick_list", description: "List files and directories on the remote machine", args: { path: "string" } },
  { name: "sidekick_store", description: "Store a value persistently in KV storage", args: { key: "string", value: "string", project: "string (optional)" } },
  { name: "sidekick_get", description: "Retrieve a stored value from KV storage", args: { key: "string" } },
  { name: "sidekick_delete", description: "Delete a stored value from KV storage by key", args: { key: "string" } },
  { name: "sidekick_resume", description: "Manage first-class project resume handoffs stored in the resume document. Use to check, set, clear, or list pending work without relying on ad hoc KV keys.", args: { action: "string (check|set|clear|list - default check)", project: "string (required for check/set/clear)", summary: "string (optional, for set)", next_step: "string (optional, for set)", status: "string (optional, for set - default active)", branch: "string (optional, for set)", url: "string (optional, for set)", notes: "string (optional)", plan_name: "string (optional, for set - descriptive handoff plan name)", current_phase: "number (optional, for set - current phase number within the named plan)", include_cleared: "boolean (optional, for list)", format: "string (optional, text|json - default text)" } },
  { name: "sidekick_web_fetch", description: "Fetch a URL from the remote machine", args: { url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" } },
  { name: "sidekick_llm", description: "Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq)", args: { prompt: "string", system: "string (optional)", temperature: "number (optional)", provider: "string (optional, 'ollama' or 'groq' - default from SIDEKICK_DEFAULT_LLM env var or 'ollama')" } },
  { name: "sidekick_list_projects", description: "List all unique project names in KV storage", args: {} },
  { name: "sidekick_get_by_project", description: "Get all keys and values for a specific project", args: { project: "string" } },
  { name: "sidekick_search", description: "Search file contents using ripgrep or grep", args: { pattern: "string", path: "string (optional)", include: "string (optional)" } },
  { name: "sidekick_git", description: "Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash)", args: { action: "string", path: "string (optional)", args: "string (optional)" } },
  { name: "sidekick_notify", description: "Send notifications to Discord, Slack, or email", args: { channel: "string", webhook_url: "string (optional)", recipient: "string (optional)", message: "string", title: "string (optional)" } },
  { name: "sidekick_process", description: "Manage processes (list, top CPU/memory, kill, tree)", args: { action: "string", filter: "string (optional)", pid: "number (optional)", name: "string (optional)", signal: "string (optional)" } },
  { name: "sidekick_service", description: "Manage systemd services (start, stop, restart, status, enable, disable, logs)", args: { action: "string", service: "string", lines: "number (optional)" } },
  { name: "sidekick_archive", description: "Create, extract, or list archives (tar.gz, zip)", args: { action: "string", path: "string", output: "string (optional)", format: "string (optional)" } },
  { name: "sidekick_cron", description: "Schedule recurring tasks (add, list, remove, run jobs)", args: { action: "string", name: "string (optional)", schedule: "string (optional)", command: "string (optional)", id: "string (optional)" } },
  { name: "sidekick_github", description: "GitHub API integration (PRs, issues, commits, releases)", args: { action: "string", repo: "string", args: "string (optional)" } },
  { name: "sidekick_ci_status", description: "Read-only GitHub CI/check-run inspection for a PR head, commit SHA, ref, or branch", args: { repo: "string (owner/repository)", pr: "number|string (optional, PR number)", pull_number: "number|string (optional, PR number)", sha: "string (optional, commit SHA)", commit: "string (optional, commit SHA)", ref: "string (optional, branch/ref/SHA)", branch: "string (optional, branch name)", format: "string (optional, text|json - default text)" } },
  { name: "sidekick_webhook", description: "Manage received webhooks (list, get, clear)", args: { action: "string", id: "string (optional)", limit: "number (optional)" } },
  { name: "sidekick_context", description: "Persistent intelligent context management (track projects, decisions, problems, patterns, sessions, automatic memories; recall and suggest based on past context)", args: { action: "string", project: "string (optional)", context: "string (optional)", decision: "string (optional)", reasoning: "string (optional)", problem: "string (optional)", solution: "string (optional)", pattern: "string (optional)", query: "string (optional)", type: "string (optional: decisions|problems|patterns|projects|sessions|memories|all)", limit: "number (optional)" } },
  { name: "sidekick_teach", description: "Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows", args: { action: "string", name: "string (optional)", description: "string (optional)", steps: "array (optional)", parameters: "object (optional)", args: "object (optional)", example: "string (optional)", trigger_phrases: "array (optional)", implementation: "string (optional)" } },
  { name: "sidekick_transform", description: "Data manipulation pipeline: filter, extract, sort, format, and map data", args: { action: "string (filter|extract|sort|format|map)", input: "string", pattern: "string (optional, for filter)", field: "string (optional, for extract)", key: "string (optional, for sort/map)", value: "string (optional, for map)", format: "string (optional, for format: json|csv|table|text)" } },
  { name: "sidekick_health", description: "Composite system health checks with scoring and issue detection", args: { check: "string (all|services|processes|disk|network|custom)", services: "string (optional, comma-separated service names)", commands: "string (optional, comma-separated commands for custom check)", threshold: "string (optional, e.g. 'disk>90,mem>80')" } },
  { name: "sidekick_delay", description: "One-shot task scheduling: run a tool once at a specific time or after a delay", args: { action: "string (add|list|cancel|run)", id: "string (optional, for cancel/run)", when: "string (optional, e.g. 10s, 5m, 2h, 1d, or ISO date)", name: "string (optional, human-readable name)", tool: "string (optional, tool name to execute)", args: "object (optional, arguments for the tool)" } },
  { name: "sidekick_snapshot", description: "Capture system state and detect drift by comparing snapshots", args: { action: "string (capture|compare|list|delete)", name: "string (snapshot name)", capture: "string (optional, comma-separated: processes,services,disk,packages,network,files:/path)", compare: "string (optional, baseline snapshot name for compare action)" } },
  { name: "sidekick_watch", description: "Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions", args: { action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, URL, or file path)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" } },
  { name: "sidekick_secret", description: "Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env)", args: { action: "string (store|get|delete|list|rotate)", key: "string (secret name)", value: "string (optional, for store)", generate: "string (optional, length for rotate, e.g. '32')" } },
  { name: "sidekick_security_scan", description: "Read-only audit for tracked sensitive files, secret signatures, hardcoded credential settings, runtime .env safety, and sensitive-file permissions. Reports metadata only and never returns secret values.", args: { path: "string (optional, directory to scan - default Sidekick repo)", max_files: "number (optional, bounded 1-10000 - default 2000)", format: "string (optional, text|json - default text)" } },
  { name: "sidekick_parse", description: "Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection", args: { input: "string (data to parse)", format: "string (optional, json|yaml|xml|ini|csv - auto-detected if not specified)" } },
  { name: "sidekick_diff", description: "Semantic comparison of text, JSON, or YAML with structure-aware diffing", args: { old_text: "string (original content)", new_text: "string (modified content)", type: "string (optional, text|json|yaml|auto - default auto)", format: "string (optional, unified|summary|json - default unified)" } },
  { name: "sidekick_hash", description: "Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification", args: { input: "string (optional, data to hash)", path: "string (optional, file path to hash)", algorithm: "string (optional, md5|sha1|sha256|sha512 - default sha256)", verify: "string (optional, expected hash to verify against)" } },
  { name: "sidekick_validate", description: "Validate data against JSON Schema", args: { data: "string|object (data to validate)", schema: "string|object (JSON Schema)" } },
  { name: "sidekick_template", description: "Render Handlebars templates with data", args: { template: "string (Handlebars template)", data: "string|object (template data)" } },
  { name: "sidekick_queue", description: "Persistent task queue with priorities", args: { action: "string (add|list|process|remove|clear)", id: "number (optional, task id for remove)", tool: "string (optional, tool name for add)", args: "object (optional, tool args for add)", priority: "number (optional, priority for add, default 0)", status: "string (optional, status filter for list/clear)" } },
  { name: "sidekick_retry", description: "Retry tool calls with exponential backoff", args: { tool: "string (tool to retry)", args: "object (optional, tool args)", max_attempts: "number (optional, default 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" } },
  { name: "sidekick_evolve", description: "Self-modification with safety: LLM-powered proposals, sandbox testing, confidence filtering, auto-apply docs, configurable retention", args: { action: "string (analyze|propose|list|test|approve|reject|report|sync_docs|cleanup)", id: "string (optional, proposal id for test/approve/reject)", proposal: "string (optional, proposal description or 'auto' for LLM generation)", approve: "boolean (optional, deprecated - use action=approve)", test: "boolean (optional, deprecated - use action=test)", confirm: "boolean (optional, for cleanup action - actually delete old entries)" } },
  { name: "sidekick_orchestrate", description: "Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress", args: { action: "string (create|execute|list|status|cancel)", id: "number (optional, task id for execute/status/cancel)", task_name: "string (optional, task name for create)", subtasks: "array (optional, subtask definitions for create)", dependencies: "object (optional, dependency map for create)", timeout: "number (optional, timeout in ms, default 1800000)" } },
  { name: "sidekick_predict", description: "Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness", args: { action: "string (analyze|list|feedback|suggest)", id: "string (optional, prediction id for feedback)", feedback: "boolean (optional, true if useful, false if not)" } },
  { name: "sidekick_debug_tool", description: "Structured debugging cache with persistent storage for cross-session debugging. Store findings, recall past investigations, cleanup old entries.", args: { action: "string (store|recall|cleanup|start|stop|cache|get|status|clear)", session_name: "string (optional, session identifier for legacy actions)", key: "string (optional, cache key for get/cache, or debug key for cleanup)", value: "string (optional, value to cache/store)", service: "string (optional, service name for store/recall)", issue: "string (optional, issue description for store)", redact: "boolean (optional, default true - set false to skip redaction)" } },
  { name: "sidekick_fresheyes", description: "Get a fresh perspective from Sidekick's LLM (Grok) on a problem. Sends sanitized context for independent analysis", args: { problem: "string (problem description)", context: "string (optional, relevant context)", files: "array (optional, files analyzed)", hypotheses: "array (optional, current hypotheses)", full_response: "boolean (optional, return full response vs key insights)" } },
  { name: "sidekick_batch", description: "Execute multiple tool calls in one request to reduce API round-trips. Max 20 calls per batch.", args: { calls: "array (array of { tool: string, args: object })" } },
  { name: "sidekick_cache", description: "Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL.", args: { action: "string (get|set|clear|list)", key: "string (cache key)", ttl: "string (optional, e.g. 30s, 5m, 1h - default 5m)", value: "string (value to cache, for set action)" } },
  { name: "sidekick_summarize", description: "Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats.", args: { path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" } },
  { name: "sidekick_filter", description: "Filter file contents or directory listings by pattern, date, or size before returning.", args: { path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" } },
  { name: "sidekick_project", description: "Get complete project context in one call: KV entries, context tracking, recent logs, procedures.", args: { name: "string (project name)", include: "string (optional, comma-separated: kv,context,logs,procedures - default kv,context)" } },
  { name: "sidekick_memory_export", description: "Export structured memories to JSON for backup, portability, or machine-to-machine transfer.", args: { project: "string (optional, filter by project)", type: "string (optional, filter by memory type)", include_disabled: "boolean (optional, include disabled memories - default true)", automatic_only: "boolean (optional, only automatic memories - default false)" } },
  { name: "sidekick_memory_import", description: "Import memories from JSON export. Supports merge (update existing) or skip conflict modes.", args: { data: "string|object (JSON export data or parsed object)", on_conflict: "string (optional, merge|skip - default merge)", preserve_ids: "boolean (optional, preserve original IDs - default false)" } },
  { name: "sidekick_memory_manage", description: "Manage memory lifecycle: confirm, delete, disable, expire, restore, set auto-expire, list by state, pending confirmations, process auto-expirations. Delete, disable, expire, and restore also support legacy context entry IDs such as sessions.", args: { action: "string (confirm|set_requires_confirmation|delete|disable|expire|restore|set_auto_expire|list_by_state|pending_confirmations|process_auto_expirations)", id: "string (memory/context ID, or state name for list_by_state)", confirmed_by: "string (optional, who confirmed - default 'user')", days: "number (for set_auto_expire)", reason: "string (optional, reason for delete/disable/expire)", limit: "number (optional, for list operations - default 50)", project: "string (optional, filter by project for list operations)" } },
  { name: "sidekick_sync_identity", description: "Manage machine and user identity for cross-machine sync. Get or set machine_id and user_id.", args: { action: "string (get|set_user)", user_id: "string (required for set_user action)" } },
  { name: "sidekick_sync_export", description: "Export memories for cross-machine sync. Includes origin tracking and sync metadata.", args: { project: "string (optional, filter by project)", since: "string (optional, ISO timestamp - only export memories updated after this time)", include_disabled: "boolean (optional, include disabled memories - default true)" } },
  { name: "sidekick_sync_import", description: "Import memories from another machine's sync export. Supports conflict resolution strategies.", args: { data: "string|object (sync export data)", strategy: "string (optional, newest|highest_confidence|most_confirmed|merge|skip - default newest)", preserve_ids: "boolean (optional, preserve original IDs - default false)" } },
  { name: "sidekick_sync_diff", description: "Get list of memories changed since a given timestamp. Useful for incremental sync.", args: { since: "string (ISO timestamp - get changes after this time)" } },
  { name: "sidekick_tail", description: "Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file.", args: { source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" } },
  { name: "sidekick_diff_files", description: "Compare two files directly without reading both into context. Returns unified diff or summary.", args: { path_a: "string (first file path)", path_b: "string (second file path)", format: "string (optional, unified|summary - default unified)" } },
  { name: "sidekick_find", description: "Advanced file finder: search by name pattern, date range, size range, and content pattern.", args: { path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" } },
  { name: "sidekick_status", description: "Unified system status: services, disk, memory, load, uptime, top processes in one call.", args: { include: "string (optional, comma-separated: services,disk,memory,load,uptime,processes - default services,disk)", services: "string (optional, comma-separated service names - default sidekick-mcp,sidekick-dashboard,sidekick-agent)" } },
  { name: "sidekick_extract", description: "Parse JSON/YAML/INI/XML and extract specific fields by path. Returns only what you need.", args: { path: "string (file path)", fields: "string|array (optional, field paths to extract e.g. 'database.host,database.port')" } },
  { name: "sidekick_anonymize", description: "Replace sensitive data with realistic but fake values. Preserves data structure while making it safe to share externally.", args: { action: "string (anonymize|patterns|add_pattern|remove_pattern)", input: "string (optional, text to anonymize)", format: "string (optional, text|json|yaml - default text)", custom_patterns: "array (optional, {pattern, replacement} objects)", consistency: "boolean (optional, same input always maps to same output - default true)" } },
  { name: "sidekick_sandbox", description: "Execute operations in a tracked context with automatic backup and rollback. Safe experimentation on remote systems.", args: { action: "string (exec|rollback|list|diff|clean)", sandbox_name: "string (optional, sandbox identifier)", command: "string (optional, command to execute)", files: "array (optional, files to auto-backup before exec)", auto_backup: "boolean (optional, default true)", rollback_id: "string (optional, sandbox to rollback)" } },
  { name: "sidekick_changelog", description: "Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries.", args: { action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" } },
  { name: "sidekick_netdiag", description: "Unified network diagnostics: DNS, routing, port scanning, connectivity checks, and local listeners.", args: { action: "string (check|dns|route|ports|listeners|connectivity)", target: "string (host, URL, or IP to diagnose)", port_range: "string (optional, port range e.g. '80-443')", timeout: "number (optional, timeout in ms - default 5000)", format: "string (optional, detailed|compact|json - default detailed)" } },
  { name: "sidekick_timeline", description: "Build chronological timeline from multiple log sources. Correlates events across log.jsonl, journalctl, git, and file modifications.", args: { action: "string (build|filter|export)", since: "string (start time: ISO or relative like 1h, 1d)", until: "string (optional, end time - default now)", sources: "array (optional, log.jsonl|journalctl|git|files|all - default all)", pattern: "string (optional, regex filter)", severity: "string (optional, error|warn|info|all - default all)", format: "string (optional, compact|detailed|json - default compact)", max_events: "number (optional, default 200)" } },
  { name: "sidekick_circuit", description: "Circuit breaker for tool calls. Prevents cascading failures by fast-failing when a target is down.", args: { action: "string (call|status|reset|configure)", target: "string (circuit target label)", tool: "string (optional, tool name for call action)", args: "object (optional, tool arguments for call action)", failure_threshold: "number (optional, failures before opening - default 5)", cooldown_seconds: "number (optional, seconds before half-open - default 60)", cache_response: "boolean (optional, cache last successful response - default false)" } },
  { name: "sidekick_baseline", description: "Behavioral baseline and anomaly detection. Learns normal patterns and detects statistical deviations.", args: { action: "string (record|learn|check|status|reset)", metric_name: "string (metric identifier)", value: "number (optional, value to record)", source: "string (optional, health|custom|command)", command: "string (optional, command to collect metric)", window: "string (optional, history window - default 7d)", sensitivity: "string (optional, low|medium|high - default medium)" } },
  { name: "sidekick_depend", description: "Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis.", args: { action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" } },
  { name: "sidekick_runbook", description: "Operational runbook executor with autonomous and guided modes. Supports verification, rollback, and step-by-step execution.", args: { action: "string (create|start|next|verify|rollback|abort|list|get|delete)", name: "string (optional, runbook name)", mode: "string (optional, autonomous|guided - default autonomous)", steps: "array (optional, step definitions)", runbook_id: "string (optional, instance or definition ID)", step_index: "number (optional, step index)" } },
  { name: "sidekick_ops", description: "Packaged Sidekick operations workflows for deploy verification, restart smoke tests, deployments, and incident snapshots.", args: { action: "string (verify_deployed_commit|restart_and_smoke_test|deploy_current_main|incident_snapshot)", repo_path: "string (optional, repository path - default current Sidekick repo)", restart_mcp: "boolean (optional, schedule sidekick-mcp restart for restart_and_smoke_test)" } },
  { name: "sidekick_mission", description: "Mission Control intent router for Sidekick operations. Profiles, routes, preflights, and executes common intents through safer existing tools before raw shell.", args: { action: "string (profiles|route|preflight|execute - default route)", intent: "string (user goal or operation intent)", profile: "string (read_only_audit|trusted_vps|production|danger_zone - default trusted_vps)", confirm: "boolean (required true for mutating execute routes)", key: "string (optional, KV key for delete missions)", project: "string (optional, project for memory missions)", query: "string (optional, search query for tool discovery)", include: "string (optional, include sections for status/project)", services: "string (optional, services for status)", repo_path: "string (optional, repo for deploy workflows)", limit: "number (optional, result limit)", tool: "string (optional, tool filter for logs)", source: "string (optional, source filter for logs)", format: "string (optional, output format for tool discovery)" } },
  { name: "sidekick_black_box", description: "Incident time capsule: captures full system context (services, processes, logs, disk, network) in one call for debugging. Rate limited.", args: { action: "string (capture|list|get|delete|analyze)", name: "string (optional, incident name)", include: "array (optional, services|processes|logs|disk|network|all - default all)", analyze_with_llm: "boolean (optional, use LLM for analysis - default false)", incident_id: "string (optional, incident ID)" } },
  { name: "sidekick_respond", description: "Return a text response directly without calling other tools. Use this for simple answers or when no tool action is needed.", args: { text: "string (the response text to return)" } },
  { name: "sidekick_db_schema", description: "Inspect database schema: tables, columns, indexes, foreign keys", args: { table: "string (optional, specific table name)", verbose: "boolean (optional, include row counts and detailed info)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "sidekick_db_query", description: "Execute raw SQL queries with safety limits (readonly by default)", args: { sql: "string (SQL query)", params: "array (optional, query parameters)", readonly: "boolean (optional, default true - blocks writes)", limit: "number (optional, max rows - default 1000)", timeout: "number (optional, query timeout in ms - default 5000)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "sidekick_db_stats", description: "Database statistics: size, table sizes, WAL status, cache hit ratio", args: { detailed: "boolean (optional, include per-table stats)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "sidekick_db_backup", description: "Create timestamped database backup with optional compression", args: { path: "string (optional, output path - default data/backups/)", compress: "boolean (optional, gzip compression - default true)" } },
  { name: "sidekick_db_restore", description: "Restore database from backup with integrity verification", args: { path: "string (backup file path)", verify: "boolean (optional, check integrity before restore - default true)" } },
  { name: "sidekick_log_query", description: "Advanced tool_logs filtering by time, tool, source, status", args: { tool: "string (optional, filter by tool name)", source: "string (optional, filter by source: mcp/agent/dashboard)", success: "boolean (optional, filter by success status)", since: "string (optional, ISO timestamp or relative: 1h, 1d)", until: "string (optional, ISO timestamp)", limit: "number (optional, max results - default 100)" } },
  { name: "sidekick_db_export", description: "Export tables to JSON, CSV, or SQL format", args: { table: "string (optional, specific table - exports all if omitted)", format: "string (optional, json|csv|sql - default json)", path: "string (optional, output file path)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "sidekick_db_search", description: "Full-text search across all tables", args: { query: "string (search terms)", tables: "string (optional, comma-separated table names)", limit: "number (optional, max results - default 50)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" } },
  { name: "sidekick_db_migrate", description: "Schema migrations with versioning and rollback", args: { action: "string (status|list|up)", version: "number (optional, target version)", name: "string (optional, migration filename for up action)" } },
  { name: "sidekick_db_diff", description: "Compare two database snapshots, show what changed", args: { snapshot_a: "string (optional, path to snapshot A or 'current')", snapshot_b: "string (optional, path to snapshot B or 'current')", table: "string (optional, specific table to compare)" } },
  { name: "sidekick_redis", description: "Redis operations: get, set, del, keys, ttl, info, flush. Requires sidekick-redis service.", args: { action: "string (get|set|del|keys|ttl|info|flush)", key: "string (optional, Redis key)", value: "string (optional, value for set)", ttl: "string (optional, TTL in seconds for set)", pattern: "string (optional, pattern for keys - default '*')" } },
  { name: "sidekick_ocr", description: "Extract text from images using Tesseract OCR", args: { path: "string (image file path)", language: "string (optional, language code - default eng)", psm: "number (optional, page segmentation mode)" } },
  { name: "sidekick_media", description: "Media processing with ffmpeg: convert, extract audio, thumbnails, resize, trim, info", args: { action: "string (info|convert|extract_audio|thumbnail|resize|trim)", input: "string (input file path)", output: "string (optional, output file path)", options: "string (optional, format-specific options)" } },
  { name: "sidekick_transcribe", description: "Transcribe audio/video to text using Whisper", args: { path: "string (audio/video file path)", model: "string (optional, tiny|base|small|medium - default base)", language: "string (optional, language code)" } },
  { name: "sidekick_analytics", description: "Fast analytical queries on CSV/JSON/Parquet files using DuckDB", args: { query: "string (SQL query)", file: "string (optional, data file path - CSV, JSON, or Parquet)", format: "string (optional, file format: csv|json|parquet - auto-detected)" } },
  { name: "sidekick_insight_report", description: "Create a concise, evidence-backed report from text, data, or image file paths", args: { paths: "string|array (file path, comma-separated paths, or array of paths)", title: "string (optional report title)" } },
  { name: "sidekick_embed", description: "Generate text embeddings using Ollama", args: { text: "string (text to embed)", model: "string (optional, embedding model - default nomic-embed-text)" } },
  { name: "sidekick_ollama", description: "Manage Ollama models: list, ps, pull, show", args: { action: "string (list|ps|pull|show)", model: "string (optional, model name for pull/show)" } },
  { name: "sidekick_tunnel", description: "Manage Cloudflare tunnels: start, stop, list", args: { action: "string (start|stop|list)", port: "number (local port to expose)", name: "string (optional, tunnel name)" } },
  { name: "sidekick_download", description: "Download videos/audio from YouTube and 1000+ sites using yt-dlp", args: { url: "string (video URL)", output: "string (optional, output path)", format: "string (optional, video format)", audio_only: "boolean (optional, extract audio only)" } },
  { name: "sidekick_wireguard", description: "Manage WireGuard VPN: status, list_peers, add_peer, remove_peer, generate_keypair", args: { action: "string (status|list_peers|add_peer|remove_peer|generate_keypair)", interface_name: "string (WireGuard interface, e.g. wg0)", peer_name: "string (peer name for add_peer)", public_key: "string (peer public key)", endpoint: "string (optional, peer endpoint IP:port)", allowed_ips: "string (optional, allowed IPs, default 10.0.0.0/24)" } },
  { name: "sidekick_nginx", description: "Manage Nginx reverse proxy: status, list_sites, add_site, remove_site, test_config, reload", args: { action: "string (status|list_sites|add_site|remove_site|test_config|reload)", site_name: "string (site config name)", domain: "string (domain name for add_site)", upstream_port: "number (local port to proxy to)", ssl_email: "string (optional, email for Let's Encrypt)" } },
  { name: "sidekick_knowledge", description: "Knowledge base management: search, get, list, add, update, soft-delete, and purge disabled entries", args: { action: "string (search|get|list|add|update|delete|purge)", id: "number (optional, entry ID for get/update/delete/purge)", category: "string (optional, category for list/add/update)", title: "string (optional, title for add/update)", content: "string (optional, content for add/update)", tags: "string (optional, comma-separated tags for add/update)", query: "string (optional, search query for search)", limit: "number (optional, max results for search/list)" } },
  { name: "sidekick_metrics", description: "Metrics collection and querying with InfluxDB: write metrics, query data, list measurements and fields", args: { action: "string (write|query|list_measurements|list_fields)", measurement: "string (measurement name for write/list_fields)", fields: "object (field values for write)", tags: "object (optional, tags for write)", timestamp: "number (optional, nanosecond timestamp for write)", query: "string (Flux query for query action)", time_range: "string (optional, time range for list_fields, e.g. -30d)" } },
];

async function callTool(name, args, options = {}) {
  const handler = TOOLS[name];
  if (!handler) {
    return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  }
  const policyError = enforceToolPolicy(name, currentSource);
  if (policyError) {
    logToolCall(name, args, 0, false, policyError.content[0].text);
    return policyError;
  }
  if (!options.bypassApproval) {
    const approval = getApprovalDecision(name, currentSource);
    if (approval.required) {
      let item;
      try {
        item = queueApproval(name, args, approval);
      } catch (e) {
        const text = "Approval queue unavailable: " + e.message;
        logToolCall(name, args, 0, false, text);
        return { content: [{ type: "text", text }], isError: true };
      }
      const text = `Approval required: ${name} (${approval.risk} risk, source=${approval.source}, mode=${approval.mode}). Queued as ${item.id}. ${approval.reason}.`;
      logToolCall(name, args, 0, false, text);
      return { content: [{ type: "text", text }], isError: true, approvalRequired: true, approvalId: item.id };
    }
  }
  const start = Date.now();
  try {
    const result = await handler(args);
    const success = !result.isError;
    logToolCall(name, args, Date.now() - start, success,
      result.content?.[0]?.text?.substring(0, 80) || "(ok)"
    );
    return result;
  } catch (e) {
    logToolCall(name, args, Date.now() - start, false, e.message);
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
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
  resolveApproval,
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
  checkNetwork
};
