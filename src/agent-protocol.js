const { stripSidekickPrefix, isValidCanonicalToolName } = require("./core/tool-name");

// Decision keys that are never legitimate in a model decision or its arguments.
// A decision containing any of these anywhere is rejected outright rather than
// filtered, so prototype-pollution-shaped output can never reach dispatch.
const FORBIDDEN_DECISION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_TOOL_NAME_LENGTH = 128;

function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_DECISION_KEYS.has(key)) return true;
      if (containsForbiddenKey(value[key])) return true;
    }
  }
  return false;
}

function isPlausibleToolName(name) {
  return typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_TOOL_NAME_LENGTH &&
    isValidCanonicalToolName(name);
}

function collectActionArguments(decision) {
  if (decision.arguments && typeof decision.arguments === "object") return decision.arguments;
  if (decision.args && typeof decision.args === "object") return decision.args;

  const ignored = new Set(["action", "tool", "arguments", "args", "done", "result", "think", "thought"]);
  return Object.fromEntries(
    Object.entries(decision).filter(([key]) => !ignored.has(key))
  );
}

function invalidDecision(reason) {
  return { invalid: true, reason };
}

function normalizeDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;

  if (containsForbiddenKey(decision)) return invalidDecision("forbidden_key");

  const keys = Object.keys(decision);
  if (keys.length === 1) {
    if (typeof decision.response === "string") {
      return { done: true, result: decision.response };
    }
    if (typeof decision.answer === "string") {
      return { done: true, result: decision.answer };
    }
  }

  const hasToolField = decision.tool !== undefined && decision.tool !== null && decision.tool !== "";
  const actionToolName = typeof decision.action === "string" && decision.action !== "done" && isPlausibleToolName(decision.action)
    ? decision.action
    : null;
  const wantsTool = hasToolField || actionToolName !== null;
  const wantsDone = decision.done === true || decision.action === "done";
  const wantsThink = typeof decision.think === "string" || typeof decision.thought === "string";

  // Exactly one action per decision: a response that both calls a tool and
  // claims completion (or hides a decision inside a think) must not execute.
  const requested = [wantsTool, wantsDone, wantsThink].filter(Boolean).length;
  if (requested > 1) return invalidDecision("conflicting_actions");

  if (wantsTool) {
    if (hasToolField) {
      if (!isPlausibleToolName(decision.tool)) return invalidDecision("invalid_tool_name");
      return { tool: decision.tool, arguments: collectActionArguments(decision) };
    }
    return { tool: actionToolName, arguments: collectActionArguments(decision) };
  }

  if (wantsDone) {
    const result = typeof decision.result === "string" ? decision.result : (typeof decision.text === "string" ? decision.text : null);
    if (result === null || !result.trim()) return invalidDecision("done_without_result");
    return { done: true, result };
  }

  if (typeof decision.think === "string") return { think: decision.think };
  if (typeof decision.thought === "string") return { think: decision.thought };
  return null;
}

function jsonCandidates(text) {
  const trimmed = String(text || "").trim();
  const candidates = [];
  if (trimmed) candidates.push(trimmed);

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  return [...new Set(candidates)];
}

function parseAgentDecision(text) {
  let firstInvalid = null;
  for (const candidate of jsonCandidates(text)) {
    try {
      const normalized = normalizeDecision(JSON.parse(candidate));
      if (normalized && !normalized.invalid) return normalized;
      if (normalized && normalized.invalid && !firstInvalid) firstInvalid = normalized;
    } catch {}
  }
  // A parsed-but-rejected decision surfaces its rejection reason so the loop
  // can give bounded corrective feedback instead of treating it as reasoning.
  if (firstInvalid) return firstInvalid;
  return { think: String(text || "").trim() };
}

/**
 * Resolve a model-requested tool name against the agent-visible catalog.
 *
 * Canonical names are unprefixed (`bash`, `respond`); legacy `sidekick_`
 * aliases remain accepted for compatibility. Resolution is advisory: the
 * dispatcher independently re-resolves, validates, and enforces policy and
 * approval for whatever name is dispatched.
 *
 * Returns { def, name, canonical, alias } or null when the name is malformed
 * or not present in the provided catalog.
 */
function resolveAgentToolName(requestedName, defs) {
  if (!isPlausibleToolName(requestedName)) return null;
  const canonical = stripSidekickPrefix(requestedName);
  const def = (defs || []).find(d => d && typeof d.name === "string" && stripSidekickPrefix(d.name) === canonical);
  if (!def) return null;
  return { def, name: def.name, canonical, alias: requestedName !== def.name };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function decisionFingerprint(decision) {
  if (decision?.think) return "think:" + decision.think.replace(/\s+/g, " ").trim();
  return JSON.stringify(canonicalize(decision));
}

function trackDecisionRepetition(state, decision) {
  const fingerprint = decisionFingerprint(decision);
  const repeats = fingerprint === state.fingerprint ? state.repeats + 1 : 0;
  return {
    fingerprint,
    repeats,
    repeated: repeats > 0,
    abort: repeats >= 2
  };
}

function selectBestModelName(modelNames, configuredModel = "") {
  if (configuredModel) return configuredModel;
  const names = modelNames.map(name => name.toLowerCase());
  const priorities = [
    "llama3.1",
    "llama3",
    "qwen2.5",
    "mistral",
    "gemma",
    "phi3",
    "deepseek-coder",
    "qwen2.5-coder",
    "codellama",
    "starcoder"
  ];
  for (const preferred of priorities) {
    const found = names.find(name => name.includes(preferred));
    if (found) return found;
  }
  return names[0] || "phi3:mini";
}

function buildChatMessages(systemPrompt, messages) {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map(message => ({
      role: ["system", "assistant", "user"].includes(message.role) ? message.role : "user",
      content: message.content
    }))
  ];
}

/**
 * Deterministic, auditable classification of whether a goal needs current
 * local evidence (and therefore the tool loop) or can be answered directly.
 *
 * This is routing, not authorization: a goal routed to the tool loop still
 * has every tool call re-validated by the dispatcher (schema, policy,
 * approval), and a misclassification can never execute anything by itself.
 * The returned reason is stable and is surfaced to tests, the SSE stream,
 * and platform observability events.
 */
function classifyEvidenceRequirement(goal) {
  const text = String(goal || "").toLowerCase();
  if (!text.trim()) return { requiresTools: false, reason: "empty_goal" };

  const toolNamePattern = /\b(?:sidekick_[a-z0-9_]+|(?:web_fetch|ci_status|security_scan|black_box|db_query|db_schema|db_stats|db_backup|db_restore|db_export|db_search|db_migrate|db_diff|debug_tool|diff_files|log_query|insight_report|memory_export|memory_import|memory_manage|sync_identity|sync_export|sync_import|sync_diff|list_projects|get_by_project|runbook|evolve|orchestrate|predict|sandbox|netdiag|timeline|circuit|baseline|tunnel|nginx|redis|ocr|embed|transcribe|download|wireguard|knowledge|handoff|fresheyes|respond|anonymize|changelog|depend))\b/;
  const localResourcePattern = /\b(tools?|repo|repository|project|memory|context|deploy(?:ment)?|service|services|health|status|logs?|history|conversation|transcript|task|tasks|model|models|ollama|database|db|knowledge|kv|watch(?:es)?|delay(?:s)?)\b/;
  const localActionPattern = /\b(list|count|show|inspect|check|look up|lookup|find|fetch|get|read|open|delete|remove|update|create|store|save|set|merge|deploy|restart|stop|start|run|recall|search|query)\b/;
  const exactnessPattern = /\b(current|currently|latest|recent|right now|today|exact|exactly|available|configured|enabled|running|active|pending|in this repo|in the repo|in this project|on disk)\b/;
  // "How can I / how does someone ..." is a request for instructions, not for
  // Sidekick to inspect anything — unlike "how much disk space is free", which
  // asks about actual current state and stays on the tool path.
  const conceptualPromptPattern = /^(explain|describe|summari[sz]e|compare|brainstorm|suggest|recommend|draft|write|reword|phrase|improve|tune|analyze|review|why\b|how does\b|how should\b|how (?:can|could|do|would|might) (?:i|you|one|someone|somebody|we)\b)/;
  // System-inspection requests ("check disk usage", "how much free memory") name a
  // live host resource that can only be answered by running an approved tool, never
  // by describing a command. These must reach the tool loop even though the phrasing
  // does not match a Sidekick resource noun above.
  const systemInspectionPattern = /\b(disk|drives?|volumes?|mount(?:s|ed)?|storage|filesystem|file\s+system|free\s+space|cpu|cpus|processor|load\s+average|uptime|ram|swap|memory\s+usage|free\s+memory|running\s+process(?:es)?|process\s+list|open\s+ports?|listening\s+ports?|network\s+interfaces?|bandwidth)\b/;

  if (toolNamePattern.test(text)) return { requiresTools: true, reason: "explicit_tool_reference" };

  if (conceptualPromptPattern.test(text) && !exactnessPattern.test(text)) {
    return { requiresTools: false, reason: "conceptual_prompt" };
  }

  if (systemInspectionPattern.test(text)) return { requiresTools: true, reason: "system_inspection" };

  const localSignals = [
    /\bhow many\b.*\b(tools?|services|models|tasks|memories|watches|delays)\b/,
    /\b(status|logs?|history|memory|context|database|db|knowledge|repo|repository|project)\b.*\b(current|latest|recent|today|running|active|configured|enabled)\b/,
    new RegExp(localActionPattern.source + ".*" + localResourcePattern.source),
    new RegExp(localResourcePattern.source + ".*" + exactnessPattern.source)
  ];

  if (localSignals.some(pattern => pattern.test(text))) {
    return { requiresTools: true, reason: "local_resource_signal" };
  }
  return { requiresTools: false, reason: "no_evidence_signals" };
}

function requiresToolUse(goal) {
  return classifyEvidenceRequirement(goal).requiresTools;
}

module.exports = {
  normalizeDecision,
  parseAgentDecision,
  resolveAgentToolName,
  decisionFingerprint,
  trackDecisionRepetition,
  selectBestModelName,
  buildChatMessages,
  classifyEvidenceRequirement,
  requiresToolUse,
  MAX_TOOL_NAME_LENGTH
};
