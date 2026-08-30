"use strict";

const crypto = require("crypto");
const { getToolAnnotations } = require("../tools/annotations");
const { getStaticToolRisk, TOOL_ACTION_RISK } = require("../tools/metadata");

const EFFECTS = Object.freeze(["read_only", "workspace_reversible", "build_test", "local_process", "external", "production", "destructive", "credential", "identity", "policy", "unknown"]);
const RISKS = Object.freeze(["low", "medium", "high", "critical"]);
const MAX = 40;
function cleanRef(value, label) { const s = String(value || "").trim(); if (!s) return null; if (!/^[A-Za-z0-9_.:/-]{1,160}$/.test(s)) throw new Error(`${label} must be a governed reference`); return s; }
function list(value, label) { if (value == null) return []; if (!Array.isArray(value) || value.length > MAX) throw new Error(`${label} must be a bounded list`); return [...new Set(value.map(v => cleanRef(v, label)).filter(Boolean))]; }
function createAuthorityEnvelope(input = {}) {
  const requestedProhibitions = list(input.prohibited_effects, "prohibited_effects").filter(x => EFFECTS.includes(x));
  return { version: 1, permitted_projects: list(input.permitted_projects, "permitted_projects"), permitted_workspaces: list(input.permitted_workspaces, "permitted_workspaces"), permitted_repositories: list(input.permitted_repositories, "permitted_repositories"), allowed_effects: list(input.allowed_effects || ["read_only"], "allowed_effects").filter(x => EFFECTS.includes(x)), prohibited_effects: [...new Set(requestedProhibitions)], capability_restrictions: list(input.capability_restrictions, "capability_restrictions"), environmental_scope: list(input.environmental_scope, "environmental_scope"), changes_allowed: input.changes_allowed === true, external_effects_allowed: input.external_effects_allowed === true, production_allowed: input.production_allowed === true, approval_threshold: RISKS.includes(input.approval_threshold) ? input.approval_threshold : "high", rollback_expectation: ["none","attempt_if_safe","required"].includes(input.rollback_expectation) ? input.rollback_expectation : "attempt_if_safe", child_task_depth: Math.max(0, Math.min(8, Number(input.child_task_depth ?? 4))), child_task_count: Math.max(0, Math.min(32, Number(input.child_task_count ?? 8))), concurrency_limit: Math.max(1, Math.min(16, Number(input.concurrency_limit) || 1)), expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null };
}
function intersectEnvelope(requested, principal = {}) {
  const r = createAuthorityEnvelope(requested); const p = createAuthorityEnvelope(principal);
  const intersect = (a,b) => a.length && b.length ? a.filter(x=>b.includes(x)) : (a.length ? a : b);
  const riskRank = { low: 0, medium: 1, high: 2, critical: 3 };
  const rollbackRank = { none: 0, attempt_if_safe: 1, required: 2 };
  const stricterRisk = riskRank[r.approval_threshold] <= riskRank[p.approval_threshold] ? r.approval_threshold : p.approval_threshold;
  const stricterRollback = rollbackRank[r.rollback_expectation] >= rollbackRank[p.rollback_expectation] ? r.rollback_expectation : p.rollback_expectation;
  return { ...r, permitted_projects: intersect(r.permitted_projects,p.permitted_projects), permitted_workspaces: intersect(r.permitted_workspaces,p.permitted_workspaces), permitted_repositories: intersect(r.permitted_repositories,p.permitted_repositories), allowed_effects: r.allowed_effects.filter(x=>p.allowed_effects.includes(x)), prohibited_effects: [...new Set([...r.prohibited_effects,...p.prohibited_effects])], capability_restrictions: intersect(r.capability_restrictions,p.capability_restrictions), environmental_scope: intersect(r.environmental_scope,p.environmental_scope), changes_allowed: r.changes_allowed && p.changes_allowed, external_effects_allowed: r.external_effects_allowed && p.external_effects_allowed, production_allowed: r.production_allowed && p.production_allowed, approval_threshold: stricterRisk, rollback_expectation: stricterRollback, child_task_depth: Math.min(r.child_task_depth,p.child_task_depth), child_task_count: Math.min(r.child_task_count,p.child_task_count), concurrency_limit: Math.min(r.concurrency_limit,p.concurrency_limit), expires_at: r.expires_at && p.expires_at ? new Date(Math.min(Date.parse(r.expires_at),Date.parse(p.expires_at))).toISOString() : (r.expires_at || p.expires_at) };
}
function determineEffect(descriptor, args = {}) {
  if (!descriptor || !descriptor.name) return { effect: "unknown", risk: "critical", authoritative: false };
  const name = String(descriptor.name).replace(/^sidekick_/i, ""); const ann = descriptor.annotations || getToolAnnotations(name); const action = typeof args.action === "string" ? args.action : null;
  const explicitEffect = [descriptor.effect_class, descriptor.effectClass, descriptor.effect, descriptor.metadata?.effect_class, descriptor.metadata?.effect, ann.effect_class, ann.effectClass].find(value => EFFECTS.includes(String(value || "")));
  const explicitRisk = [descriptor.risk_class, descriptor.riskClass, descriptor.metadata?.risk_class, descriptor.metadata?.risk, ann.risk_class, ann.riskClass].find(value => RISKS.includes(String(value || "")));
  const explicitIdempotent = [descriptor.idempotent, descriptor.idempotent_class === "idempotent" ? true : undefined, ann.idempotentHint].find(value => typeof value === "boolean");
  const explicitReversible = [descriptor.reversible, descriptor.reversibility_class === "reversible" ? true : undefined, ann.reversibleHint].find(value => typeof value === "boolean");
  if (explicitEffect) {
    const effectName = String(explicitEffect);
    if ((ann.destructiveHint === true || ann.openWorldHint === true) && ["read_only", "workspace_reversible", "build_test", "local_process"].includes(effectName)) return { effect: "unknown", risk: "critical", authoritative: false, idempotent: false, reversible: false };
    return { effect: effectName, risk: String(explicitRisk || descriptor.risk || getStaticToolRisk(name)), authoritative: true, idempotent: explicitIdempotent === undefined ? Boolean(ann.idempotentHint) : explicitIdempotent, reversible: explicitReversible === undefined ? !["external", "production", "destructive", "credential", "identity", "policy"].includes(effectName) : explicitReversible };
  }
  const actionRiskOverride = action && TOOL_ACTION_RISK[name] && Object.prototype.hasOwnProperty.call(TOOL_ACTION_RISK[name], action)
    ? TOOL_ACTION_RISK[name][action]
    : null;
  const actionRisk = actionRiskOverride || descriptor.risk || getStaticToolRisk(name);
  // Creating or selecting a local task branch is a reversible workspace
  // operation. Keep its structured risk distinct from the generic Git
  // descriptor risk so routine authorized workspace setup does not inherit a
  // critical approval threshold. Commit/push/pull retain their own stronger
  // policy paths.
  const branchPreparationRisk = name === "git" && ["branch", "checkout"].includes(action) ? "medium" : actionRisk;
  // Mixed-surface tools may be destructive at the tool level while exposing
  // explicitly allowlisted metadata-only actions (for example
  // project_registry(action=list)). TOOL_ACTION_RISK is maintained as a
  // fail-closed action allowlist, so a low-risk action can be classified as a
  // read without weakening any unlisted action.
  if (actionRiskOverride === "low" && ann.openWorldHint !== true) return { effect: "read_only", risk: actionRisk, authoritative: true, idempotent: true, reversible: true };
  if (ann.readOnlyHint === true && ann.destructiveHint !== true && ann.openWorldHint !== true) return { effect: "read_only", risk: actionRisk, authoritative: true, idempotent: true, reversible: true };
  if (name === "git" && ["commit", "merge", "checkout", "stash"].includes(action)) return { effect: "workspace_reversible", risk: action === "checkout" ? branchPreparationRisk : "critical", authoritative: true, idempotent: false, reversible: true };
  if (name === "git" && ["push", "pull"].includes(action)) return { effect: "external", risk: "critical", authoritative: true, idempotent: false, reversible: false };
  if (name === "git" && ["status","diff","log","show"].includes(action)) return { effect:"read_only", risk:actionRisk, authoritative:true, idempotent:true, reversible:true };
  if (ann.destructiveHint === true || ["delete","destroy","remove","retire","migrate"].includes(action)) return { effect: "destructive", risk: "critical", authoritative: true, idempotent: false, reversible: false };
  if (ann.openWorldHint === true) return { effect: "external", risk: actionRisk, authoritative: true, idempotent: ann.idempotentHint === true, reversible: false };
  return { effect: "unknown", risk: actionRisk, authoritative: false, idempotent: false, reversible: false };
}
function decideAutonomy({ descriptor, args, envelope, principalRef, projectRef, workspaceRef, repositoryRef, capabilityRef, environmentRef, policyVersion, descriptorVersion } = {}) { const rawClassification=determineEffect(descriptor,args); const scopedWorkspaceTarget=/^workspace:[A-Za-z0-9_.:/-]{1,240}$/.test(String(args?.path || args?.workspace_ref || "")) && String(args?.path || args?.workspace_ref) === String(workspaceRef || ""); const safeWorkspaceFallback=rawClassification.effect === "unknown" && rawClassification.authoritative === false && scopedWorkspaceTarget && descriptor?.annotations?.readOnlyHint === false && descriptor?.annotations?.destructiveHint !== true && descriptor?.annotations?.openWorldHint !== true ? { ...rawClassification, effect: "workspace_reversible", risk: RISKS.includes(descriptor?.risk) ? descriptor.risk : "medium", authoritative: true, idempotent: false, reversible: true } : rawClassification; const classification=safeWorkspaceFallback; const e=envelope || createAuthorityEnvelope(); const scopeAllowed=(list,ref)=>!list.length || (ref && list.includes(String(ref))); const targetAllowed=scopeAllowed(e.permitted_projects,projectRef)&&scopeAllowed(e.permitted_workspaces,workspaceRef)&&scopeAllowed(e.permitted_repositories,repositoryRef); const environment=String(environmentRef || process.env.SIDEKICK_ENVIRONMENT || "development").trim(); const environmentAllowed=!e.environmental_scope.length || e.environmental_scope.includes(environment); const capabilityAllowed=!e.capability_restrictions.length || e.capability_restrictions.includes(String(capabilityRef || descriptor?.name || "").replace(/^sidekick_/i,"")); const workspaceTargetAllowed=classification.effect !== "workspace_reversible" || !!workspaceRef; const expired=Boolean(e.expires_at && Date.parse(e.expires_at)<=Date.now()); const allowed=classification.authoritative && !expired && targetAllowed && environmentAllowed && capabilityAllowed && workspaceTargetAllowed && e.allowed_effects.includes(classification.effect) && !e.prohibited_effects.includes(classification.effect) && (classification.effect !== "external" || e.external_effects_allowed) && (classification.effect !== "production" || e.production_allowed) && (classification.effect === "read_only" || e.changes_allowed); const ranks={low:0,medium:1,high:2,critical:3}; const approvalRequired=allowed && classification.effect !== "read_only" && (ranks[classification.risk] >= ranks[e.approval_threshold] || ["external","production","destructive","credential","identity","policy","unknown"].includes(classification.effect)); return { decision: !allowed ? "deny" : approvalRequired ? "approval_required" : "proceed", reason: expired ? "authority envelope has expired" : !classification.authoritative ? "canonical effect metadata is missing" : !targetAllowed ? "target scope is outside the effective authority envelope" : !environmentAllowed ? "environment is outside the effective authority envelope" : !capabilityAllowed ? "capability is restricted by the effective authority envelope" : !workspaceTargetAllowed ? "workspace mutation requires a governed workspace target" : !allowed ? "effect is outside the effective authority envelope" : approvalRequired ? "risk or effect requires explicit approval" : "bounded authorized operation", policy_version: policyVersion || "agent-authority-v1", descriptor_version: descriptorVersion || descriptor?.version || "unknown", risk_class: classification.risk, effect_class: classification.effect, approval_required: approvalRequired, authority_envelope: e, principal_provenance: cleanRef(principalRef, "principal_ref") };
}
function canonicalDigestValue(value, depth = 0) {
  if (depth > 32) throw new Error("operation arguments are too deeply nested");
  if (Array.isArray(value)) return value.map(item => canonicalDigestValue(item, depth + 1));
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => { out[key] = canonicalDigestValue(value[key], depth + 1); return out; }, {});
  return value;
}
function argumentDigest(args) { return crypto.createHash("sha256").update(`agent-args-v1\0${JSON.stringify(canonicalDigestValue(args || {}))}`).digest("hex"); }
function governedTargetRef(args = {}, fallback = null) {
  const candidates = [args.target_ref, args.target, args.workspace_ref, args.repository_ref, args.project_ref, args.resource_ref, fallback];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (/^(?:workspace|repository|project|artifact|resource|service|job|operation):[A-Za-z0-9_.:/-]{1,240}$/.test(value)) return value;
  }
  return null;
}
module.exports={EFFECTS,RISKS,createAuthorityEnvelope,intersectEnvelope,determineEffect,decideAutonomy,argumentDigest,governedTargetRef};
