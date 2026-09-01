"use strict";

const LIMITS = Object.freeze({ MAX_EVENTS: 256, MAX_EVENT_CHARS: 2000, MAX_FIELD_CHARS: 500, MAX_METRIC_KEYS: 64 });
const SECRET_PATTERNS = [/(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, /\bsk-[A-Za-z0-9_-]+\b/g, /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi];
const AUTHORITY_KEYS = new Set(["approved", "approval_id", "authorized", "bypass", "provenance", "risk", "trust", "trust_level"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function redact(value, depth = 0) {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (Array.isArray(value)) return value.slice(0, 32).map(item => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).slice(0, LIMITS.MAX_METRIC_KEYS)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
      out[safeKey] = AUTHORITY_KEYS.has(key) ? "[REDACTED_AUTHORITY]" : redact(value[key], depth + 1);
    }
    return out;
  }
  let text = String(value ?? "").slice(0, LIMITS.MAX_FIELD_CHARS);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, match => /^(?:sk-|Bearer\s|Basic\s)/i.test(match) ? "[REDACTED]" : match.replace(/(:|=)\s*[^\s,;]+$/, "$1[REDACTED]"));
  return text;
}

function createTrace(input = {}) { return { version: 3, trace_id: String(input.trace_id || `trace_${Date.now().toString(36)}`), task_id: input.task_id ? String(input.task_id).slice(0, 80) : null, events: [], metrics: {} }; }
function addEvent(trace, input = {}) {
  if (!trace || trace.events.length >= LIMITS.MAX_EVENTS) throw new Error("cognitive trace bound exceeded");
  const event = { sequence: trace.events.length + 1, type: String(input.type || "event").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80), at: input.at || null, data: redact(input.data || {}) };
  if (JSON.stringify(event).length > LIMITS.MAX_EVENT_CHARS) event.data = { truncated: true };
  const out = { ...trace, events: trace.events.concat(event), metrics: { ...trace.metrics } };
  return out;
}
function aggregateMetrics(trace) {
  const metrics = {};
  for (const event of trace && trace.events || []) {
    metrics.events = (metrics.events || 0) + 1;
    metrics[`event.${event.type}`] = (metrics[`event.${event.type}`] || 0) + 1;
    const data = event.data || {};
    for (const key of ["duration_ms", "tokens", "tool_calls", "revisions"]) if (Number.isFinite(Number(data[key]))) metrics[key] = (metrics[key] || 0) + Number(data[key]);
  }
  return Object.fromEntries(Object.entries(metrics).slice(0, LIMITS.MAX_METRIC_KEYS));
}
function finalizeTrace(trace) { return { ...trace, metrics: aggregateMetrics(trace) }; }

module.exports = { LIMITS, redact, createTrace, addEvent, aggregateMetrics, finalizeTrace };
