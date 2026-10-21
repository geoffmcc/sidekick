"use strict";

// Meta tool family: predict, debug_tool, fresheyes.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, zod,
// shared non-legacy modules (predict engine, db, redact, tools/context) and
// the inference family's sidekick_llm (fresheyes) — never on tools-legacy.js.
// All handlers and helpers move verbatim except one line: debug_tool's KV
// audit used legacy getCurrentSource(); the family uses
// toolContext.getExecutionSource() || "unknown", the established family
// substitution (memory-core precedent) — behavior-equivalent because
// setSource writes through to toolContext and has no production callers.
// DEBUG_SESSIONS stays in-memory per-process state, exclusive to debug_tool.
// Risk classifications are preserved from src/tools/metadata.js.

const { z } = require("zod");
const dbStore = require("../../db");
const predictEngine = require("../../predict");
const { redactSensitive } = require("../../redact");
const toolContext = require("../context");
const authorization = require("../../core/authorization");
const projectAccess = require("../../core/project-access");
const { runLlm } = require("./inference");
const { scopedProject } = require("./memory-scope");
const { requireCanonicalInvocation } = require("../read-authorization");

function jsonText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// --- Predict Tool (delegates to src/predict.js) ---

async function sidekick_predict({ action, id, type, project, session_id, task_id, feedback, outcome, limit, status, confidence, maxAge, scope, confirm, retention_days, purge_legacy }) {
  const dispatchError = requireCanonicalInvocation("predict");
  if (dispatchError) return dispatchError;
  try {
    const validActions = ["analyze", "list", "get", "feedback", "outcome", "dismiss", "explain", "status", "suggest", "migrate", "purge_preview", "purge", "diagnose"];
    if (!action || !validActions.includes(action)) {
      return { content: [{ type: "text", text: `Invalid action. Use: ${validActions.join(", ")}` }], isError: true };
    }

    // Deprecated alias: suggest -> list top predictions
    if (action === "suggest") {
      action = "list";
    }

    const context = toolContext.getExecutionContext();
    const auth = context.authIdentity;
    const principalId = auth?.principal_id || auth?.principalId;
    const credentialScopes = auth?.scopes;
    const delegationId = auth?.delegation_id || auth?.delegationId || null;
    const deny = (message = "Prediction not found") => ({ content: [{ type: "text", text: message }], isError: true, code: "not_found" });
    const permitted = (permission) => Boolean(principalId && authorization.authorize({ principalId, permission, credentialScopes, delegationId }).ok);
    const canAccessProject = (resourceProject, required) => projectAccess.hasProjectPermission(principalId, resourceProject, required === "read" ? "predictions.read" : "predictions.write", required, credentialScopes, delegationId);
    const requestedProject = project || context.project || null;
    if (!principalId) return { content: [{ type: "text", text: "Authentication required for Predict operations" }], isError: true, code: "unauthenticated" };
    const requiredPermission = ["list", "get", "explain"].includes(action) ? "predictions.read"
      : ["feedback", "outcome", "dismiss", "analyze"].includes(action) ? (action === "analyze" && scope === "global" ? "dashboard.operations.manage" : "predictions.write")
      : ["purge", "migrate"].includes(action) ? "dashboard.operations.manage" : "dashboard.operations.read";
    if (!permitted(requiredPermission)) return { content: [{ type: "text", text: `Authorization denied: ${requiredPermission}` }], isError: true, code: "authorization_denied" };

    if (action === "analyze") {
      if (scope === "global") {
        if (!permitted("dashboard.operations.manage")) return { content: [{ type: "text", text: "Global prediction analysis requires dashboard.operations.manage" }], isError: true, code: "authorization_denied" };
      } else if (!requestedProject || !canAccessProject(requestedProject, "write")) {
        return { content: [{ type: "text", text: "Prediction analysis requires write access to an authorized project" }], isError: true, code: "project_forbidden" };
      }
    }
    if (["feedback", "outcome", "dismiss"].includes(action)) {
      if (!id) return { content: [{ type: "text", text: `id required for ${action}` }], isError: true };
      const target = predictEngine.getPrediction(id);
      if (!target || !canAccessProject(target.project, "write")) return deny();
      if (project && project !== target.project) return deny();
    }
    if (["get", "explain"].includes(action) && id) {
      const target = predictEngine.getPrediction(id);
      if (!target || !canAccessProject(target.project, "read")) return deny();
      if (project && project !== target.project) return deny();
    }
    if (["list", "suggest"].includes(action) && requestedProject && !canAccessProject(requestedProject, "read")) return deny();

    if (action === "analyze") {
      // Scope is required: a global analysis must be requested deliberately
      // (scope="global"), never inferred from omitted parameters.
      const result = predictEngine.analyze({ scope, project: requestedProject, session_id, task_id, maxAge: maxAge || "7d" });
      if (!result.ok) return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      return jsonText(result);
    }

    if (action === "purge_preview") {
      return jsonText(predictEngine.purgePreview({ retention_days, purge_legacy: purge_legacy === true }));
    }

    if (action === "purge") {
      const result = predictEngine.purge({ confirm: confirm === true, retention_days, purge_legacy: purge_legacy === true });
      if (!result.ok) return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      return jsonText(result);
    }

    if (action === "diagnose") {
      return jsonText(predictEngine.diagnose());
    }

    if (action === "list") {
      const global = projectAccess.hasGlobalProjectAccess(principalId, credentialScopes, delegationId);
      const accessible = requestedProject ? null : (global ? null : projectAccess.listAccessibleProjectsForPermission(principalId, "predictions.read", credentialScopes, delegationId).map(item => item.project_id));
      const preds = predictEngine.listPredictions({ status, type, project: requestedProject, projects: accessible, session_id, task_id, confidence, limit });
      return jsonText({ ok: true, count: preds.length, predictions: preds });
    }

    if (action === "get") {
      if (!id) return { content: [{ type: "text", text: "id required for get" }], isError: true };
      const pred = predictEngine.getPrediction(id);
      if (!pred) return { content: [{ type: "text", text: `Prediction not found: ${id}` }], isError: true };
      const evidence = predictEngine.getPredictionEvidence(id);
      const fb = predictEngine.getPredictionFeedback(id);
      return jsonText({ ok: true, prediction: pred, evidence, feedback: fb });
    }

    if (action === "feedback") {
      if (!id) return { content: [{ type: "text", text: "id required for feedback" }], isError: true };
      if (!feedback) return { content: [{ type: "text", text: "feedback required (useful|not_useful|incorrect|already_known|acted_on|dismissed)" }], isError: true };
      const result = predictEngine.recordFeedback(id, feedback, project || predictEngine.getPrediction(id)?.project);
      return jsonText(result);
    }

    if (action === "outcome") {
      if (!id) return { content: [{ type: "text", text: "id required for outcome" }], isError: true };
      if (!outcome) return { content: [{ type: "text", text: "outcome required (confirmed|did_not_occur|action_succeeded|action_failed|expired|superseded|unresolved)" }], isError: true };
      const result = predictEngine.recordOutcome(id, outcome);
      return jsonText(result);
    }

    if (action === "dismiss") {
      if (!id) return { content: [{ type: "text", text: "id required for dismiss" }], isError: true };
      const result = predictEngine.dismissPrediction(id);
      return jsonText(result);
    }

    if (action === "explain") {
      if (!id) return { content: [{ type: "text", text: "id required for explain" }], isError: true };
      const pred = predictEngine.getPrediction(id);
      if (!pred) return { content: [{ type: "text", text: `Prediction not found: ${id}` }], isError: true };
      const evidence = predictEngine.getPredictionEvidence(id);
      return jsonText({
        ok: true,
        prediction_id: pred.id,
        type: pred.type,
        subject: pred.subject,
        explanation: pred.explanation,
        probability: pred.probability,
        confidence: pred.confidence,
        score_breakdown: pred.score_breakdown,
        observation_count: pred.observation_count,
        evidence: evidence.map(e => ({
          source_type: e.source_type,
          source_id: e.source_id,
          summary: e.summary,
          timestamp: e.source_timestamp
        })),
        created_at: pred.created_at,
        expires_at: pred.expires_at,
        rule_version: pred.rule_version
      });
    }

    if (action === "status") {
      return jsonText(predictEngine.engineStatus());
    }

    if (action === "migrate") {
      const result = predictEngine.migrateLegacy();
      return jsonText({ ok: true, ...result });
    }

    return { content: [{ type: "text", text: "Unknown action" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `Predict error: ${e.message}` }], isError: true };
  }
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

function debugStoragePrefix(scope) {
  return `__sidekick_debug_v1:${encodeURIComponent(scope.principalId)}:${encodeURIComponent(scope.project || "global")}:`;
}

function getDebugEntries(scope) {
  const prefix = debugStoragePrefix(scope);
  const { entries: scopedEntries, oversized } = dbStore.listScopedKV({ keyPrefix: prefix, project: scope.project, limit: 500 });
  if (oversized) throw Object.assign(new Error("Debug records exceed the safe read limit and need operator review"), { code: "kv_value_too_large" });
  const entries = [];
  for (const [key, entry] of scopedEntries) {
    if (typeof entry === 'object' && entry !== null && 'value' in entry) {
      const publicKey = key.slice(prefix.length);
      const segments = publicKey.split(":");
      entries.push({ key: publicKey, storageKey: key, service: segments[1] || "unknown", issue: segments.slice(2).join(":").replace(/_\d{4}-\d{2}-\d{2}$/, ""), ...entry });
    }
  }
  return entries.sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

function getDebugScope(action) {
  const context = toolContext.getExecutionContext();
  const principalId = context.authIdentity?.principal_id;
  if (!principalId) throw Object.assign(new Error("Authenticated identity required for debug operations"), { code: "unauthenticated" });
  const project = scopedProject(undefined, ["store", "cleanup", "start", "stop", "cache", "clear"].includes(action) ? "write" : "read");
  return { principalId, project };
}

function debugSessionPrefix(scope) {
  return `__sidekick_debug_session_v1:${encodeURIComponent(scope.principalId)}:${encodeURIComponent(scope.project || "global")}:`;
}

function debugSessionId(scope, name) { return `${debugSessionPrefix(scope)}${encodeURIComponent(name)}`; }
function lastDebugSession(scope) {
  const prefix = debugSessionPrefix(scope);
  return Object.keys(DEBUG_SESSIONS).filter(id => id.startsWith(prefix)).at(-1) || null;
}

function isOlderThan7Days(dateStr) {
  const entryDate = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DEBUG_RETENTION_DAYS);
  return entryDate < cutoff;
}

async function sidekick_debug_tool({ action, session_name, key, value, service, issue, redact }) {
  const denied = requireCanonicalInvocation("debug_tool");
  if (denied) return denied;
  loadDebugSessions();
  const now = Date.now();
  if (!["store", "recall", "cleanup", "start", "stop", "cache", "get", "status", "clear"].includes(action)) {
    return { content: [{ type: "text", text: "Unknown action. Use: store, recall, cleanup (persistent) or start, stop, cache, get, status, clear (session)" }], isError: true };
  }
  let scope;
  try { scope = getDebugScope(action); }
  catch (error) { return { content: [{ type: "text", text: error.message }], isError: true, code: error.code || "project_scope_denied" }; }
  // Debug findings are persistent data and can contain copied command output.
  // Redaction is mandatory; a caller-controlled opt-out would turn this low-risk
  // helper into an intentional secret sink.
  const shouldRedact = true;

  // --- Persistent storage actions (new) ---

  if (action === "store") {
    if (!service) {
      return { content: [{ type: "text", text: "service parameter required" }], isError: true };
    }
    if (!value) {
      return { content: [{ type: "text", text: "value parameter required" }], isError: true };
    }

    const debugKey = generateDebugKey(service, issue);
    const storageKey = `${debugStoragePrefix(scope)}${debugKey}`;
    const nowISO = new Date().toISOString();

    const storedValue = shouldRedact ? redactSensitive(value) : value;

    dbStore.setKV(storageKey, storedValue, scope.project, toolContext.getExecutionSource() || "unknown", "debug");
    return { content: [{ type: "text", text: `Stored debug finding: ${debugKey} (${storedValue.length} chars)` }] };
  }

  if (action === "recall") {
    let entries;
    try { entries = getDebugEntries(scope); }
    catch (error) { return { content: [{ type: "text", text: error.message }], isError: true, code: error.code || "storage_read_failed" }; }
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
      const storageKey = `${debugStoragePrefix(scope)}${key}`;
      const entry = dbStore.getKV(storageKey);
      if (entry && key.startsWith('debug:')) {
        dbStore.deleteKV(storageKey);
        return { content: [{ type: "text", text: `Deleted: ${key}` }] };
      }
      return { content: [{ type: "text", text: `Key not found or not a debug entry: ${key}` }], isError: true };
    }

    if (key === "all") {
      let entries;
      try { entries = getDebugEntries(scope); }
      catch (error) { return { content: [{ type: "text", text: error.message }], isError: true, code: error.code || "storage_read_failed" }; }
      const old = entries.filter(e => isOlderThan7Days(e.updated));
      for (const entry of old) dbStore.deleteKV(entry.storageKey);
      return { content: [{ type: "text", text: `Deleted ${old.length} old debug entries` }] };
    }

    let entries;
    try { entries = getDebugEntries(scope); }
    catch (error) { return { content: [{ type: "text", text: error.message }], isError: true, code: error.code || "storage_read_failed" }; }
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

  // --- Legacy in-memory session actions (backward compatibility) ---

  if (action === "start") {
    const sessionId = session_name || `debug_${Date.now()}`;
    const internalId = debugSessionId(scope, sessionId);
    DEBUG_SESSIONS[internalId] = {
      started: now,
      cache: {},
      name: session_name || sessionId
    };
    return { content: [{ type: "text", text: `Debug session started: ${sessionId}\nTTL: 8 hours\n\nNote: For cross-session persistence, use action="store" instead.` }] };
  }

  if (action === "stop") {
    const internalId = session_name ? debugSessionId(scope, session_name) : lastDebugSession(scope);
    const sessionId = session_name || (internalId ? DEBUG_SESSIONS[internalId].name : "undefined");
    if (!internalId || !DEBUG_SESSIONS[internalId]) {
      return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }
    delete DEBUG_SESSIONS[internalId];
    return { content: [{ type: "text", text: `Debug session stopped: ${sessionId}` }] };
  }

  if (action === "cache") {
    const internalId = session_name ? debugSessionId(scope, session_name) : lastDebugSession(scope);
    const sessionId = session_name || (internalId ? DEBUG_SESSIONS[internalId].name : "undefined");
    if (!internalId || !DEBUG_SESSIONS[internalId]) {
      return { content: [{ type: "text", text: `No active session. Start one with action="start"` }], isError: true };
    }
    if (!key || value === undefined) {
      return { content: [{ type: "text", text: `key and value required` }], isError: true };
    }
    DEBUG_SESSIONS[internalId].cache[key] = {
      value: value,
      cached_at: new Date().toISOString()
    };
    return { content: [{ type: "text", text: `Cached: ${key} (${String(value).length} chars)` }] };
  }

  if (action === "get") {
    const internalId = session_name ? debugSessionId(scope, session_name) : lastDebugSession(scope);
    const sessionId = session_name || (internalId ? DEBUG_SESSIONS[internalId].name : "undefined");
    if (!internalId || !DEBUG_SESSIONS[internalId]) {
      return { content: [{ type: "text", text: `No active session` }], isError: true };
    }
    if (!key) {
      return { content: [{ type: "text", text: `key required` }], isError: true };
    }
    const cached = DEBUG_SESSIONS[internalId].cache[key];
    if (!cached) {
      return { content: [{ type: "text", text: `Key not found in session: ${key}` }], isError: true };
    }
    return { content: [{ type: "text", text: cached.value }] };
  }

  if (action === "status") {
    const prefix = debugSessionPrefix(scope);
    const ownSessions = Object.entries(DEBUG_SESSIONS).filter(([id]) => id.startsWith(prefix));
    if (ownSessions.length === 0) {
      return { content: [{ type: "text", text: `No active debug sessions` }] };
    }
    const sessions = ownSessions.map(([, s]) => {
      const age = Math.round((now - s.started) / 1000 / 60);
      const cacheSize = Object.keys(s.cache).length;
      return `${id}: ${cacheSize} items, ${age}min old`;
    }).join("\n");
    return { content: [{ type: "text", text: `Active sessions:\n${sessions}` }] };
  }

  if (action === "clear") {
    const sessionId = session_name;
    if (sessionId) {
      const internalId = debugSessionId(scope, sessionId);
      if (!DEBUG_SESSIONS[internalId]) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
      }
      delete DEBUG_SESSIONS[internalId];
      return { content: [{ type: "text", text: `Cleared session: ${sessionId}` }] };
    } else {
      const ownIds = Object.keys(DEBUG_SESSIONS).filter(id => id.startsWith(debugSessionPrefix(scope)));
      const count = ownIds.length;
      for (const id of ownIds) {
        delete DEBUG_SESSIONS[id];
      }
      return { content: [{ type: "text", text: `Cleared ${count} sessions` }] };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: store, recall, cleanup (persistent) or start, stop, cache, get, status, clear (session)" }], isError: true };
}

// FreshEyes tool implementation
async function sidekick_fresheyes({ problem, context, files, hypotheses, full_response }) {
  const dispatchError = requireCanonicalInvocation("fresheyes");
  if (dispatchError) return dispatchError;
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
    const result = await runLlm({
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

const SCHEMAS = {
  predict: z.object({
    action: z.enum(["analyze", "list", "get", "feedback", "outcome", "dismiss", "explain", "status", "suggest", "migrate", "purge_preview", "purge", "diagnose"]).describe("Predict action"),
    id: z.string().optional().describe("Prediction ID"),
    type: z.string().optional().describe("Filter by prediction type"),
    scope: z.enum(["project", "session", "task", "global"]).optional().describe("Analysis scope. Inferred from project/session_id/task_id when omitted; use 'global' to deliberately analyze every project"),
    confirm: z.boolean().optional().describe("Required (true) to execute a purge"),
    retention_days: z.number().optional().describe("Override the configured retention period for purge_preview/purge"),
    purge_legacy: z.boolean().optional().describe("Also purge legacy (pre-v2) terminal predictions, which are preserved by default"),
    project: z.string().optional().describe("Project scope"),
    session_id: z.string().optional().describe("Session ID"),
    task_id: z.string().optional().describe("Task ID"),
    feedback: z.string().optional().describe("Feedback value (useful|not_useful|incorrect|already_known|acted_on|dismissed)"),
    outcome: z.string().optional().describe("Outcome value (confirmed|did_not_occur|action_succeeded|action_failed|expired|superseded|unresolved)"),
    limit: z.number().optional().describe("Max results (default 20, max 100)"),
    status: z.string().optional().describe("Filter by status (active|expired|superseded|dismissed|confirmed|did_not_occur)"),
    confidence: z.string().optional().describe("Filter by confidence (none|low|medium|high|very_high)"),
    maxAge: z.string().optional().describe("Analysis window (default 7d)")
  }),
  debug_tool: z.object({
    action: z.enum(["store", "recall", "cleanup", "start", "stop", "cache", "get", "status", "clear"]).describe("Debug action"),
    session_name: z.string().optional().describe("Session identifier (for legacy session actions)"),
    key: z.string().optional().describe("Cache key (for get/cache) or debug key (for cleanup)"),
    value: z.string().optional().describe("Value to cache/store"),
    service: z.string().optional().describe("Service name (for store/recall)"),
    issue: z.string().optional().describe("Issue description (for store)"),
    redact: z.boolean().optional().describe("Deprecated compatibility field; redaction is always enforced")
  }),
  fresheyes: z.object({
    problem: z.string().describe("Problem description"),
    context: z.string().optional().describe("Relevant context"),
    files: z.array(z.string()).optional().describe("Files analyzed"),
    hypotheses: z.array(z.string()).optional().describe("Current hypotheses"),
    full_response: z.boolean().optional().describe("Return full response vs key insights")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "predict",
    description: "Evidence-backed prediction and decision-support engine. Analyzes correlated tool history, incidents, and workflows within an explicit scope to identify likely next actions, failure risks, missing prerequisites, incident recurrence, and workflow opportunities. Every persisted prediction passes an evidence and confidence admission gate.",
    schema: SCHEMAS.predict,
    args: { action: "string (analyze|list|get|feedback|outcome|dismiss|explain|status|suggest|migrate|purge_preview|purge|diagnose)", id: "string (optional, prediction ID)", type: "string (optional, filter by type)", project: "string (optional, project scope)", session_id: "string (optional)", task_id: "string (optional)", feedback: "string (optional, useful|not_useful|incorrect|already_known|acted_on|dismissed)", outcome: "string (optional, confirmed|did_not_occur|action_succeeded|action_failed|expired|superseded|unresolved)", limit: "number (optional, max results - default 20)", status: "string (optional, filter by status)", confidence: "string (optional, filter by confidence)", maxAge: "string (optional, analysis window - default 7d)", scope: "string (optional, project|session|task|global - required for analyze; use global to deliberately analyze every project)", confirm: "boolean (optional, required true to execute purge)", retention_days: "number (optional, override retention for purge_preview/purge)", purge_legacy: "boolean (optional, also purge legacy pre-v2 terminal predictions, preserved by default)" },
    risk: "medium",
    category: "Meta",
    source: "builtin",
    family: "meta",
    handler: sidekick_predict,
  }),
  Object.freeze({
    name: "debug_tool",
    description: "Structured debugging cache with persistent storage for cross-session debugging. Store findings, recall past investigations, cleanup old entries.",
    schema: SCHEMAS.debug_tool,
    args: { action: "string (store|recall|cleanup|start|stop|cache|get|status|clear)", session_name: "string (optional, session identifier for legacy actions)", key: "string (optional, cache key for get/cache, or debug key for cleanup)", value: "string (optional, value to cache/store)", service: "string (optional, service name for store/recall)", issue: "string (optional, issue description for store)", redact: "boolean (optional, default true - set false to skip redaction)" },
    risk: "medium",
    category: "Meta",
    source: "builtin",
    family: "meta",
    handler: sidekick_debug_tool,
  }),
  Object.freeze({
    name: "fresheyes",
    description: "Get a fresh perspective from Sidekick's LLM (Grok) on a problem. Sends sanitized context for independent analysis",
    schema: SCHEMAS.fresheyes,
    args: { problem: "string (problem description)", context: "string (optional, relevant context)", files: "array (optional, files analyzed)", hypotheses: "array (optional, current hypotheses)", full_response: "boolean (optional, return full response vs key insights)" },
    risk: "medium",
    category: "Meta",
    source: "builtin",
    family: "meta",
    handler: sidekick_fresheyes,
  }),
]);

module.exports = { descriptors, sidekick_predict, sidekick_debug_tool, sidekick_fresheyes };
