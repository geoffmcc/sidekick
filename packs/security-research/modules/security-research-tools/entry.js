"use strict";

/**
 * security-research-tools module — the runtime of the Security Research
 * capability pack.
 *
 * It exposes the platform kernel's already-existing research record layer
 * (campaigns, hypotheses, runs, findings, reports; migrations 032-035) as a
 * governed tool surface, and adds the pieces the kernel deliberately does not
 * own: the external-workspace filesystem boundary, evidence file storage with
 * integrity and redaction, bounded probe execution, deterministic comparison
 * and validation, and report material.
 *
 * Everything that executes a command goes through the `bash` tool, everything
 * that makes an HTTP request goes through `web_fetch`, everything that touches
 * infrastructure goes through the Proxmox pack — all via the module services
 * facade, so the pack inherits Sidekick's policy, approval, timeout, redaction
 * and audit path instead of reimplementing any of it. The pack has no special
 * privilege: it cannot bypass provider policy, and it does not become an
 * unrestricted shell.
 *
 * Deterministic by design: hashing, comparison, scope checks, state tracking
 * and evidence association are all decided by code. A model may help formulate
 * hypotheses or interpret results, but the state machine, execution, evidence
 * and audit work with no model at all.
 */

const { requireFromSidekick, requireSidekickSrc } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const { normalizeEvidenceMetadata } = requireSidekickSrc("src/evidence/classes");
const { canonicalizeProjectName } = requireSidekickSrc("src/core/project-identity.js");

const { jsonResult, ok, errorResult } = require("./lib/results");
const { resolveActor } = require("./lib/identity");
const { ResearchError } = require("./lib/errors");
const workspace = require("./lib/workspace");
const records = require("./lib/records");
const runsLib = require("./lib/runs");
const evidenceLib = require("./lib/evidence");
const probesLib = require("./lib/probes");
const labLib = require("./lib/lab");
const compareLib = require("./lib/compare");
const reportLib = require("./lib/report");
const discovery = require("./lib/discovery");
const sourceLib = require("./lib/source");

// Resolve the workspace once for a handler that needs filesystem access.
function requireWorkspace(services) {
  return workspace.resolveWorkspace(services.config || {}, { requireExists: false }).root;
}

// Build the context a run-scoped operation (probe, evidence capture, report)
// needs: the workspace, the run, and the derived ids.
function runContext(services, runId, runtime) {
  const root = requireWorkspace(services);
  const config = services.config || {};
  const run = runsLib.get(runId);
  const boundNetworkScope = run.metadata && run.metadata.network_scope;
  if (boundNetworkScope) {
    const currentScope = require("../../../../../src/security/network-scopes").get(boundNetworkScope.scope_id, boundNetworkScope.revision);
    if (!currentScope || !currentScope.enabled || !currentScope.is_current || currentScope.digest !== boundNetworkScope.digest) {
      throw new ResearchError("scope_stale", "the bound named network scope is disabled, expired, or has changed; rebind the run explicitly");
    }
    boundNetworkScope.policy = currentScope;
  }
  return {
    root,
    config,
    run,
    campaignId: run.campaign_id,
    runId: run.run_id,
    projectId: run.project_id,
    executionId: run.execution_id,
    scopeSnapshotId: run.scope_snapshot_id || null,
    networkScope: boundNetworkScope || null,
    environment: run.environment || null,
    actor: resolveActor({}, runtime),
    timeoutMs: config.probe_timeout_ms || 60000,
    maxBytes: config.max_evidence_bytes || 5242880,
  };
}

function projectScope(args, runtime, run = null) {
  const runtimeProject = runtime && runtime.context && runtime.context.project;
  const runProject = run && (run.project_id || run.projectId);
  const projectId = runtimeProject || runProject || args.project_id;
  if (!projectId) throw new ResearchError("invalid_input", "project scope is required for evidence access");
  if (runtimeProject && args.project_id && String(runtimeProject) !== String(args.project_id)) {
    throw new ResearchError("not_found", "evidence not found");
  }
  return String(projectId);
}

// --- research_status --------------------------------------------------------

function handleStatus(services) {
  return jsonResult(discovery.status(services.config || {}));
}

// --- research_project (campaign) -------------------------------------------

function handleProject(services, args, runtime) {
  const actor = resolveActor(args, runtime);
  switch (args.action) {
    case "create":
      return ok({ campaign: records.createCampaign(args, actor) });
    case "get": {
      const campaign = records.getCampaign(args.campaign_id);
      if (args.project_id && canonicalizeProjectName(args.project_id) !== canonicalizeProjectName(campaign.project_id)) throw new ResearchError("not_found", "campaign not found");
      const hypotheses = records.listHypotheses({ campaign_id: campaign.campaign_id, limit: 100 });
      const runs = runsLib.list({ campaign_id: campaign.campaign_id, limit: 100 });
      return ok({ campaign, hypotheses_count: hypotheses.length, runs_count: runs.length, hypotheses, runs });
    }
    case "list":
      return ok({ campaigns: records.listCampaigns({ project_id: args.project_id, state: args.state, limit: args.limit }) });
    case "transition":
      return ok({ campaign: records.transitionCampaign(args.campaign_id, args.state, actor, args.reason) });
    default:
      return errorResult(new ResearchError("invalid_input", `unknown action: ${args.action}`));
  }
}

// --- research_hypothesis ----------------------------------------------------

function handleHypothesis(services, args, runtime) {
  const actor = resolveActor(args, runtime);
  switch (args.action) {
    case "create":
      return ok({ hypothesis: records.createHypothesis(args, actor) });
    case "get":
      return ok({ hypothesis: records.getHypothesis(args.hypothesis_id) });
    case "list":
      return ok({ hypotheses: records.listHypotheses({ campaign_id: args.campaign_id, project_id: args.project_id, state: args.state, limit: args.limit }) });
    case "transition":
      return ok({ hypothesis: records.transitionHypothesis(args.hypothesis_id, args.state, actor, args.reason) });
    default:
      return errorResult(new ResearchError("invalid_input", `unknown action: ${args.action}`));
  }
}

// --- research_scope ---------------------------------------------------------

function handleScope(services, args, runtime) {
  const actor = resolveActor(args, runtime);
  switch (args.action) {
    case "create":
      return ok({ snapshot: records.createScopeSnapshot(args, actor) });
    case "get":
      return ok({ snapshot: records.getScopeSnapshot(args.snapshot_id) });
    case "list":
      return ok({ snapshots: records.listScopeSnapshots({ project_id: args.project_id, state: args.state, limit: args.limit }) });
    case "evaluate": {
      const structured = args.target && typeof args.target === "object" ? args.target : null;
      if (structured && args.target_kind && args.target_kind !== structured.kind) throw new ResearchError("invalid_input", "target_kind must match target.kind");
      return ok({ decision: records.evaluateScope(args.snapshot_id, { project_id: args.project_id, target: structured ? structured.value : args.target, target_kind: structured ? structured.kind : args.target_kind, operation: args.operation }) });
    }
    default:
      return errorResult(new ResearchError("invalid_input", `unknown action: ${args.action}`));
  }
}

// --- research_run -----------------------------------------------------------

async function handleRun(services, args, runtime) {
  const actor = resolveActor(args, runtime);
  const config = services.config || {};
  switch (args.action) {
    case "plan":
      return ok({ run: runsLib.plan(args, actor, config) });
    case "start":
      return ok({ run: await runsLib.start(args.run_id, actor, services) });
    case "status":
      return ok({ run: runsLib.get(args.run_id) });
    case "resume":
      return ok({ run: runsLib.resume(args.run_id) });
    case "cancel":
      return ok({ run: runsLib.cancel(args.run_id, actor, args.reason) });
    case "complete":
      return ok({ run: runsLib.complete(args.run_id, { outcome: args.outcome, evidence: args.evidence, actor }) });
    case "provision": {
      // Provision the run's disposable lab by composing the Proxmox pack. The
      // WHICH-lab specifics (profile, clone spec) come from the run's environment,
      // supplied by the operator at runtime — never from this repository.
      const ctx = runContext(services, args.run_id, runtime);
      return ok({ lab: await labLib.provision(services, ctx, runtime) });
    }
    case "cleanup": {
      const ctx = runContext(services, args.run_id, runtime);
      return ok({ lab: await labLib.cleanup(services, ctx, runtime) });
    }
    case "list":
      return ok({ runs: runsLib.list({ project_id: args.project_id, campaign_id: args.campaign_id, hypothesis_id: args.hypothesis_id, state: args.state, limit: args.limit }) });
    default:
      return errorResult(new ResearchError("invalid_input", `unknown action: ${args.action}`));
  }
}

// --- research_probe ---------------------------------------------------------

async function handleProbe(services, args, runtime) {
  const ctx = runContext(services, args.run_id, runtime);
  if (["completed", "cancelled", "failed", "inconclusive"].includes(ctx.run.state)) {
    return errorResult(new ResearchError("state_conflict", `run is terminal (${ctx.run.state}); start a new run to probe again`));
  }
  const result = await probesLib.execute(services, ctx, args.probe, runtime);
  return ok(result);
}

// --- research_evidence ------------------------------------------------------

function handleEvidence(services, args, runtime) {
  const actor = resolveActor(args, runtime);
  switch (args.action) {
    case "capture": {
      const ctx = runContext(services, args.run_id, runtime);
      const captured = evidenceLib.capture(ctx, {
        type: args.type || "observation",
        name: args.name,
        data: args.data,
        content_type: args.content_type,
        sensitivity: args.sensitivity,
        redaction_state: args.redaction_state || "none",
        metadata: { ...(args.metadata || {}), ...normalizeEvidenceMetadata(args.metadata || {}, { evidence_class: args.type === "runtime" || args.type === "observation" ? "runtime_evidence" : "exact_source_evidence", completeness: "complete" }) },
      });
      // Evidence is linked to the run's execution via artifact custody; no
      // separate attach step is needed.
      return ok({ evidence: captured });
    }
    case "list": {
      // run_id is the precise, convenient filter: a run's evidence is the set of
      // research-evidence artifacts linked to its execution.
      let executionId = args.execution_id;
      if (args.run_id && !executionId) executionId = runsLib.get(args.run_id).execution_id;
      const run = args.run_id ? runsLib.get(args.run_id) : null;
      return ok({ evidence: evidenceLib.list({ project_id: projectScope(args, runtime, run), execution_id: executionId, limit: args.limit }) });
    }
    case "inspect": {
      const run = args.run_id ? runsLib.get(args.run_id) : null;
      return ok({ evidence: evidenceLib.inspect(args.references, { projectId: projectScope(args, runtime, run) }) });
    }
    case "redact": {
      const root = requireWorkspace(services);
      const run = args.run_id ? runsLib.get(args.run_id) : null;
      return ok({ evidence: evidenceLib.redactEvidence({ root, projectId: projectScope(args, runtime, run) }, args.evidence_id) });
    }
    default:
      return errorResult(new ResearchError("invalid_input", `unknown action: ${args.action}`));
  }
}

// --- research_compare -------------------------------------------------------

function extractObservationOutput(services, ref, projectId) {
  const root = requireWorkspace(services);
  const id = String(ref).replace(/^artifact:/, "");
  const kernel = require("./lib/platform").kernel();
  const artifact = kernel.getArtifact(id);
  if (!artifact || !projectId || !artifact.project_id || String(artifact.project_id) !== String(projectId)) throw new ResearchError("not_found", `evidence not found: ${ref}`);
  const bytes = workspace.readInside(root, require("path").join(root, artifact.storage_ref));
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    return parsed.output !== undefined ? parsed.output : parsed;
  } catch {
    return bytes.toString("utf8");
  }
}

function handleCompare(services, args, runtime) {
  let baseline = args.baseline;
  let candidate = args.candidate;
  const fromEvidence = Boolean(args.baseline_evidence || args.candidate_evidence);
  const run = args.run_id ? runsLib.get(args.run_id) : null;
  const projectId = fromEvidence ? projectScope(args, runtime, run) : null;
  if (args.baseline_evidence) baseline = extractObservationOutput(services, args.baseline_evidence, projectId);
  if (args.candidate_evidence) candidate = extractObservationOutput(services, args.candidate_evidence, projectId);
  if (baseline === undefined || candidate === undefined) {
    return errorResult(new ResearchError("invalid_input", "compare requires baseline and candidate (values or evidence references)"));
  }
  const comparison = compareLib.compareValues(baseline, candidate, args.mode || "auto");
  // When comparing evidence, never echo the raw evidence values back into the
  // result (and thus into model context): status/hash modes otherwise return
  // the verbatim baseline/candidate. Only the deterministic verdict leaves.
  if (fromEvidence && (comparison.baseline !== undefined || comparison.candidate !== undefined)) {
    delete comparison.baseline;
    delete comparison.candidate;
    comparison.values_redacted = true;
  }
  return ok({ comparison });
}

// --- research_validate ------------------------------------------------------

function handleValidate(services, args, runtime) {
  const actor = resolveActor(args, runtime);
  const verdict = compareLib.validateExpectation(args.expected, args.observed, args.mode || "auto");
  const result = { validation: verdict };

  if (args.run_id && args.record_outcome) {
    const run = runsLib.get(args.run_id);
    const outcome = args.outcome_label || (verdict.changed ? "expectation_not_met" : "expectation_met");
    if (!run.evidence || run.evidence.length === 0) {
      return errorResult(new ResearchError("validation_failed", "cannot record a run outcome without evidence; capture a probe observation first"));
    }
    result.run = runsLib.complete(args.run_id, { outcome, evidence: run.evidence, actor });

    if (args.create_finding) {
      const finding = records.createFinding({
        campaign_id: result.run.campaign_id,
        title: args.create_finding.title,
        claim: args.create_finding.claim,
        status: args.create_finding.status || "supported",
        impact: args.create_finding.impact,
        hypothesis_id: result.run.hypothesis_id,
        test_run_id: result.run.run_id,
        evidence_refs: run.evidence,
        metadata: { validation: verdict },
      }, actor);
      result.finding = finding;
    }
  }
  return ok(result);
}

// --- research_report --------------------------------------------------------

function handleReport(services, args, runtime) {
  const actor = resolveActor(args, runtime);
  switch (args.action) {
    case "materialize": {
      const root = requireWorkspace(services);
      return ok(reportLib.materialize({ root }, args, actor));
    }
    case "get":
      return ok({ report: records.getReport(args.report_id) });
    case "list":
      return ok({ reports: records.listReports({ project_id: args.project_id, campaign_id: args.campaign_id, status: args.status, limit: args.limit }) });
    default:
      return errorResult(new ResearchError("invalid_input", `unknown action: ${args.action}`));
  }
}

function handleSource(services, args, runtime) {
  // Source provenance must come from the authenticated execution context, not
  // a caller-controlled actor field that could spoof audit attribution.
  const runtimeActor = runtime && runtime.context && runtime.context.actor;
  if (args.action === "authority" && (!runtimeActor || !String(runtimeActor).trim())) {
    throw new ResearchError("authorization_failed", "an authenticated runtime actor is required for source authority");
  }
  return sourceLib.execute(services, { ...args, _runtime_project: runtime && runtime.context && runtime.context.project || null }, args.action === "authority" ? String(runtimeActor).trim() : resolveActor({}, runtime));
}

// Wrap a handler so any thrown ResearchError/Error becomes a structured result.
function guard(fn) {
  return async (args, runtime) => {
    try {
      return await fn(args, runtime);
    } catch (error) {
      return errorResult(error);
    }
  };
}

const entry = {
  buildDescriptors(services) {
    return [
      {
        name: "research_status",
        aliases: ["research_health"],
        description: "Report Security Research pack readiness: workspace state (configured/missing/unsafe), availability of each composed capability (bash, web_fetch, git, hash, Proxmox, Ansible), policy switches, and configured environments. Exposes status only — never secrets, endpoints, or workspace contents.",
        schema: z.object({}),
        args: {},
        risk: "low",
        category: "Security",
        handler: guard(() => handleStatus(services)),
      },
      {
        name: "research_project",
        aliases: ["research_campaign"],
        description: "Manage durable research campaigns (the project/campaign record): create, get (with hypotheses and runs), list, or transition state (draft/active/paused/closed). Target-sensitive content belongs in the external workspace; this holds generic execution metadata.",
        schema: z.object({
          action: z.enum(["create", "get", "list", "transition"]),
          campaign_id: z.string().optional(),
          project_id: z.string().optional(),
          name: z.string().optional(),
          state: z.string().optional(),
          scope_snapshot_id: z.string().optional(),
          network_scope: z.string().max(80).optional(),
          reason: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          actor: z.string().optional(),
          metadata: z.any().optional(),
        }),
        args: { action: "string (create|get|list|transition)", campaign_id: "string", project_id: "string", name: "string", state: "string", scope_snapshot_id: "string", network_scope: "string (operator-created named scope)", reason: "string", limit: "number", metadata: "object" },
        risk: "medium",
        category: "Security",
        handler: guard((args, runtime) => handleProject(services, args, runtime)),
      },
      {
        name: "research_hypothesis",
        description: "Manage research hypotheses and their lifecycle (proposed -> ready/analysis_only -> running -> supported/confirmed/rejected): create, get, list, or transition. Confidence is advisory and never a substitute for evidence.",
        schema: z.object({
          action: z.enum(["create", "get", "list", "transition"]),
          hypothesis_id: z.string().optional(),
          campaign_id: z.string().optional(),
          project_id: z.string().optional(),
          title: z.string().optional(),
          claim: z.string().optional(),
          rationale: z.string().optional(),
          state: z.string().optional(),
          reason: z.string().optional(),
          confidence: z.number().min(0).max(1).optional(),
          prerequisites: z.array(z.any()).optional(),
          criteria: z.any().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          actor: z.string().optional(),
          metadata: z.any().optional(),
        }),
        args: { action: "string (create|get|list|transition)", hypothesis_id: "string", campaign_id: "string", title: "string", claim: "string", state: "string", confidence: "number 0..1", criteria: "object", metadata: "object" },
        risk: "medium",
        category: "Security",
        handler: guard((args, runtime) => handleHypothesis(services, args, runtime)),
      },
      {
        name: "research_scope",
        description: "Manage authorization scope snapshots and evaluate whether a target/operation is in scope. A scope snapshot is the authoritative allowlist a run and its probes are checked against. Default to local/private/configured environments; never infer authorization from public accessibility.",
        schema: z.object({
          action: z.enum(["create", "get", "list", "evaluate"]),
          snapshot_id: z.string().optional(),
          project_id: z.string().optional(),
          targets: z.array(z.any()).optional(),
          rules: z.any().optional(),
          expires_at: z.string().optional(),
          supersedes_snapshot_id: z.string().optional(),
          target: z.union([z.string(), z.object({ kind: z.string().min(1), value: z.string().min(1) })]).optional(),
          target_kind: z.string().optional(),
          operation: z.string().optional(),
          state: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          actor: z.string().optional(),
          metadata: z.any().optional(),
        }),
        args: { action: "string (create|get|list|evaluate)", snapshot_id: "string", project_id: "string", targets: "array of {kind,value}", rules: "object", target: "string or {kind,value}", target_kind: "string", operation: "string" },
        risk: "medium",
        category: "Security",
        handler: guard((args, runtime) => handleScope(services, args, runtime)),
      },
      {
        name: "research_run",
        description: "Manage durable research runs: plan (create execution + test run), start, status, resume, cancel, complete, provision, cleanup, or list. A run is backed by a platform execution and a kernel test-run record, so its state survives a restart. A completed run requires an outcome and evidence — enforced by the kernel. For a run whose environment is kind 'proxmox', 'provision' composes the Proxmox pack to create a disposable guest (recording provenance) and 'cleanup' requests an authorized shutdown then consumes the provider's guarded retirement (proxmox_retire); deletion stays pending/manual whenever the provider's destroy policy, provenance or protection controls deny it.",
        schema: z.object({
          action: z.enum(["plan", "start", "status", "resume", "cancel", "complete", "provision", "cleanup", "list"]),
          run_id: z.string().optional(),
          hypothesis_id: z.string().optional(),
          campaign_id: z.string().optional(),
          project_id: z.string().optional(),
          scope_snapshot_id: z.string().optional(),
          network_scope: z.string().max(80).optional(),
          name: z.string().optional(),
           environment: z.any().optional(),
           sink: z.string().max(500).optional(),
           caller_chain: z.array(z.string().max(500)).max(50).optional(),
           boundary: z.string().max(500).optional(),
           disposition: z.string().max(100).optional(),
          manifest: z.any().optional(),
          outcome: z.string().optional(),
          evidence: z.array(z.string()).optional(),
          reason: z.string().optional(),
          state: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          actor: z.string().optional(),
        }),
         args: { action: "string (plan|start|status|resume|cancel|complete|provision|cleanup|list)", run_id: "string", hypothesis_id: "string", environment: "string|object", sink: "string (research sink for duplicate detection)", caller_chain: "array of caller symbols", boundary: "string (authorization or trust boundary)", disposition: "string (known-null, candidate, or confirmed disposition)", network_scope: "string (operator-created named scope)", outcome: "string", evidence: "array of evidence references" },
        risk: "high",
        category: "Security",
        handler: guard((args, runtime) => handleRun(services, args, runtime)),
      },
      {
        name: "research_probe",
        description: "Execute one bounded probe against a run and capture the result as an observation with evidence. A 'command' probe composes the governed bash tool (refused on the Sidekick host unless local probes are explicitly enabled); an 'http' probe composes web_fetch under scope and SSRF gating. Never an arbitrary shell — every probe is typed, scoped, timed and audited.",
        schema: z.object({
          run_id: z.string(),
          probe: z.object({
            name: z.string().optional(),
            type: z.enum(["command", "http"]),
            target: z.string().optional(),
            target_kind: z.string().optional(),
            operation: z.string().optional(),
            command: z.string().optional(),
            workdir: z.string().optional(),
            url: z.string().optional(),
            method: z.string().optional(),
            headers: z.any().optional(),
            body: z.any().optional(),
          }),
          actor: z.string().optional(),
        }),
        args: { run_id: "string", probe: "object { type: command|http, ... }" },
        risk: "high",
        category: "Security",
        handler: guard((args, runtime) => handleProbe(services, args, runtime)),
      },
      {
        name: "research_evidence",
        description: "Capture, list, inspect, or redact evidence. Raw evidence bytes live only in the external workspace; the kernel stores the reference, SHA-256 hash, size and lineage. inspect returns metadata only (never bytes); redact produces a sanitized derivative and never mutates the original.",
        schema: z.object({
          action: z.enum(["capture", "list", "inspect", "redact"]),
          run_id: z.string().optional(),
          type: z.string().optional(),
          name: z.string().optional(),
          data: z.any().optional(),
          content_type: z.string().optional(),
          sensitivity: z.string().optional(),
          redaction_state: z.string().optional(),
          references: z.array(z.string()).optional(),
          evidence_id: z.string().optional(),
          project_id: z.string().optional(),
          execution_id: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          actor: z.string().optional(),
          metadata: z.any().optional(),
        }),
        args: { action: "string (capture|list|inspect|redact)", run_id: "string", data: "string|object (evidence content)", references: "array of artifact:<id>", evidence_id: "string" },
        risk: "medium",
        category: "Security",
        handler: guard((args, runtime) => handleEvidence(services, args, runtime)),
      },
      {
        name: "research_compare",
        description: "Deterministically compare a baseline with a candidate (status, hash, text, or json). Accepts literal values or two evidence references (whose observation output is compared). The comparison is mechanical and reproducible — a model may interpret the result but never computes it.",
        schema: z.object({
          baseline: z.any().optional(),
          candidate: z.any().optional(),
          baseline_evidence: z.string().optional(),
          candidate_evidence: z.string().optional(),
          run_id: z.string().optional(),
          mode: z.enum(["status", "hash", "text", "json", "auto"]).optional(),
        }),
        args: { baseline: "any", candidate: "any", baseline_evidence: "artifact:<id>", candidate_evidence: "artifact:<id>", run_id: "string (optional run scope for evidence)", mode: "string (status|hash|text|json|auto)" },
        risk: "low",
        category: "Security",
        handler: guard((args, runtime) => handleCompare(services, args, runtime)),
      },
      {
        name: "research_validate",
        description: "Validate an observation against an expectation and optionally record the run outcome and a finding. The match verdict is deterministic; whether a mismatch constitutes a real issue remains a human/model judgement, not an automatic conclusion. A confirmed finding requires a completed run and evidence — enforced by the kernel.",
        schema: z.object({
          expected: z.any(),
          observed: z.any(),
          mode: z.enum(["status", "hash", "text", "json", "auto"]).optional(),
          run_id: z.string().optional(),
          record_outcome: z.boolean().optional(),
          outcome_label: z.string().optional(),
          create_finding: z.object({
            title: z.string(),
            claim: z.string(),
            status: z.string().optional(),
            impact: z.string().optional(),
          }).optional(),
          actor: z.string().optional(),
        }),
        args: { expected: "any", observed: "any", mode: "string", run_id: "string", record_outcome: "boolean", create_finding: "object { title, claim, status }" },
        risk: "medium",
        category: "Security",
        handler: guard((args, runtime) => handleValidate(services, args, runtime)),
      },
      {
        name: "research_report",
        description: "Produce evidence-linked report material (into the workspace + custody record), or get/list report records. Never publishes, emails, or submits anything — disclosure is a separate explicit action. Every referenced evidence id is verified to exist so claims cannot cite absent evidence.",
        schema: z.object({
          action: z.enum(["materialize", "get", "list"]),
          report_id: z.string().optional(),
          campaign_id: z.string().optional(),
          project_id: z.string().optional(),
          title: z.string().optional(),
          status: z.string().optional(),
          finding_refs: z.array(z.string()).optional(),
          run_id: z.string().optional(),
          summary: z.string().optional(),
          affected_versions: z.any().optional(),
          tested_versions: z.any().optional(),
          environment: z.any().optional(),
          reproduction: z.any().optional(),
          observed_behavior: z.any().optional(),
          expected_behavior: z.any().optional(),
          impact: z.string().optional(),
          comparison: z.any().optional(),
          validation: z.any().optional(),
          limitations: z.any().optional(),
          confidence: z.string().optional(),
          claims: z.array(z.any()).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          actor: z.string().optional(),
        }),
        args: { action: "string (materialize|get|list)", campaign_id: "string", title: "string", finding_refs: "array", run_id: "string", claims: "array of { statement, evidence_refs }" },
        risk: "medium",
        category: "Security",
        handler: guard((args, runtime) => handleReport(services, args, runtime)),
      },
      {
        name: "research_source",
         description: "Manage campaign-owned Security Research source repositories and immutable snapshots. Import and acquire validate bounded regular-file trees, reject traversal, symlinks, special files and hard-linked aliases, stage atomically in the external workspace, and record deterministic manifests. Index dispatches semantic_repo only against a finalized registered snapshot and binds its provenance; compare is a bounded manifest comparison.",
        schema: z.object({
          action: z.enum(["list", "get", "import", "acquire", "refresh", "index", "compare", "verify", "select", "archive", "remove", "recover", "authority"]),
           authority_action: z.enum(["declare", "get", "list", "revoke"]).optional(),
          campaign_id: z.string().optional(),
          project_id: z.string().optional(),
          repository_id: z.string().optional(),
          snapshot_id: z.string().optional(),
          claim_id: z.string().optional(),
          baseline_snapshot_id: z.string().optional(),
          candidate_snapshot_id: z.string().optional(),
          snapshot_state: z.string().optional(),
          name: z.string().optional(),
           source_path: z.string().optional(),
           source_url: z.string().optional(),
           ref: z.string().max(1024).optional(),
           allowed_hosts: z.array(z.string()).max(32).optional(),
          index_action: z.enum(["profile", "query", "verify"]).optional(),
          authority_class: z.enum(["derived_analysis_input", "declared_source_authority"]).optional(),
          scope: z.record(z.any()).optional(),
          evidence_refs: z.array(z.string()).max(100).optional(),
          authority_state: z.string().optional(),
          metadata: z.any().optional(),
          query: z.string().max(500).optional(),
          level: z.number().int().min(0).max(2).optional(),
          max_chars: z.number().int().min(1000).max(60000).optional(),
          state: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          actor: z.string().optional(),
        }),
         args: { action: "string (list|get|import|acquire|refresh|index|compare|verify|select|archive|remove|recover|authority)", authority_action: "string (declare|get|list|revoke)", authority_class: "string", scope: "object", evidence_refs: "array of artifact:<id>", claim_id: "string", campaign_id: "string", project_id: "string", repository_id: "string", snapshot_id: "string", baseline_snapshot_id: "string", candidate_snapshot_id: "string", source_path: "absolute directory path", source_url: "HTTPS repository URL", ref: "string (optional ref)", allowed_hosts: "array (optional host patterns)", name: "string", index_action: "string", query: "string", level: "number", max_chars: "number", state: "string", limit: "number" },
        risk: "high",
        category: "Security",
        handler: guard((args, runtime) => handleSource(services, args, runtime)),
      },
    ];
  },

  healthCheck({ config }) {
    // Cheap and synchronous by contract: report workspace and dependency
    // readiness WITHOUT any network call, provider call, or secret value.
    const cfg = config || {};
    let ws;
    try {
      const resolved = workspace.resolveWorkspace(cfg, { requireExists: false });
      ws = { state: "configured", source: resolved.source };
    } catch (error) {
      ws = { state: error instanceof ResearchError ? (error.code === "workspace_missing" ? "missing" : "unsafe") : "error" };
    }
    const details = {
       tools: 11,
      workspace: ws.state,
      local_probes_enabled: cfg.allow_local_probes === true,
      environments: Object.keys(cfg.environments || {}).length,
    };
    // A missing workspace is healthy-but-unconfigured: the pack is installed and
    // inert until an operator points it at an external research workspace. An
    // UNSAFE workspace is a real misconfiguration and is reported as unhealthy.
    if (ws.state === "unsafe" || ws.state === "error") {
      return { ok: false, error: "Research workspace configuration is unsafe; it must be an external directory outside the Sidekick repository.", details };
    }
    return { ok: true, details };
  },
};

module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
