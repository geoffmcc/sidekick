"use strict";

/**
 * Thin, mechanical wrappers over the platform kernel's already-existing
 * security-research record layer (campaigns, hypotheses, scope snapshots,
 * findings, reports). This pack does NOT own the schema, the state machines, or
 * the fail-closed invariants — the kernel does. These wrappers only shape input
 * and translate the kernel's plain Errors into the pack's stable taxonomy so a
 * caller can tell "not found" from "illegal transition" from "bad input".
 */

const { kernel } = require("./platform");
const { ResearchError } = require("./errors");
const { requireText } = require("./identity");

// Translate a kernel invariant Error into a ResearchError with a stable code.
function mapKernelError(error) {
  if (error instanceof ResearchError) return error;
  const message = error && error.message ? String(error.message) : "kernel error";
  if (/must reference an existing|must belong to|not found|missing (campaign|hypothesis|test run|report)/i.test(message)) {
    return new ResearchError("not_found", message);
  }
  if (/Invalid .* transition|requires .*(evidence|execution_id|approval_ref|test run)/i.test(message)) {
    return new ResearchError("state_conflict", message);
  }
  return new ResearchError("invalid_input", message);
}

function callKernel(fn) {
  try {
    return fn();
  } catch (error) {
    throw mapKernelError(error);
  }
}

// --- campaigns (the durable project/campaign record) ------------------------

function createCampaign(input, actor) {
  const k = kernel();
  return callKernel(() => k.createResearchCampaign({
    project_id: requireText(input.project_id, "project_id"),
    name: requireText(input.name, "name"),
    created_by: actor,
    state: input.state,
    scope_snapshot_id: input.scope_snapshot_id || undefined,
    metadata: input.metadata || {},
    source: "security-research",
  }));
}
function getCampaign(campaignId) {
  const campaign = kernel().getResearchCampaign(requireText(campaignId, "campaign_id"));
  if (!campaign) throw new ResearchError("not_found", `campaign not found: ${campaignId}`);
  return campaign;
}
function listCampaigns(query) {
  return kernel().listResearchCampaigns(query || {});
}
function transitionCampaign(campaignId, state, actor, reason) {
  return callKernel(() => kernel().transitionResearchCampaign(requireText(campaignId, "campaign_id"), requireText(state, "state"), { actor_id: actor, source: "security-research", reason }));
}

// --- hypotheses -------------------------------------------------------------

function createHypothesis(input, actor) {
  return callKernel(() => kernel().createResearchHypothesis({
    campaign_id: requireText(input.campaign_id, "campaign_id"),
    title: requireText(input.title, "title"),
    claim: requireText(input.claim, "claim"),
    created_by: actor,
    state: input.state,
    rationale: input.rationale,
    prerequisites: input.prerequisites,
    criteria: input.criteria,
    confidence: input.confidence,
    metadata: input.metadata || {},
    source: "security-research",
  }));
}
function getHypothesis(hypothesisId) {
  const h = kernel().getResearchHypothesis(requireText(hypothesisId, "hypothesis_id"));
  if (!h) throw new ResearchError("not_found", `hypothesis not found: ${hypothesisId}`);
  return h;
}
function listHypotheses(query) {
  return kernel().listResearchHypotheses(query || {});
}
function transitionHypothesis(hypothesisId, state, actor, reason) {
  return callKernel(() => kernel().transitionResearchHypothesis(requireText(hypothesisId, "hypothesis_id"), requireText(state, "state"), { actor_id: actor, source: "security-research", reason }));
}

// --- scope snapshots (authorization surface) --------------------------------

function createScopeSnapshot(input, actor) {
  return callKernel(() => kernel().createScopeSnapshot({
    project_id: requireText(input.project_id, "project_id"),
    created_by: actor,
    targets: Array.isArray(input.targets) ? input.targets : [],
    rules: input.rules && typeof input.rules === "object" ? input.rules : { allowed_operations: [] },
    expires_at: input.expires_at || undefined,
    supersedes_snapshot_id: input.supersedes_snapshot_id || undefined,
    metadata: input.metadata || {},
  }));
}
function getScopeSnapshot(snapshotId) {
  const snap = kernel().getScopeSnapshot(requireText(snapshotId, "snapshot_id"));
  if (!snap) throw new ResearchError("not_found", `scope snapshot not found: ${snapshotId}`);
  return snap;
}
function listScopeSnapshots(query) {
  return kernel().listScopeSnapshots(query || {});
}
function evaluateScope(snapshotId, target) {
  return kernel().evaluateScope(requireText(snapshotId, "snapshot_id"), target);
}

// --- findings ---------------------------------------------------------------

function createFinding(input, actor) {
  return callKernel(() => kernel().createResearchFinding({
    campaign_id: requireText(input.campaign_id, "campaign_id"),
    title: requireText(input.title, "title"),
    claim: requireText(input.claim, "claim"),
    created_by: actor,
    status: input.status,
    hypothesis_id: input.hypothesis_id || undefined,
    test_run_id: input.test_run_id || undefined,
    impact: input.impact,
    evidence_refs: input.evidence_refs,
    metadata: input.metadata || {},
    source: "security-research",
  }));
}
function listFindings(query) {
  return kernel().listResearchFindings(query || {});
}

// --- reports ----------------------------------------------------------------

function createReport(input, actor) {
  return callKernel(() => kernel().createResearchReport({
    campaign_id: requireText(input.campaign_id, "campaign_id"),
    title: requireText(input.title, "title"),
    created_by: actor,
    status: input.status,
    finding_refs: input.finding_refs,
    artifact_id: input.artifact_id || undefined,
    metadata: input.metadata || {},
    source: "security-research",
  }));
}
function getReport(reportId) {
  const r = kernel().getResearchReport(requireText(reportId, "report_id"));
  if (!r) throw new ResearchError("not_found", `report not found: ${reportId}`);
  return r;
}
function listReports(query) {
  return kernel().listResearchReports(query || {});
}

module.exports = {
  mapKernelError,
  createCampaign, getCampaign, listCampaigns, transitionCampaign,
  createHypothesis, getHypothesis, listHypotheses, transitionHypothesis,
  createScopeSnapshot, getScopeSnapshot, listScopeSnapshots, evaluateScope,
  createFinding, listFindings,
  createReport, getReport, listReports,
};
