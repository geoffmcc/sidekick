"use strict";

const crypto = require("crypto");

const SCHEMA_VERSION = 2;
const PROFILES = Object.freeze({
  quick: Object.freeze({ wall_ms: 5 * 60_000, model_calls: 12, tool_calls: 24, plan_revisions: 6, failures: 4, retries: 2, idle_ms: 60_000 }),
  standard: Object.freeze({ wall_ms: 30 * 60_000, model_calls: 60, tool_calls: 120, plan_revisions: 20, failures: 8, retries: 3, idle_ms: 5 * 60_000 }),
  deep: Object.freeze({ wall_ms: 2 * 60 * 60_000, model_calls: 240, tool_calls: 500, plan_revisions: 60, failures: 16, retries: 5, idle_ms: 15 * 60_000 }),
  persistent: Object.freeze({ wall_ms: 8 * 60 * 60_000, model_calls: 600, tool_calls: 1500, plan_revisions: 120, failures: 24, retries: 7, idle_ms: 30 * 60_000 }),
  research: Object.freeze({ wall_ms: 4 * 60 * 60_000, model_calls: 400, tool_calls: 1000, plan_revisions: 100, failures: 20, retries: 6, idle_ms: 30 * 60_000 }),
});
const STATES = Object.freeze(["created", "planning", "ready", "running", "waiting", "paused", "blocked", "verifying", "completed", "partial", "failed", "cancelled", "timed_out", "interrupted"]);
const TERMINAL = new Set(["completed", "partial", "failed", "cancelled", "timed_out"]);
const TRANSITIONS = Object.freeze({
  created: ["planning", "paused", "cancelled", "failed"], planning: ["ready", "waiting", "blocked", "paused", "failed", "cancelled"],
  ready: ["running", "paused", "waiting", "cancelled", "failed"], running: ["planning", "waiting", "paused", "verifying", "blocked", "interrupted", "cancelled", "failed", "timed_out"],
  waiting: ["ready", "planning", "paused", "blocked", "cancelled", "failed", "timed_out"], paused: ["ready", "planning", "cancelled", "failed"], blocked: ["planning", "ready", "cancelled", "failed"],
  verifying: ["completed", "partial", "blocked", "failed", "planning"], interrupted: ["ready", "failed", "cancelled"],
  completed: [], partial: [], failed: [], cancelled: [], timed_out: [],
});

function boundedString(value, max, field) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new Error(`${field} must be 1-${max} characters`);
  return text;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function normalizeProfile(value) { const key = String(value || "standard").toLowerCase(); if (!PROFILES[key]) throw new Error("unsupported task profile"); return key; }
function normalizeWorkspaceRef(value) { if (value == null || value === "") return null; const ref = String(value).trim(); if (!/^(?:workspace|artifact|repository):[A-Za-z0-9_.:-]{1,120}$/.test(ref)) throw new Error("workspace_ref must be a governed reference"); return ref; }
function normalizeGoal(objective, input = {}) {
  const original = boundedString(objective, 20_000, "objective");
  const criteria = Array.isArray(input.success_criteria) ? input.success_criteria : [];
  const deliverables = Array.isArray(input.required_deliverables) ? input.required_deliverables : [];
  if (criteria.length > 50 || deliverables.length > 50) throw new Error("goal criteria are too numerous");
  const clean = list => list.map(x => boundedString(x, 500, "goal item"));
  const readOnly = input.read_only === true;
  return { version: 1, original_objective: original, normalized_objective: boundedString(input.normalized_objective || original, 20_000, "normalized_objective"), constraints: clean(input.constraints || []), required_deliverables: clean(deliverables), success_criteria: clean(criteria), prohibited_actions: clean(input.prohibited_actions || []), assumptions: clean(input.assumptions || []), verification_requirements: clean(input.verification_requirements || []), requires_live_evidence: input.requires_live_evidence === true, read_only: readOnly, changes_allowed: readOnly ? false : input.changes_allowed !== false, authority_boundary: boundedString(input.authority_boundary || "Use only the authenticated project and workspace scope", 1000, "authority_boundary"), stopping_conditions: clean(input.stopping_conditions || []) };
}
function createTask(input, now = new Date().toISOString()) {
  const taskId = boundedString(input.task_id || `agt_${crypto.randomBytes(10).toString("hex")}`, 80, "task_id");
  const goal = normalizeGoal(input.objective, input.goal || {});
  const profile = normalizeProfile(input.profile);
  const budget = { ...PROFILES[profile] };
  return { schema_version: SCHEMA_VERSION, task_id: taskId, root_task_id: input.root_task_id || taskId, parent_task_id: input.parent_task_id || null, session_id: input.session_id || null, execution_id: input.execution_id || null, project_id: input.project_id || null, actor_id: input.actor_id || "agent", requested_by_principal_id: input.requested_by_principal_id || null, actor_principal_id: input.actor_principal_id || null, acting_for_principal_id: input.acting_for_principal_id || null, objective: goal.original_objective, normalized_objective: goal.normalized_objective, goal, profile, state: "created", phase: "intake", current_plan_revision: 0, requirements: goal.success_criteria.map((criterion, index) => ({ id: `req_${index + 1}`, text: criterion, state: "pending", evidence: [] })), budget, usage: { model_calls: 0, tool_calls: 0, plan_revisions: 0, failures: 0, retries: 0, evidence_items: 0 }, workspace_ref: normalizeWorkspaceRef(input.workspace_ref), model_version: input.model_version || null, prompt_version: input.prompt_version || null, policy_version: input.policy_version || null, capability_registry_version: input.capability_registry_version || null, checkpoint: { version: 1, safe_boundary: "created", next_action: "normalize_goal", updated_at: now }, control: { pause_requested: false, cancel_requested: false }, continuation: { version: 1, completed_operations: [], ambiguous_operations: [] }, artifact_refs: [], next_action: "normalize_goal", result: null, verification: null, last_error_code: null, created_at: now, updated_at: now, completed_at: null };
}
function transition(task, next, now = new Date().toISOString()) { if (!STATES.includes(next)) throw new Error("unknown task state"); if (task.state !== next && !(TRANSITIONS[task.state] || []).includes(next)) throw new Error(`invalid task transition: ${task.state} -> ${next}`); const copy = clone(task); copy.state = next; copy.updated_at = now; if (TERMINAL.has(next)) copy.completed_at = now; return copy; }
function stableValue(value, depth = 0) {
  if (depth > 12) return "[depth-limit]";
  if (Array.isArray(value)) return value.map(item => stableValue(item, depth + 1));
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => { out[key] = stableValue(value[key], depth + 1); return out; }, {});
  if (typeof value === "string") return value.length > 5000 ? value.slice(0, 5000) : value;
  return value;
}
function actionFingerprint(capability, args) { return crypto.createHash("sha256").update(`${String(capability)}\0${JSON.stringify(stableValue(args || {}))}`).digest("hex"); }
function budgetExceeded(task, resource) { const limit = task.budget && task.budget[resource]; return Number.isFinite(limit) && Number(task.usage?.[resource] || 0) >= limit; }
function assertCheckpoint(task, checkpoint) { if (!checkpoint || checkpoint.version !== 1 || !checkpoint.safe_boundary || !checkpoint.next_action) throw new Error("invalid safe checkpoint"); if (TERMINAL.has(task.state)) throw new Error("terminal task cannot checkpoint"); return { ...clone(checkpoint), updated_at: new Date().toISOString() }; }
function validateResult(result) { if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("structured result must be an object"); const allowed = ["summary", "status", "claims", "findings", "recommendations", "deliverables", "artifacts", "evidence_refs", "verification", "proposed_actions", "unresolved_questions", "limitations", "follow_up_suggestions", "resource_usage", "provenance"]; const out = {}; for (const key of allowed) if (result[key] !== undefined) out[key] = clone(result[key]); if (out.summary !== undefined) out.summary = boundedString(out.summary, 20_000, "result summary"); if (out.status !== undefined && !["verified", "partially_verified", "incomplete", "contradicted", "unable_to_verify", "waiting_for_approval", "waiting_for_information", "budget_exhausted"].includes(out.status)) throw new Error("invalid result status"); return { version: 1, ...out }; }
module.exports = { SCHEMA_VERSION, PROFILES, STATES, TERMINAL, normalizeGoal, normalizeProfile, normalizeWorkspaceRef, createTask, transition, actionFingerprint, budgetExceeded, assertCheckpoint, validateResult };
