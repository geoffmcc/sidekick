const { fingerprint, normalizeArgs, stableStringify, slugify } = require("./common");

const DEFAULT_GAP_MS = 30 * 60 * 1000;
const MIN_STEPS = 2;

function parseTime(value) {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) ? ts : 0;
}

function canonicalLog(entry, index = 0) {
  const argsShape = entry.args_shape || entry.arg_shape || entry.argsShape || normalizeArgs(entry.args || entry.raw_args || {});
  return {
    id: entry.id || entry.log_id || index,
    timestamp: entry.t || entry.timestamp,
    time: parseTime(entry.t || entry.timestamp),
    source: entry.src || entry.source || "unknown",
    sessionId: entry.session_id || entry.sessionId || entry.session || "unknown",
    taskId: entry.task_id || entry.request_id || entry.taskId || entry.requestId || "unknown",
    project: entry.project || entry.cwd || entry.context || "unknown",
    name: entry.n || entry.tool_name || entry.tool || "unknown",
    argsShape,
    argsFingerprint: entry.arg_fingerprint || entry.args_fingerprint || fingerprint(argsShape),
    success: entry.ok === undefined ? Boolean(entry.success) : Boolean(entry.ok),
    errorCategory: entry.error_category || entry.errorCategory || null,
    durationMs: Number(entry.d || entry.duration_ms || 0),
    summary: entry.result_summary || entry.s || entry.summary || "",
    correlationId: entry.correlation_id || entry.parent_id || null,
    retry: Boolean(entry.retry || entry.is_retry),
    generated: Boolean(entry.generated || entry.generated_procedure || entry.initiated_by_generated_procedure),
  };
}

function chronologicalLogs(logs) {
  return (logs || []).map(canonicalLog).sort((a, b) => (a.time - b.time) || String(a.id).localeCompare(String(b.id)));
}

function workflowKeyFor(record) {
  return `${record.name}:${stableStringify(record.argsShape)}`;
}

function segmentLogs(logs, options = {}) {
  const gapMs = options.inactivityGapMs || DEFAULT_GAP_MS;
  const ordered = chronologicalLogs(logs).filter(r => r.name && r.name !== "sidekick_evolve" && !r.generated);
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

function sequenceSignature(records) {
  return records.map(workflowKeyFor).join(" -> ");
}

function toolSignature(records) {
  return records.map(r => r.name).join(" -> ");
}

function inferValueType(values, key) {
  const defined = values.filter(v => v !== undefined && v !== null);
  if (defined.length === 0) return "string";
  if (defined.every(v => typeof v === "boolean")) return "boolean";
  if (defined.every(v => typeof v === "number")) return "number";
  if (/port/i.test(key) && defined.every(v => /^\d{1,5}$/.test(String(v)))) return "number";
  return "string";
}

function collectPaths(obj, prefix = [], out = []) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collectPaths(v, prefix.concat(i), out));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) collectPaths(v, prefix.concat(k), out);
  } else {
    out.push({ path: prefix, value: obj });
  }
  return out;
}

function pathName(path) {
  const last = String(path[path.length - 1] || "value");
  return slugify(last.replace(/(?:_?path|_?name|_?id)$/i, "$&"), "value");
}

function buildParameterizedSteps(traces) {
  const first = traces[0].records;
  const parameters = {};
  const parameterPaths = new Map();

  for (let stepIndex = 0; stepIndex < first.length; stepIndex++) {
    const paths = collectPaths(first[stepIndex].argsShape);
    for (const item of paths) {
      const values = traces.map(t => {
        let cursor = t.records[stepIndex].argsShape;
        for (const part of item.path) cursor = cursor && cursor[part];
        return cursor;
      });
      const unique = Array.from(new Set(values.map(v => stableStringify(v))));
      const markerParameterized = unique.length === 1 && /^"<[^>]+>"$/.test(unique[0]);
      if (unique.length <= 1 && !markerParameterized) continue;
      let param = pathName(item.path);
      let suffix = 2;
      while (parameters[param]) param = `${pathName(item.path)}_${suffix++}`;
      parameters[param] = {
        type: inferValueType(values, param),
        description: `Inferred from varying ${item.path.join(".")} across successful traces`,
        required: true,
        examples: values.slice(0, 5),
        maxLength: 300,
      };
      parameterPaths.set(`${stepIndex}:${item.path.join(".")}`, param);
    }
  }

  function replaceAt(value, stepIndex, prefix = []) {
    if (Array.isArray(value)) return value.map((v, i) => replaceAt(v, stepIndex, prefix.concat(i)));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = replaceAt(v, stepIndex, prefix.concat(k));
      return out;
    }
    const param = parameterPaths.get(`${stepIndex}:${prefix.join(".")}`);
    return param ? `{{${param}}}` : value;
  }

  const steps = first.map((record, stepIndex) => ({
    tool: record.name,
    args: replaceAt(record.argsShape, stepIndex),
  }));
  return { steps, parameters };
}

function scoreCandidate({ traces, successRate, parameters, duplicatePenalty = 0, riskPenalty = 0 }) {
  const recurrence = Math.min(traces.length / 6, 1) * 25;
  const success = successRate * 25;
  const paramCount = Object.keys(parameters || {}).length;
  const stability = Math.max(0, 1 - Math.min(paramCount / 8, 1)) * 15;
  const callsSaved = Math.min(Math.max(traces[0].records.length - 1, 0) / 6, 1) * 15;
  const newest = Math.max(...traces.map(t => t.records[t.records.length - 1].time));
  const ageDays = (Date.now() - newest) / 86400000;
  const recency = Math.max(0, 1 - Math.min(ageDays / 30, 1)) * 10;
  const confidence = paramCount > 0 ? 10 : 4;
  const raw = recurrence + success + stability + callsSaved + recency + confidence - duplicatePenalty - riskPenalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function detectCandidates(logs, existing = {}, options = {}) {
  const segments = segmentLogs(logs, options);
  const groups = new Map();
  for (const segment of segments) {
    const records = segment.records.filter(r => !r.retry);
    if (records.length < MIN_STEPS) continue;
    const windows = [];
    for (let size = Math.min(5, records.length); size >= MIN_STEPS; size--) {
      for (let start = 0; start <= records.length - size; start++) windows.push(records.slice(start, start + size));
    }
    for (const window of windows) {
      if (window.length < MIN_STEPS) continue;
      if (window.every(r => r.name === window[0].name)) continue;
      const key = sequenceSignature(window);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...segment, records: window });
    }
  }

  const builtIns = new Set(existing.builtIns || []);
  const procedures = new Set(existing.procedures || []);
  const generated = new Set(existing.generated || []);
  const pending = new Set(existing.pending || []);
  const candidates = [];

  for (const [key, traces] of groups.entries()) {
    const minOccurrences = options.minOccurrences || 3;
    if (traces.length < minOccurrences) continue;
    const successes = traces.filter(t => t.records.every(r => r.success));
    const successRate = successes.length / traces.length;
    if (successes.length < minOccurrences || successRate < 0.75) continue;
    const { steps, parameters } = buildParameterizedSteps(successes);
    const names = successes[0].records.map(r => r.name);
    const baseName = slugify(names.join("_then_").replace(/sidekick_/g, ""));
    const toolName = `sidekick_generated_${baseName}`.slice(0, 80);
    const duplicateReasons = [];
    if (builtIns.has(toolName) || builtIns.has(`sidekick_${baseName}`)) duplicateReasons.push("built-in tool name collision");
    if (procedures.has(baseName) || procedures.has(toolName)) duplicateReasons.push("existing procedure covers this name");
    if (generated.has(toolName)) duplicateReasons.push("generated tool already exists");
    if (pending.has(toolName)) duplicateReasons.push("pending Evolve candidate exists");
    const duplicatePenalty = duplicateReasons.length ? 35 : 0;
    const riskyTools = successes[0].records.filter(r => /bash|write|service|git|github|db_restore|process|cron|watch|ops|mission/.test(r.name));
    const riskPenalty = riskyTools.length ? 10 : 0;
    const score = scoreCandidate({ traces: successes, successRate, parameters, duplicatePenalty, riskPenalty });
    if (score < (options.minScore || 55)) continue;
    const evidence = successes.slice(0, 10).map(t => ({
      source: t.source,
      sessionId: t.sessionId,
      taskId: t.taskId,
      project: t.project,
      startedAt: t.records[0].timestamp,
      endedAt: t.records[t.records.length - 1].timestamp,
      tools: t.records.map(r => r.name),
      summaries: t.records.map(r => r.summary).filter(Boolean).slice(0, 3),
    }));
    candidates.push({
      id: `cand_${fingerprint({ key, toolName })}`,
      title: names.map(n => n.replace(/^sidekick_/, "")).join(" then "),
      proposedToolName: toolName,
      state: "candidate",
      description: `Repeated successful workflow: ${toolSignature(successes[0].records)}`,
      steps,
      parameters,
      evidence,
      evidenceCount: successes.length,
      totalObserved: traces.length,
      successRate,
      score,
      scoreBreakdown: {
        recurrence: successes.length,
        successRate,
        parameterCount: Object.keys(parameters).length,
        callsSavedPerUse: Math.max(steps.length - 1, 0),
        duplicatePenalty,
        riskPenalty,
      },
      duplicate: duplicateReasons.length > 0,
      duplicateReasons,
      risk: riskyTools.length ? "high" : "medium",
      createdAt: new Date().toISOString(),
    });
  }

  return candidates.sort((a, b) => b.score - a.score || b.evidenceCount - a.evidenceCount);
}

module.exports = {
  chronologicalLogs,
  segmentLogs,
  detectCandidates,
  buildParameterizedSteps,
};
