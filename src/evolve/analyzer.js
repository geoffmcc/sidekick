const { fingerprint, normalizeArgs, stableStringify, slugify } = require("./common");

const DEFAULT_GAP_MS = 30 * 60 * 1000;
const MIN_STEPS = 2;
const INTERNAL_TOOL_RE = /^(?:sidekick_)?(?:resume|get|store|status|debug_tool|cache|delay|queue|generated_resume|evolve)$/;
const GENERATED_TOOL_RE = /^(?:sidekick_)?generated_/;
const SUPPORTING_KINDS = new Set(["file_read", "file_hash", "memory", "unknown_readonly"]);

function parseTime(value) {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) ? ts : 0;
}

function redactCommand(command = "") {
  return String(command).replace(/(token|password|secret|api[_-]?key)=\S+/gi, "$1=[REDACTED]");
}

function canonicalLog(entry, index = 0) {
  const rawArgs = entry.args || entry.raw_args || null;
  const argsShape = entry.args_shape || entry.arg_shape || entry.argsShape || normalizeArgs(rawArgs || {});
  const name = entry.n || entry.tool_name || entry.tool || "unknown";
  return {
    id: entry.id || entry.log_id || index,
    timestamp: entry.t || entry.timestamp,
    time: parseTime(entry.t || entry.timestamp),
    source: entry.src || entry.source || "unknown",
    sessionId: entry.session_id || entry.sessionId || entry.session || "unknown",
    taskId: entry.task_id || entry.request_id || entry.taskId || entry.requestId || "unknown",
    project: entry.project || entry.cwd || entry.context || "unknown",
    name,
    args: rawArgs || argsShape,
    argsShape,
    argsFingerprint: entry.arg_fingerprint || entry.args_fingerprint || fingerprint(argsShape),
    success: entry.ok === undefined ? Boolean(entry.success) : Boolean(entry.ok),
    errorCategory: entry.error_category || entry.errorCategory || null,
    durationMs: Number(entry.d || entry.duration_ms || 0),
    summary: entry.result_summary || entry.s || entry.summary || "",
    correlationId: entry.correlation_id || entry.parent_id || null,
    retry: Boolean(entry.retry || entry.is_retry),
    generated: Boolean(entry.generated || entry.generated_procedure || entry.initiated_by_generated_procedure || GENERATED_TOOL_RE.test(name)),
  };
}

function chronologicalLogs(logs) {
  return (logs || []).map(canonicalLog).sort((a, b) => (a.time - b.time) || String(a.id).localeCompare(String(b.id)));
}

function isInternal(record) {
  return INTERNAL_TOOL_RE.test(record.name) || record.generated || record.source === "evolve";
}

function segmentLogs(logs, options = {}) {
  const gapMs = options.inactivityGapMs || DEFAULT_GAP_MS;
  const ordered = chronologicalLogs(logs).filter(r => r.name && !isInternal(r));
  const segments = [];
  let current = null;

  for (const record of ordered) {
    const boundary = !current ||
      current.source !== record.source ||
      current.sessionId !== record.sessionId ||
      current.taskId !== record.taskId ||
      (record.time - current.lastTime) > gapMs;
    if (boundary) {
      current = {
        source: record.source,
        sessionId: record.sessionId,
        taskId: record.taskId,
        project: record.project,
        lastTime: record.time,
        records: [],
      };
      segments.push(current);
    }
    current.records.push(record);
    current.lastTime = record.time;
  }
  return segments.filter(s => s.records.length >= MIN_STEPS);
}

function arg(record, name) {
  return (record.args && record.args[name]) ?? (record.argsShape && record.argsShape[name]);
}

function parseUrl(text) {
  try {
    const value = String(text || "");
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    return { protocol: url.protocol.replace(":", ""), host: url.hostname, port: url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80), path: url.pathname || "/" };
  } catch {
    return null;
  }
}

function classifyBash(record) {
  const command = redactCommand(arg(record, "command") || "");
  const compact = command.replace(/\s+/g, " ").trim();
  let match = compact.match(/^(?:sudo\s+-n\s+)?systemctl\s+(?:status|is-active)\s+([\w@.-]+)(?:\.service)?\b/i);
  if (match) return { kind: "service_status", risk: "read-only", params: { service: match[1].replace(/\.service$/i, "") }, normalized: "systemctl status <service>" };
  match = compact.match(/^journalctl\s+.*(?:-u|--unit)\s+([\w@.-]+)(?:\.service)?\b/i);
  if (match) return { kind: "service_logs", risk: "read-only", params: { service: match[1].replace(/\.service$/i, "") }, normalized: "journalctl -u <service>" };
  match = compact.match(/^git\s+-C\s+([^\s]+)\s+status\b/i) || compact.match(/^git\s+status\b/i);
  if (match) return { kind: "repository_status", risk: "read-only", params: { repository_path: match[1] || arg(record, "cwd") || record.project }, normalized: "git -C <repository_path> status" };
  match = compact.match(/^curl\s+(?:-[\w-]+\s+)*(https?:\/\/[^\s]+|[\w.-]+:\d+[^\s]*)/i);
  if (match) {
    const parsed = parseUrl(match[1]);
    if (parsed) return { kind: "reachability_check", risk: "network-read", params: parsed, normalized: "curl <protocol>://<host>:<port>" };
  }
  if (/\b(rm\s+-rf|mkfs|dd\s+.*\bof=|curl\s+.*\|\s*(?:bash|sh)|sudo\b|systemctl\s+(?:restart|stop|start|enable|disable))\b/i.test(compact)) {
    return { kind: "unknown_shell", risk: "destructive", params: {}, normalized: "unknown bash mutation" };
  }
  if (/\b(cat|ls|pwd|df|free|ps|ss|netstat|grep|rg|find)\b/i.test(compact)) return { kind: "unknown_readonly", risk: "read-only", params: {}, normalized: "read-only shell inspection" };
  return { kind: "unknown_shell", risk: "high", params: {}, normalized: "unclassified bash" };
}

function classifyOperation(record) {
  const name = record.name.replace(/^sidekick_/, "");
  if (name === "bash") return classifyBash(record);
  if (name === "service") {
    const action = arg(record, "action");
    const service = arg(record, "service");
    if (["status", "logs"].includes(action)) return { kind: action === "logs" ? "service_logs" : "service_status", risk: "read-only", params: { service }, normalized: `service ${action} <service>` };
    if (["restart", "start", "stop", "enable", "disable"].includes(action)) return { kind: "service_mutation", risk: "privileged", params: { service, action }, normalized: "service mutation <service>" };
  }
  if (name === "netdiag") return { kind: "reachability_check", risk: "network-read", params: { target: arg(record, "target"), port_range: arg(record, "port_range") }, normalized: "network diagnostic <target>" };
  if (name === "web_fetch") {
    const parsed = parseUrl(arg(record, "url"));
    return { kind: "reachability_check", risk: "network-read", params: parsed || { url: arg(record, "url") }, normalized: "fetch <url>" };
  }
  if (name === "github") {
    const action = arg(record, "action");
    const readonly = /^(repo_info|pr_get|pr_list|issue_list|commit_status)$/i.test(String(action || ""));
    return { kind: readonly ? "github_inspection" : "github_mutation", risk: readonly ? "remote-read" : "remote-modification", params: { action, repo: arg(record, "repo") }, normalized: `github ${action || "operation"}` };
  }
  if (name === "read") return { kind: "file_read", risk: "read-only", params: { path: arg(record, "path") }, normalized: "read file <path>" };
  if (name === "hash") return { kind: "file_hash", risk: "read-only", params: { path: arg(record, "path"), algorithm: arg(record, "algorithm") }, normalized: "hash file <path>" };
  if (/write|delete|restore|kill|flush|remove/i.test(name)) return { kind: "local_mutation", risk: "local-modification", params: {}, normalized: name };
  return { kind: "unknown", risk: "unknown", params: {}, normalized: name };
}

function semanticFamily(operations) {
  const kinds = new Set(operations.map(o => o.kind));
  if (kinds.has("unknown_shell") || kinds.has("github_mutation") || kinds.has("service_mutation") || kinds.has("local_mutation")) return null;
  if (kinds.has("service_status") && kinds.has("service_logs")) return {
    key: "service_diagnosis",
    title: "Diagnose a systemd service",
    description: "Checks a selected systemd service state and recent logs to summarize service health.",
    requiredKinds: ["service_status", "service_logs"],
    successCriteria: "The service status and log inspection complete successfully for the same service parameter.",
    reusableReason: "Service troubleshooting recurs across different service names and hosts.",
    outputs: "Service state, recent log evidence, and a concise diagnostic summary.",
  };
  if (kinds.has("repository_status") && operations.length >= 2) return {
    key: "repository_health_check",
    title: "Run repository health checks",
    description: "Collects repository state and supporting inspection evidence for a selected working tree.",
    requiredKinds: ["repository_status"],
    successCriteria: "Repository status and supporting checks complete without tool errors.",
    reusableReason: "Repository health checks recur across different project paths.",
    outputs: "Repository cleanliness and supporting diagnostic evidence.",
  };
  if (kinds.has("reachability_check") && operations.length >= 2) return {
    key: "reachability_diagnostic",
    title: "Test service reachability",
    description: "Checks whether a URL or host/port endpoint is reachable and collects network evidence.",
    requiredKinds: ["reachability_check"],
    successCriteria: "Reachability checks complete and return structured endpoint evidence.",
    reusableReason: "Endpoint reachability diagnostics recur across hosts, ports, and protocols.",
    outputs: "Endpoint status, network evidence, and diagnostic summary.",
  };
  return null;
}

function valueForParam(operation, name) {
  return operation.params ? operation.params[name] : undefined;
}

function inferFamilyParameters(traces, family) {
  const parameters = {};
  const reasons = {};
  const allOps = traces.map(t => t.operations);
  const paramNames = new Set();
  for (const ops of allOps) for (const op of ops) for (const name of Object.keys(op.params || {})) paramNames.add(name);
  for (const name of paramNames) {
    const values = allOps.map(ops => {
      const withParam = ops.find(op => valueForParam(op, name) !== undefined);
      return withParam ? valueForParam(withParam, name) : undefined;
    }).filter(v => v !== undefined && v !== null && v !== "unknown");
    if (!values.length) continue;
    const unique = Array.from(new Set(values.map(v => stableStringify(v))));
    const shouldParameterize = unique.length > 1 || ["service", "host", "port", "protocol", "repository_path", "target", "url", "repo"].includes(name);
    if (!shouldParameterize) continue;
    parameters[name] = {
      type: values.every(v => typeof v === "number" || /^\d+$/.test(String(v))) ? "number" : "string",
      description: `Inferred ${name} parameter from ${unique.length} observed value${unique.length === 1 ? "" : "s"} in ${family.title.toLowerCase()} traces`,
      required: true,
      examples: values.slice(0, 5),
      maxLength: name === "port" ? undefined : 300,
    };
    reasons[name] = { observedValues: unique.length, evidence: values.slice(0, 5) };
  }
  return { parameters, parameterReasons: reasons };
}

function operationToStep(operation, record, parameters) {
  const p = name => parameters[name] ? `{{${name}}}` : operation.params[name];
  const name = record.name.replace(/^sidekick_/, "");
  if (name === "bash") {
    if (operation.kind === "service_status") return { tool: "bash", args: { command: `systemctl status ${p("service")}` } };
    if (operation.kind === "service_logs") return { tool: "bash", args: { command: `journalctl -u ${p("service")} -n 80 --no-pager` } };
    if (operation.kind === "repository_status") return { tool: "bash", args: { command: `git -C ${p("repository_path")} status --short --branch` } };
    if (operation.kind === "reachability_check") return { tool: "bash", args: { command: `curl -fsS ${p("protocol")}://${p("host")}:${p("port")}` } };
  }
  const args = normalizeArgs(record.args || record.argsShape || {});
  for (const [name] of Object.entries(parameters)) {
    for (const key of Object.keys(args)) {
      if (stableStringify(args[key]) === stableStringify(operation.params[name])) args[key] = `{{${name}}}`;
    }
  }
  return { tool: record.name, args };
}

function buildSemanticSteps(trace, parameters) {
  const seen = new Set();
  const steps = [];
  for (let i = 0; i < trace.operations.length; i++) {
    const op = trace.operations[i];
    if (SUPPORTING_KINDS.has(op.kind)) continue;
    const key = `${op.kind}:${trace.records[i].name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(operationToStep(op, trace.records[i], parameters));
  }
  return steps;
}

function riskFromOperations(operations) {
  const risks = operations.map(o => o.risk);
  if (risks.some(r => ["destructive", "privileged", "remote-modification"].includes(r))) return "critical";
  if (risks.some(r => ["high", "unknown", "local-modification"].includes(r))) return "high";
  if (risks.some(r => ["network-read", "remote-read"].includes(r))) return "medium";
  return "low";
}

function hasCompletionEvidence(trace) {
  const text = trace.records.map(r => `${r.summary} ${r.errorCategory || ""}`).join(" ").toLowerCase();
  if (trace.records.every(r => r.success) && !/(failed|error|timeout|denied|not found|unreachable)/.test(text)) return { success: true, confidence: "inferred", reason: "all semantic steps succeeded and no corrective/error summary followed" };
  if (/verified|complete|succeeded|success|healthy|reachable|active/.test(text) && trace.records.every(r => r.success)) return { success: true, confidence: "explicit", reason: "trace summary contains explicit success evidence" };
  return { success: false, confidence: "low", reason: "completion could not be established" };
}

function scoreCandidate({ traces, parameters, family, duplicatePenalty, riskPenalty, estimatedCallsSaved, successRate }) {
  const paramCount = Object.keys(parameters).length;
  const evidenceScore = Math.min(traces.length / 6, 1) * 20;
  const successScore = successRate * 18;
  const semanticScore = family ? 20 : 0;
  const parameterScore = paramCount ? Math.min(paramCount / 4, 1) * 15 : 0;
  const savingsScore = estimatedCallsSaved > 0 ? Math.min(estimatedCallsSaved / 4, 1) * 12 : 0;
  const completionScore = traces.some(t => t.completion.confidence === "explicit") ? 10 : 6;
  const raw = semanticScore + evidenceScore + successScore + parameterScore + savingsScore + completionScore - duplicatePenalty - riskPenalty;
  const penalties = [];
  let ceiling = 100;
  if (!family) { ceiling = Math.min(ceiling, 35); penalties.push("no semantic task identity ceiling=35"); }
  if (!paramCount) { ceiling = Math.min(ceiling, 60); penalties.push("no inferred parameters ceiling=60"); }
  if (estimatedCallsSaved <= 0) { ceiling = Math.min(ceiling, 50); penalties.push("zero estimated calls saved ceiling=50"); }
  if (traces.length < 3) { ceiling = Math.min(ceiling, 70); penalties.push("low evidence count ceiling=70"); }
  const score = Math.max(0, Math.min(ceiling, Math.round(raw)));
  return {
    score,
    scoreBreakdown: {
      semanticTask: semanticScore,
      evidence: Math.round(evidenceScore),
      workflowSuccess: Math.round(successScore),
      parameters: Math.round(parameterScore),
      estimatedSavings: Math.round(savingsScore),
      completionEvidence: completionScore,
      duplicatePenalty,
      riskPenalty,
      ceiling,
      penalties,
    },
  };
}

function duplicateReasonsFor(toolName, existing = {}) {
  const builtIns = new Set(existing.builtIns || []);
  const procedures = new Set(existing.procedures || []);
  const generated = new Set(existing.generated || []);
  const pending = new Set(existing.pending || []);
  const reasons = [];
  const baseName = toolName.replace(/^(?:sidekick_)?generated_/, "");
  if (builtIns.has(toolName) || builtIns.has(baseName)) reasons.push("built-in tool name collision");
  if (procedures.has(baseName) || procedures.has(toolName)) reasons.push("existing procedure covers this task");
  if (generated.has(toolName)) reasons.push("generated tool already exists");
  if (pending.has(toolName)) reasons.push("pending Evolve candidate exists");
  return reasons;
}

function reject(reason, segment, diagnostics) {
  diagnostics.rejectedTraces += 1;
  diagnostics.rejectionReasons[reason] = (diagnostics.rejectionReasons[reason] || 0) + 1;
  if (diagnostics.samples.length < 20) diagnostics.samples.push({ reason, sessionId: segment.sessionId, taskId: segment.taskId, tools: segment.records.map(r => r.name) });
}

function detectCandidates(logs, existing = {}, options = {}) {
  const diagnostics = { rejectedTraces: 0, rejectionReasons: {}, samples: [] };
  const minOccurrences = options.minOccurrences || 3;
  const minScore = options.minScore || 60;
  const segments = segmentLogs(logs, options);
  const groups = new Map();

  for (const segment of segments) {
    if (segment.records.some(r => r.retry)) { reject("retry trace", segment, diagnostics); continue; }
    const operations = segment.records.map(classifyOperation);
    if (operations.every(op => SUPPORTING_KINDS.has(op.kind) || op.kind === "unknown")) { reject("supporting/internal-only trace", segment, diagnostics); continue; }
    const family = semanticFamily(operations);
    if (!family) { reject("no coherent semantic task", segment, diagnostics); continue; }
    const completion = hasCompletionEvidence(segment);
    if (!completion.success) { reject("no verified completion", segment, diagnostics); continue; }
    const trace = { ...segment, operations, family, completion };
    if (!groups.has(family.key)) groups.set(family.key, []);
    groups.get(family.key).push(trace);
  }

  const candidates = [];
  for (const [familyKey, traces] of groups.entries()) {
    if (traces.length < minOccurrences) {
      for (const trace of traces) reject("insufficient independent evidence", trace, diagnostics);
      continue;
    }
    const family = traces[0].family;
    const successes = traces.filter(t => t.completion.success && t.records.every(r => r.success));
    const successRate = successes.length / traces.length;
    if (successes.length < minOccurrences || successRate < 0.75) {
      for (const trace of traces) reject("workflow success below threshold", trace, diagnostics);
      continue;
    }
    const { parameters, parameterReasons } = inferFamilyParameters(successes, family);
    if (!Object.keys(parameters).length) {
      for (const trace of traces) reject("no useful parameterization", trace, diagnostics);
      continue;
    }
    const steps = buildSemanticSteps(successes[0], parameters);
    const estimatedCallsSaved = Math.max(steps.length - 1, 0);
    if (steps.length < MIN_STEPS || estimatedCallsSaved <= 0) {
      for (const trace of traces) reject("zero estimated savings", trace, diagnostics);
      continue;
    }
    const toolName = `generated_${slugify(familyKey)}`.slice(0, 80);
    const duplicateReasons = duplicateReasonsFor(toolName, existing);
    const duplicatePenalty = duplicateReasons.length ? 35 : 0;
    const risk = riskFromOperations(successes.flatMap(t => t.operations));
    const riskPenalty = risk === "critical" ? 30 : risk === "high" ? 20 : risk === "medium" ? 5 : 0;
    const { score, scoreBreakdown } = scoreCandidate({ traces: successes, parameters, family, duplicatePenalty, riskPenalty, estimatedCallsSaved, successRate });
    if (score < minScore) {
      for (const trace of traces) reject("score below quality gate", trace, diagnostics);
      continue;
    }
    const evidence = successes.slice(0, 10).map(t => ({
      source: t.source,
      sessionId: t.sessionId,
      taskId: t.taskId,
      project: t.project,
      startedAt: t.records[0].timestamp,
      endedAt: t.records[t.records.length - 1].timestamp,
      tools: t.records.map(r => r.name),
      operations: t.operations.map(o => o.normalized),
      completion: t.completion,
      summaries: t.records.map(r => r.summary).filter(Boolean).slice(0, 3),
    }));
    candidates.push({
      id: `cand_${fingerprint({ familyKey, steps, parameters })}`,
      title: family.title,
      proposedToolName: toolName,
      state: "candidate",
      description: `${family.description} Expected inputs: ${Object.keys(parameters).join(", ")}. Expected outputs: ${family.outputs}. Success criteria: ${family.successCriteria}. Reusable because: ${family.reusableReason}. Not already handled by an existing tool: ${duplicateReasons.length ? duplicateReasons.join("; ") : "no matching built-in, procedure, generated, or pending tool name was found"}.`,
      steps,
      parameters,
      parameterReasons,
      evidence,
      evidenceCount: successes.length,
      totalObserved: traces.length,
      successRate,
      score,
      scoreBreakdown: { ...scoreBreakdown, parameterCount: Object.keys(parameters).length, callsSavedPerUse: estimatedCallsSaved },
      duplicate: duplicateReasons.length > 0,
      duplicateReasons,
      risk,
      estimatedCallsSaved,
      qualityGates: {
        semanticTask: true,
        boundedTraces: true,
        minimumEvidence: successes.length >= minOccurrences,
        successfulOutcome: true,
        duplicationCheck: duplicateReasons.length === 0,
        usefulParameterization: true,
        positiveEstimatedSavings: estimatedCallsSaved > 0,
        completeSteps: steps.length >= MIN_STEPS,
        validDescription: true,
      },
      createdAt: new Date().toISOString(),
    });
  }

  candidates.diagnostics = diagnostics;
  return candidates.sort((a, b) => b.score - a.score || b.evidenceCount - a.evidenceCount);
}

function buildParameterizedSteps(traces) {
  const candidates = detectCandidates(traces.flatMap(t => t.records || []), {}, { minOccurrences: 1, minScore: 1 });
  return candidates[0] ? { steps: candidates[0].steps, parameters: candidates[0].parameters } : { steps: [], parameters: {} };
}

module.exports = {
  chronologicalLogs,
  segmentLogs,
  detectCandidates,
  buildParameterizedSteps,
  classifyOperation,
  scoreCandidate,
};
