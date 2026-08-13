"use strict";

/**
 * Deterministic comparison and validation.
 *
 * Comparing two observations, two status codes, two hashes or two versions is
 * exactly the kind of work that must be decided by code, never by a model.
 * These functions are pure and structured — a model may later INTERPRET a
 * comparison, but the comparison itself is mechanical and reproducible.
 */

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i += 1) {
      if (ak[i] !== bk[i]) return false;
      if (!deepEqual(a[ak[i]], b[bk[i]])) return false;
    }
    return true;
  }
  return false;
}

function lineDelta(baselineText, candidateText) {
  const baseLines = String(baselineText == null ? "" : baselineText).split(/\r?\n/);
  const candLines = String(candidateText == null ? "" : candidateText).split(/\r?\n/);
  const baseSet = new Map();
  for (const line of baseLines) baseSet.set(line, (baseSet.get(line) || 0) + 1);
  const candSet = new Map();
  for (const line of candLines) candSet.set(line, (candSet.get(line) || 0) + 1);
  let added = 0;
  let removed = 0;
  for (const [line, count] of candSet) added += Math.max(0, count - (baseSet.get(line) || 0));
  for (const [line, count] of baseSet) removed += Math.max(0, count - (candSet.get(line) || 0));
  return { baseline_lines: baseLines.length, candidate_lines: candLines.length, added, removed };
}

function changedKeyPaths(a, b, prefix = "", out = [], depth = 0) {
  if (depth > 8 || out.length > 200) return out;
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    const av = a ? a[key] : undefined;
    const bv = b ? b[key] : undefined;
    if (av && bv && typeof av === "object" && typeof bv === "object") {
      changedKeyPaths(av, bv, pathKey, out, depth + 1);
    } else if (!deepEqual(av, bv)) {
      out.push(pathKey);
    }
  }
  return out;
}

/**
 * Compare a baseline value with a candidate value under a comparison mode.
 * Modes: status | hash | text | json | auto.
 */
function compareValues(baseline, candidate, mode = "auto") {
  let resolvedMode = mode;
  if (mode === "auto") {
    if (typeof baseline === "object" || typeof candidate === "object") resolvedMode = "json";
    else if (typeof baseline === "string" && /\n/.test(baseline)) resolvedMode = "text";
    else resolvedMode = "status";
  }

  if (resolvedMode === "status") {
    const changed = String(baseline) !== String(candidate);
    return { mode: "status", baseline, candidate, changed };
  }
  if (resolvedMode === "hash") {
    const norm = (v) => String(v || "").replace(/^sha256:/i, "").toLowerCase();
    const changed = norm(baseline) !== norm(candidate);
    return { mode: "hash", baseline, candidate, changed };
  }
  if (resolvedMode === "text") {
    const delta = lineDelta(baseline, candidate);
    return { mode: "text", changed: delta.added > 0 || delta.removed > 0, details: delta };
  }
  // json
  const changed = !deepEqual(baseline, candidate);
  return { mode: "json", changed, details: { changed_paths: changedKeyPaths(baseline, candidate) } };
}

/**
 * Validate an observation against an expectation. Returns a structured verdict.
 * `matched` is deterministic; interpretation of what a mismatch MEANS is left
 * to a human or a model, not decided here.
 */
function validateExpectation(expected, observed, mode = "auto") {
  const comparison = compareValues(expected, observed, mode);
  return {
    matched: comparison.changed === false,
    changed: comparison.changed,
    mode: comparison.mode,
    expected,
    observed,
    details: comparison.details || null,
  };
}

module.exports = { deepEqual, compareValues, validateExpectation, lineDelta };
