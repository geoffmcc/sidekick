"use strict";

const crypto = require("crypto");

const LIMITS = Object.freeze({
  MAX_GOAL_CHARS: 4000,
  MAX_ITEMS: 32,
  MAX_ITEM_CHARS: 1000,
  MAX_CONSTRAINTS: 32,
  MAX_DEPTH: 8,
});
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const AUTHORITY_KEYS = new Set([
  "approved", "approval", "approval_id", "authorized", "bypass", "capability_symbol",
  "provenance", "risk", "source", "trust", "trust_level", "verified",
]);
const SPEC_KEYS = new Set([
  "version", "task_id", "original_objective", "normalized_objective", "goal",
  "deliverables", "requirements", "success_criteria", "constraints", "preferences",
  "prohibited_actions", "assumptions", "ambiguities", "clarifications",
  "evidence_requirements", "required_evidence", "verification_requirements",
  "dependencies", "authority_boundary", "requires_live_evidence", "read_only",
  "changes_allowed", "stopping_conditions", "preferred_profile",
]);

function stableId(value, prefix = "task") {
  const digest = crypto.createHash("sha256").update(canonical(value)).digest("hex").slice(0, 24);
  return `${String(prefix).replace(/[^a-z0-9_-]/gi, "_").slice(0, 24) || "task"}_${digest}`;
}

function canonical(value, depth = 0) {
  if (depth > LIMITS.MAX_DEPTH) throw new Error("value exceeds maximum depth");
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasForbidden(value, depth = 0) {
  if (depth > LIMITS.MAX_DEPTH) return "depth_exceeded";
  if (Array.isArray(value)) {
    for (const item of value) { const found = hasForbidden(item, depth + 1); if (found) return found; }
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return "forbidden_key";
      if (AUTHORITY_KEYS.has(key)) return "authority_key_not_permitted";
      const found = hasForbidden(value[key], depth + 1); if (found) return found;
    }
  }
  return null;
}

function cleanText(value, field, max = LIMITS.MAX_ITEM_CHARS) {
  if (typeof value !== "string") return { error: `${field}_not_string` };
  const text = value.trim();
  if (!text) return { error: `${field}_empty` };
  if (text.length > max) return { error: `${field}_too_large` };
  // These markers are not useful task content and commonly indicate an attempt
  // to turn untrusted input into a control message.
  if (/(?:^|\n)\s*(?:system|assistant|developer|tool)\s*:/i.test(text) ||
      /ignore\s+(?:all|any|the)\s+(?:previous|prior|above)\s+instructions/i.test(text)) {
    return { error: `${field}_injection_marker` };
  }
  return { value: text };
}

function list(value, field, max = LIMITS.MAX_ITEMS) {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value)) return { error: `${field}_not_array` };
  if (value.length > max) return { error: `${field}_too_many` };
  const out = [];
  for (const item of value) {
    const clean = cleanText(item, field);
    if (clean.error) return clean;
    if (!out.includes(clean.value)) out.push(clean.value);
  }
  return { value: out };
}

function records(value, field, max = LIMITS.MAX_ITEMS) {
  const result = list(value, field, max);
  if (result.error) return result;
  return { value: result.value.map((text, index) => ({ id: `${field.slice(0, 3)}_${index + 1}`, text })) };
}

function normalizeTaskSpec(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["spec_not_object"] };
  const violation = hasForbidden(input);
  if (violation) return { ok: false, errors: [violation] };
  const original = cleanText(input.original_objective ?? input.goal ?? input.objective, "original_objective", LIMITS.MAX_GOAL_CHARS);
  const normalized = cleanText(input.normalized_objective ?? original.value, "normalized_objective", LIMITS.MAX_GOAL_CHARS);
  if (original.error) return { ok: false, errors: [original.error] };
  if (normalized.error) return { ok: false, errors: [normalized.error] };
  const fields = ["deliverables", "requirements", "success_criteria", "constraints", "preferences", "prohibited_actions", "assumptions", "ambiguities", "clarifications", "evidence_requirements", "verification_requirements", "dependencies", "stopping_conditions"];
  const values = {};
  for (const field of fields) {
    const source = field === "deliverables" && input[field] === undefined ? input.required_deliverables
      : field === "requirements" && input[field] === undefined ? input.success_criteria
      : field === "evidence_requirements" && input[field] === undefined ? input.required_evidence
        : input[field];
    const result = ["deliverables", "requirements"].includes(field)
      ? records(source, field, field === "constraints" ? LIMITS.MAX_CONSTRAINTS : LIMITS.MAX_ITEMS)
      : list(source, field, field === "constraints" ? LIMITS.MAX_CONSTRAINTS : LIMITS.MAX_ITEMS);
    if (result.error) return { ok: false, errors: [result.error] };
    values[field] = result.value;
  }
  const profile = input.preferred_profile === undefined ? "standard" : String(input.preferred_profile).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(profile)) return { ok: false, errors: ["preferred_profile_invalid"] };
  const taskId = input.task_id === undefined ? stableId({ goal: normalized.value, ...values }, "task") : String(input.task_id).trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) return { ok: false, errors: ["task_id_invalid"] };
  const authority = input.authority_boundary === undefined ? "Use only the authenticated project and workspace scope" : input.authority_boundary;
  const authorityResult = cleanText(authority, "authority_boundary", 1000);
  if (authorityResult.error) return { ok: false, errors: [authorityResult.error] };
  const liveEvidence = input.requires_live_evidence === true || values.evidence_requirements.length > 0;
  const readOnly = input.read_only === true;
  const spec = {
    version: 3, task_id: taskId, original_objective: original.value,
    normalized_objective: normalized.value, goal: normalized.value,
    ...values, required_evidence: values.evidence_requirements,
    authority_boundary: authorityResult.value, requires_live_evidence: liveEvidence,
    read_only: readOnly, changes_allowed: readOnly ? false : input.changes_allowed !== false,
    preferred_profile: profile,
  };
  return { ok: true, spec, stripped: Object.keys(input).filter(key => !SPEC_KEYS.has(key)).slice(0, LIMITS.MAX_ITEMS).map(key => String(key).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)) };
}

function validateTaskSpec(input) {
  const result = normalizeTaskSpec(input);
  if (!result.ok) return result;
  const errors = [];
  const expected = stableId({
    goal: result.spec.normalized_objective,
    deliverables: result.spec.deliverables,
    requirements: result.spec.requirements,
    success_criteria: result.spec.success_criteria,
    constraints: result.spec.constraints,
    preferences: result.spec.preferences,
    prohibited_actions: result.spec.prohibited_actions,
    assumptions: result.spec.assumptions,
    ambiguities: result.spec.ambiguities,
    clarifications: result.spec.clarifications,
    evidence_requirements: result.spec.evidence_requirements,
    verification_requirements: result.spec.verification_requirements,
    dependencies: result.spec.dependencies,
    stopping_conditions: result.spec.stopping_conditions,
  }, "task");
  if (input && input.task_id === undefined && result.spec.task_id !== expected) errors.push("unstable_task_id");
  return errors.length ? { ok: false, errors } : { ok: true, spec: result.spec, stripped: result.stripped };
}

function detectConflicts(spec) {
  const input = spec && typeof spec === "object" ? spec : {};
  const conflicts = [];
  const constraints = new Set((input.constraints || []).map(String).map(value => value.toLowerCase()));
  for (const criterion of input.success_criteria || []) {
    const lower = String(criterion).toLowerCase();
    for (const constraint of constraints) {
      if (constraint && (lower.includes(constraint) || constraint.includes(lower))) conflicts.push({ type: "criterion_constraint", criterion, constraint });
    }
  }
  return conflicts.filter((item, index, all) => all.findIndex(other => canonical(other) === canonical(item)) === index);
}

function compileTaskSpec(input, options = {}) {
  const normalized = validateTaskSpec(input);
  if (!normalized.ok) {
    const fallbackGoal = typeof options.fallbackGoal === "string" && options.fallbackGoal.trim() ? options.fallbackGoal.trim().slice(0, LIMITS.MAX_GOAL_CHARS) : "Unable to safely compile task specification";
    const fallback = normalizeTaskSpec({ goal: fallbackGoal, stopping_conditions: ["require explicit validated task specification"] });
    return { ok: false, fallback: fallback.spec, errors: normalized.errors, conflicts: [] };
  }
  const conflicts = detectConflicts(normalized.spec);
  if (conflicts.length) return { ok: false, fallback: normalized.spec, errors: ["conflicting_requirements"], conflicts };
  return { ok: true, spec: normalized.spec, conflicts: [] };
}

module.exports = { LIMITS, stableId, normalizeTaskSpec, validateTaskSpec, detectConflicts, compileTaskSpec };
