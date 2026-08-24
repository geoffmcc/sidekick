"use strict";

/**
 * Deterministic, bounded model-facing evidence projection.
 *
 * Authoritative dispatcher results stay outside this module. Callers provide
 * already-redacted text and use the returned projection only for model
 * attention. Object siblings receive separate budgets so serialized property
 * order cannot starve later evidence. Arrays retain their source order.
 */

const EVIDENCE_BUDGETS = Object.freeze({
  MAX_TOOL_CHARS: 4000,
  MAX_TOTAL_CHARS: 16000,
  MAX_CONTEXT_CHARS: 18000,
  MAX_CONTEXT_ENTRY_CHARS: 1800,
  MAX_DEPTH: 4,
  MAX_OBJECT_KEYS: 32,
  MAX_ARRAY_ITEMS: 8,
  MAX_VALUE_CHARS: 700,
});

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function parseJsonText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function omission(message) { return `[${message}]`; }

function projectText(value, max = EVIDENCE_BUDGETS.MAX_VALUE_CHARS) {
  const text = asText(value);
  const limit = Math.max(32, Math.floor(Number(max) || EVIDENCE_BUDGETS.MAX_VALUE_CHARS));
  if (text.length <= limit) return text;
  const marker = `\n…${omission(`${text.length - limit} characters omitted`)}…\n`;
  const room = Math.max(2, limit - marker.length);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : "");
}

function keyOrder(keys, isError) {
  if (!isError) return keys;
  // Error fields are generic protocol vocabulary, not tool-specific behavior.
  const preferred = ["error", "code", "type", "message", "reason", "detail", "details", "warnings"];
  const rank = new Map(preferred.map((key, index) => [key, index]));
  return keys.slice().sort((a, b) => (rank.get(a) ?? preferred.length) - (rank.get(b) ?? preferred.length));
}

function projectValue(value, options, state, depth = 0) {
  const budget = Math.max(64, Math.floor(Number(options.budget) || EVIDENCE_BUDGETS.MAX_VALUE_CHARS));
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function" || typeof value === "symbol") return omission("unsupported value omitted");
  if (typeof value === "string") {
    const parsed = options.parseJsonStrings === false ? null : parseJsonText(value);
    if (parsed !== null && depth < options.maxDepth) return projectValue(parsed, options, state, depth + 1);
    return projectText(value, Math.min(budget, options.maxValueChars));
  }
  if (depth >= options.maxDepth) return omission("maximum depth reached");
  if (state.seen.has(value)) return omission("circular reference omitted");
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const count = Math.min(value.length, options.maxArrayItems);
      const itemBudget = Math.max(64, Math.floor((budget - 48) / Math.max(1, count)));
      const out = [];
      for (let i = 0; i < count; i++) out.push(projectValue(value[i], { ...options, budget: itemBudget }, state, depth + 1));
      if (value.length > count) out.push(omission(`${value.length - count} additional array items omitted`));
      return out;
    }
    const keys = keyOrder(Object.keys(value), options.isError);
    const count = Math.min(keys.length, options.maxObjectKeys);
    const childBudget = Math.max(64, Math.floor((budget - 48) / Math.max(1, count)));
    const out = {};
    for (let i = 0; i < count; i++) {
      const key = keys[i];
      let child;
      try { child = value[key]; } catch { child = omission("unreadable value omitted"); }
      out[key] = projectValue(child, { ...options, budget: childBudget }, state, depth + 1);
    }
    if (keys.length > count) out["[omitted]"] = omission(`${keys.length - count} additional object keys omitted`);
    return out;
  } finally {
    state.seen.delete(value);
  }
}

function render(value) {
  if (typeof value === "string") return value;
  // Compact rendering leaves the structural budget for sibling values rather
  // than spending it on indentation that has no evidentiary value.
  try { return JSON.stringify(value); } catch { return String(value); }
}

function projectToolEvidence({ tool, id = null, text, isError = false, redact = value => value }, options = {}) {
  const budgets = { ...EVIDENCE_BUDGETS, ...options };
  const redacted = redact(asText(text));
  const parsed = parseJsonText(redacted);
  const projected = parsed === null
    ? projectText(redacted, budgets.budget || budgets.MAX_TOOL_CHARS)
    : render(projectValue(parsed, {
      budget: budgets.budget || budgets.MAX_TOOL_CHARS,
      maxDepth: budgets.maxDepth || budgets.MAX_DEPTH,
      maxObjectKeys: budgets.maxObjectKeys || budgets.MAX_OBJECT_KEYS,
      maxArrayItems: budgets.maxArrayItems || budgets.MAX_ARRAY_ITEMS,
      maxValueChars: budgets.maxValueChars || budgets.MAX_VALUE_CHARS,
      isError,
    }, { seen: new WeakSet() }));
  const label = `## ${String(tool || "tool")}${id ? ` (${String(id)})` : ""}`;
  const status = isError ? "\nStatus: error\n" : "\nStatus: success\n";
  const output = projectText(label + status + projected, budgets.budget || budgets.MAX_TOOL_CHARS);
  return output;
}

function projectEvidenceItems(items, { totalChars = EVIDENCE_BUDGETS.MAX_TOTAL_CHARS, perToolChars = EVIDENCE_BUDGETS.MAX_TOOL_CHARS } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { text: "(no tool evidence was collected)", items: [], diagnostics: { itemCount: 0, represented: 0, omitted: 0, chars: 0 } };
  const total = Math.max(256, Math.floor(Number(totalChars) || EVIDENCE_BUDGETS.MAX_TOTAL_CHARS));
  const slot = Math.max(64, Math.floor((total - (list.length - 1) * 2) / list.length));
  const perItem = Math.max(64, Math.min(Math.floor(Number(perToolChars) || EVIDENCE_BUDGETS.MAX_TOOL_CHARS), slot));
  const parts = list.map(item => projectToolEvidence({ ...item }, { budget: perItem }));
  let text = parts.join("\n\n");
  const projectedItems = parts.map((part, index) => ({ ...list[index], text: part, projection_truncated: /\[\d+ characters omitted\]/.test(part) || /additional (?:array items|object keys) omitted/.test(part) }));
  const omitted = projectedItems.filter(item => item.projection_truncated).length;
  return { text, items: projectedItems, diagnostics: { itemCount: list.length, represented: projectedItems.length, omitted, chars: text.length, perItem, complete: omitted === 0 } };
}

function projectContextEntries(entries, { totalChars = EVIDENCE_BUDGETS.MAX_CONTEXT_CHARS, perEntryChars = 1800, redact = value => value } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return { text: "", diagnostics: { itemCount: 0, represented: 0, omitted: 0, chars: 0 } };
  const total = Math.max(512, Math.floor(Number(totalChars) || EVIDENCE_BUDGETS.MAX_CONTEXT_CHARS));
  const slot = Math.max(64, Math.floor((total - (list.length - 1) * 2) / list.length));
  const perItem = Math.max(64, Math.min(Math.floor(Number(perEntryChars) || 1800), slot));
  const parts = list.map(entry => {
    const summary = projectText(redact(entry.summary || ""), Math.floor(perItem * 0.25));
    const content = projectText(redact(entry.content || ""), Math.floor(perItem * 0.65));
    const provenance = entry.provenance && entry.provenance.trust ? `\nTrust: ${projectText(entry.provenance.trust, 120)}` : "";
    const source = `[${entry.source || "context"}/${entry.type || "entry"}]`;
    return `${source}${entry.sourceId != null ? ` (${String(entry.sourceId)})` : ""}${provenance}\nSummary: ${summary || "(none)"}\nContent: ${content || "(none)"}`;
  });
  const text = parts.map(part => projectText(part, perItem)).join("\n\n");
  const omitted = parts.filter(part => /characters omitted|additional .* omitted|maximum depth reached/.test(part)).length;
  return { text, diagnostics: { itemCount: list.length, represented: list.length, omitted, chars: text.length, perItem, complete: omitted === 0 } };
}

function estimateTokens(text) { return Math.ceil(asText(text).length / 4); }

module.exports = { EVIDENCE_BUDGETS, estimateTokens, projectText, projectValue, projectToolEvidence, projectEvidenceItems, projectContextEntries };
