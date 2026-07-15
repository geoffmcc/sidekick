const dbStore = require("../db");
const { detectCandidates } = require("./analyzer");
const { candidateToCapability, validateCapability, transition, usefulness } = require("./lifecycle");

function text(payload) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function error(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function loadExistingProcedures(loadProcedures) {
  try { return Object.keys(loadProcedures ? loadProcedures() : {}); } catch { return []; }
}

function toolContext(deps) {
  const generated = dbStore.listGeneratedCapabilities({ includeInactive: true }).map(c => c.name);
  return {
    builtIns: (deps.TOOL_DEFS || []).map(t => t.name),
    procedures: loadExistingProcedures(deps.loadProcedures),
    generated,
    pending: dbStore.listGeneratedCapabilities({ states: ["candidate", "validated", "awaiting_approval", "trial"] }).map(c => c.name),
  };
}

function refreshCandidates(deps, options = {}) {
  const logs = dbStore.readToolLogs(options.limit || 2000);
  const candidates = detectCandidates(logs, toolContext(deps), options);
  const stored = [];
  for (const candidate of candidates) {
    const existing = dbStore.getGeneratedCapability(candidate.id) || dbStore.getGeneratedCapabilityByName(candidate.proposedToolName);
    if (existing) continue;
    const capability = candidateToCapability(candidate);
    dbStore.saveGeneratedCapability(capability);
    stored.push(capability);
  }
  return { observedLogCount: logs.length, candidatesFound: candidates.length, stored: stored.length, candidates };
}

function formatList(items) {
  if (!items.length) return "No Evolve candidates or generated capabilities.";
  return items.map(item => [
    item.id,
    item.state,
    item.name,
    `score=${item.usefulnessScore}`,
    `evidence=${item.evidenceCount || 0}`,
    `success=${Math.round((item.successRate || 0) * 100)}%`,
    `risk=${item.risk}`,
  ].join(" | ")).join("\n");
}

async function sidekick_evolve(args = {}, deps = {}) {
  const action = args.action || "analyze";
  if (action === "analyze") {
    const result = refreshCandidates(deps, args);
    return text({
      observations: { logs_analyzed: result.observedLogCount, candidates_found: result.candidatesFound, new_candidates_stored: result.stored },
      candidates: result.candidates.slice(0, 10).map(c => ({
        id: c.id,
        title: c.title,
        proposed_tool_name: c.proposedToolName,
        evidence_count: c.evidenceCount,
        success_rate: c.successRate,
        usefulness_score: c.score,
        duplicate: c.duplicate,
        duplicate_reasons: c.duplicateReasons,
        parameters: c.parameters,
        score_breakdown: c.scoreBreakdown,
      })),
    });
  }
  if (action === "candidates" || action === "list") {
    const items = dbStore.listGeneratedCapabilities({ includeInactive: true });
    return text(formatList(items));
  }
  if (action === "propose") {
    if (!args.proposal) return error("proposal required");
    let parsed;
    try {
      parsed = typeof args.proposal === "string" && args.proposal.trim().startsWith("{")
        ? JSON.parse(args.proposal)
        : null;
    } catch (e) {
      return error(`proposal JSON is invalid: ${e.message}`);
    }
    if (!parsed || !Array.isArray(parsed.steps)) {
      return error("Manual proposals must be structured JSON with steps, parameters, description, and proposedToolName; free-text proposals are no longer treated as tools.");
    }
    if (!parsed.proposedToolName && !parsed.name) return error("structured proposal requires proposedToolName or name");
    const capability = candidateToCapability({
      id: parsed.id || `cand_manual_${Date.now().toString(36)}`,
      proposedToolName: parsed.proposedToolName || parsed.name,
      title: parsed.title || parsed.proposedToolName || parsed.name,
      description: parsed.description || parsed.title || "Manual Evolve proposal",
      state: "candidate",
      evidence: parsed.evidence || [{ source: "manual", note: "manual structured proposal" }],
      evidenceCount: (parsed.evidence || []).length || 1,
      successRate: parsed.successRate || 0,
      score: parsed.score || 0,
      scoreBreakdown: parsed.scoreBreakdown || { manual: true },
      parameters: parsed.parameters || {},
      steps: parsed.steps,
      risk: parsed.risk || "medium",
    });
    dbStore.saveGeneratedCapability(capability);
    return text({ proposed: capability.id, state: capability.state, next: "validate" });
  }
  if (action === "inspect") {
    if (!args.id) return error("id required");
    const item = dbStore.getGeneratedCapability(args.id) || dbStore.getGeneratedCapabilityByName(args.id);
    return item ? text(item) : error(`Evolve capability not found: ${args.id}`);
  }
  if (action === "validate" || action === "test") {
    if (!args.id) return error("id required");
    const item = dbStore.getGeneratedCapability(args.id) || dbStore.getGeneratedCapabilityByName(args.id);
    if (!item) return error(`Evolve capability not found: ${args.id}`);
    validateCapability(item, deps.TOOL_DEFS || []);
    dbStore.saveGeneratedCapability(item);
    return text({ id: item.id, state: item.state, validation: item.validation });
  }
  if (action === "approve") {
    if (!args.id) return error("id required");
    const item = dbStore.getGeneratedCapability(args.id) || dbStore.getGeneratedCapabilityByName(args.id);
    if (!item) return error(`Evolve capability not found: ${args.id}`);
    if (!item.validation || !item.validation.passed) validateCapability(item, deps.TOOL_DEFS || []);
    if (!item.validation.passed) {
      dbStore.saveGeneratedCapability(item);
      return error(`Validation failed; not approved: ${JSON.stringify(item.validation.checks, null, 2)}`);
    }
    item.approver = args.approver || "user";
    transition(item, "trial", { approver: item.approver, reason: "explicit approval" });
    item.activationDate = new Date().toISOString();
    dbStore.saveGeneratedCapability(item);
    dbStore.syncGeneratedToolRegistry();
    return text({ approved: item.id, state: item.state, dynamic_tool: item.name, restart_required_for_mcp_registration: true });
  }
  if (action === "activate_trial") return sidekick_evolve({ ...args, action: "approve" }, deps);
  if (action === "promote") {
    if (!args.id) return error("id required");
    const item = dbStore.getGeneratedCapability(args.id) || dbStore.getGeneratedCapabilityByName(args.id);
    if (!item) return error(`Evolve capability not found: ${args.id}`);
    if (item.state !== "trial") return error(`Can only promote trial tools (current state: ${item.state})`);
    if ((item.successCount || 0) < 1) return error("Cannot promote before at least one successful trial invocation");
    transition(item, "active", { reason: "trial success promoted" });
    dbStore.saveGeneratedCapability(item);
    dbStore.syncGeneratedToolRegistry();
    return text({ promoted: item.id, state: item.state, dynamic_tool: item.name });
  }
  if (action === "reject") {
    if (!args.id) return error("id required");
    const item = dbStore.getGeneratedCapability(args.id) || dbStore.getGeneratedCapabilityByName(args.id);
    if (!item) return error(`Evolve capability not found: ${args.id}`);
    transition(item, "rejected", { reason: args.reason || "explicit rejection" });
    dbStore.saveGeneratedCapability(item);
    dbStore.syncGeneratedToolRegistry();
    return text({ rejected: item.id, state: item.state });
  }
  if (action === "revise") {
    if (!args.id || !args.proposal) return error("id and structured proposal required");
    const item = dbStore.getGeneratedCapability(args.id) || dbStore.getGeneratedCapabilityByName(args.id);
    if (!item) return error(`Evolve capability not found: ${args.id}`);
    let parsed;
    try { parsed = typeof args.proposal === "string" ? JSON.parse(args.proposal) : args.proposal; } catch (e) { return error(`proposal JSON is invalid: ${e.message}`); }
    if (parsed.description) item.description = parsed.description;
    if (parsed.parameters) item.parameters = parsed.parameters;
    if (parsed.steps) item.steps = parsed.steps;
    item.version = (item.version || 1) + 1;
    item.validation = null;
    item.schema = null;
    transition(item, "candidate", { reason: args.reason || "revised" });
    dbStore.saveGeneratedCapability(item);
    return text({ revised: item.id, version: item.version, state: item.state, next: "validate" });
  }
  if (action === "deprecate") {
    if (!args.id) return error("id required");
    const item = dbStore.getGeneratedCapability(args.id) || dbStore.getGeneratedCapabilityByName(args.id);
    if (!item) return error(`Evolve capability not found: ${args.id}`);
    item.deprecationReason = args.reason || "explicit deprecation";
    transition(item, "deprecated", { reason: item.deprecationReason });
    dbStore.saveGeneratedCapability(item);
    dbStore.syncGeneratedToolRegistry();
    return text({ deprecated: item.id, state: item.state, audit_history_retained: true });
  }
  if (action === "feedback") {
    if (!args.id || args.useful === undefined) return error("id and useful required");
    const item = dbStore.getGeneratedCapability(args.id) || dbStore.getGeneratedCapabilityByName(args.id);
    if (!item) return error(`Evolve capability not found: ${args.id}`);
    item.userFeedback = item.userFeedback || [];
    item.userFeedback.push({ useful: Boolean(args.useful), notes: args.notes || "", at: new Date().toISOString() });
    item.usefulnessScore = usefulness(item);
    dbStore.saveGeneratedCapability(item);
    return text({ id: item.id, usefulness_score: item.usefulnessScore, feedback_count: item.userFeedback.length });
  }
  if (action === "report") {
    const items = dbStore.listGeneratedCapabilities({ includeInactive: true });
    return text({
      totals: items.reduce((acc, item) => { acc[item.state] = (acc[item.state] || 0) + 1; return acc; }, {}),
      dynamic_tools: items.filter(i => i.state === "trial" || i.state === "active").map(i => ({ name: i.name, state: i.state, use_count: i.useCount, success_count: i.successCount, failure_count: i.failureCount, usefulness_score: i.usefulnessScore })),
      candidates: items.filter(i => ["candidate", "validated", "awaiting_approval"].includes(i.state)).length,
    });
  }
  if (action === "cleanup") return text("Evolve cleanup now retains DB audit history; use reject/deprecate instead of deleting evidence.");
  return error("Unknown action. Use: analyze, candidates, inspect, validate, approve, activate_trial, promote, reject, deprecate, feedback, report, cleanup");
}

module.exports = { sidekick_evolve, refreshCandidates };
