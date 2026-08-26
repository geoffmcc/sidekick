"use strict";

/**
 * Research run lifecycle.
 *
 * A run is durable: it is backed by a platform execution (for claims, leases
 * and audit correlation) and a kernel research test-run record (for the
 * research-facing state machine not_run -> running -> completed/…). A process
 * restart cannot make the run unknowable — its state is in the database, not in
 * memory. The research state machine's fail-closed invariants (a completed run
 * requires an execution, an outcome and evidence) are enforced by the kernel,
 * not re-implemented here.
 */

const { kernel } = require("./platform");
const { ResearchError } = require("./errors");
const { requireText } = require("./identity");
const { requireSidekickSrc } = require("./deps");
const records = require("./records");

const ENVIRONMENT_KINDS = ["local", "disposable", "proxmox", "remote"];

function mergeLabProfile(config, env) {
  if (!env || !env.lab_profile) return env;
  const profiles = config && config.lab_profiles || {};
  const profile = profiles[env.lab_profile];
  if (!profile) throw new ResearchError("environment_failed", `unknown lab profile '${env.lab_profile}'`);
  return { ...profile, ...env, name: env.name || profile.name || env.lab_profile, lab_profile: env.lab_profile };
}

function assertBoundNetworkScope(run) {
  const bound = run && run.metadata && run.metadata.network_scope;
  if (!bound) return;
  const current = requireSidekickSrc("src/security/network-scopes").get(bound.scope_id, bound.revision);
  if (!current || !current.enabled || !current.is_current || current.digest !== bound.digest) throw new ResearchError("scope_stale", "the bound named network scope is disabled, expired, or has changed; rebind the run explicitly");
}

// Resolve an environment reference (a name into pack config, or an inline spec)
// into a normalized descriptor. Never contacts a provider — it only describes
// where a probe will run so probe-time gating can reason about it.
function resolveEnvironment(config, envInput) {
  if (!envInput) return { kind: "local", name: "default-local", isolation: "shared", network_mode: "none", production_access: false };
  if (typeof envInput === "string") {
    // Tolerate a stringified JSON environment object: some MCP clients serialize
    // object arguments on permissive (any) schema fields to strings. A leading
    // '{' means the caller meant an inline environment, not a named one.
    const trimmed = envInput.trim();
    if (trimmed.startsWith("{")) {
      let parsed = null;
      try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
      if (parsed && typeof parsed === "object") return normalizeEnvironment(parsed);
      throw new ResearchError("invalid_input", "environment looks like JSON but could not be parsed");
    }
    const environments = (config && config.environments) || {};
    const found = environments[envInput];
    if (!found) throw new ResearchError("environment_failed", `unknown environment '${envInput}' — configure it under the pack's 'environments'`);
    return normalizeEnvironment(mergeLabProfile(config, { ...found, name: envInput }));
  }
  if (typeof envInput === "object") return normalizeEnvironment(mergeLabProfile(config, envInput));
  throw new ResearchError("invalid_input", "environment must be a name or an object");
}

function normalizeEnvironment(env) {
  const kind = String(env.kind || "local");
  if (!ENVIRONMENT_KINDS.includes(kind)) throw new ResearchError("invalid_input", `unknown environment kind: ${kind}`);
  return {
    name: env.name || kind,
    kind,
    isolation: env.isolation || (kind === "local" ? "shared" : "isolated"),
    network_mode: env.network_mode || (kind === "local" ? "none" : "lab"),
    production_access: env.production_access === true,
    provider_profile: env.provider_profile || null,
    lab_profile: env.lab_profile || null,
    environment_label: env.environment_label || env.label || env.name || kind,
    target_allowlist: Array.isArray(env.target_allowlist) ? [...env.target_allowlist] : [],
    egress: env.egress || (env.network_mode === "none" ? "none" : "restricted"),
    rollback: env.rollback && typeof env.rollback === "object" ? env.rollback : null,
    topology: env.topology && typeof env.topology === "object" ? { ...env.topology } : { mode: "single_node", expected_nodes: 1 },
    // The proxmox_provision spec (action + params) for a disposable lab. Carried
    // through verbatim so the run can provision later; operator-supplied.
    provision: env.provision && typeof env.provision === "object" ? env.provision : null,
    workdir: env.workdir || null,
    description: env.description || null,
  };
}

/**
 * Plan a run: create the durable execution + test-run in state not_run.
 */
function plan(input, actor, config) {
  const hypothesis = records.getHypothesis(requireText(input.hypothesis_id, "hypothesis_id"));
  const campaign = records.getCampaign(hypothesis.campaign_id);
  const environment = resolveEnvironment(config, input.environment);
  const requestedScope = input.network_scope ? requireSidekickSrc("src/security/network-scopes").get(input.network_scope) : null;
  const campaignScope = campaign.metadata?.network_scope || null;
  if (requestedScope && campaignScope && (requestedScope.scope_id !== campaignScope.scope_id || requestedScope.revision !== campaignScope.revision || requestedScope.digest !== campaignScope.digest)) throw new ResearchError("authorization_failed", "run network_scope must match the campaign binding; create a new campaign binding to rebind authority");
  const networkScope = requestedScope || campaignScope;
  if (input.network_scope && (!networkScope || !networkScope.enabled)) throw new ResearchError("policy_denied", "network scope is missing, disabled, or expired");
  const k = kernel();
  const researchProvenance = input.sink || input.caller_chain || input.boundary || input.disposition
    ? { sink: input.sink || null, caller_chain: Array.isArray(input.caller_chain) ? input.caller_chain : [], boundary: input.boundary || null, disposition: input.disposition || "unclassified" }
    : null;
  const duplicateCandidates = researchProvenance ? records.listFindings({ campaign_id: campaign.campaign_id, limit: 100 }).filter(finding => {
    const prior = finding.metadata?.research_provenance || {};
    return researchProvenance.sink && prior.sink === researchProvenance.sink
      && (!researchProvenance.boundary || prior.boundary === researchProvenance.boundary);
  }).map(finding => ({ finding_id: finding.finding_id, title: finding.title, status: finding.status, disposition: finding.metadata?.research_provenance?.disposition || null })) : [];

  const execution = k.createExecution({
    project_id: hypothesis.project_id,
    actor_id: actor,
    operation_type: "research_run",
    tool_name: "research_run",
    source: "security-research",
    metadata: {
      research: true,
      hypothesis_id: hypothesis.hypothesis_id,
      campaign_id: hypothesis.campaign_id,
      environment: environment.name,
    },
  });

  let testRun;
  try {
    testRun = k.createResearchTestRun({
      hypothesis_id: hypothesis.hypothesis_id,
      created_by: actor,
      execution_id: execution.execution_id,
      scope_snapshot_id: input.scope_snapshot_id || undefined,
      state: "not_run",
      environment,
      metadata: {
        name: input.name || null,
        manifest: input.manifest || null,
        environment_name: environment.name,
        network_scope: networkScope ? { scope_id: networkScope.scope_id, name: networkScope.name, revision: networkScope.revision, digest: networkScope.digest, policy: networkScope.policy || networkScope } : null,
        research_provenance: researchProvenance,
        duplicate_candidates: duplicateCandidates,
      },
      source: "security-research",
    });
  } catch (error) {
    throw records.mapKernelError(error);
  }
  return { ...decorate(testRun, execution, environment), duplicate_candidates: duplicateCandidates };
}

function get(runId) {
  const testRun = kernel().getResearchTestRun(requireText(runId, "run_id"));
  if (!testRun) throw new ResearchError("not_found", `run not found: ${runId}`);
  const execution = testRun.execution_id ? kernel().getExecution(testRun.execution_id) : null;
  const decorated = decorate(testRun, execution, testRun.environment);
  decorated.evidence = gatherEvidence(decorated);
  return decorated;
}

// A run's evidence is authoritatively the set of research-evidence artifacts
// linked to its execution. Deriving it from artifact custody (rather than
// mutating the test-run on every capture) means the kernel's test-run state
// machine — which has no running->running self-loop — is never abused just to
// append an evidence reference, and evidence and custody can never disagree.
function gatherEvidence(run) {
  if (!run.execution_id) return run.evidence || [];
  try {
    const artifacts = kernel().listArtifacts({ execution_id: run.execution_id, custody_role: "original", limit: 100 });
    return artifacts.filter((a) => a.type === "research-evidence").map((a) => `artifact:${a.artifact_id}`);
  } catch {
    return run.evidence || [];
  }
}

async function preflight(run, services) {
  const checks = [];
  try {
    const root = require("./workspace").resolveWorkspace(services?.config || {}, { requireExists: false }).root;
    checks.push({ name: "evidence_backend", ok: true, workspace: root });
    kernel().listArtifacts({ execution_id: run.execution_id, limit: 1 });
  } catch (error) {
    checks.push({ name: "evidence_backend", ok: false, reason: error.message });
  }
  if (run.scope_snapshot_id) {
    const snapshot = kernel().getScopeSnapshot(run.scope_snapshot_id);
    let decision = null;
    if (snapshot) {
      try { decision = kernel().evaluateScope(run.scope_snapshot_id, { project_id: run.project_id, target: "", target_kind: "host", operation: "execute" }); } catch (error) { decision = { ok: false, reason: error.message }; }
    }
    // This validates that the evaluator and snapshot are available without
    // inventing an in-scope target. Probe-time gating performs the real check.
    checks.push({ name: "scope_evaluator", ok: Boolean(snapshot) && Boolean(decision), snapshot_id: run.scope_snapshot_id, decision });
  } else checks.push({ name: "scope_evaluator", ok: true, mode: "unbound" });
  if (["proxmox", "disposable"].includes(run.environment?.kind)) {
    const lab = require("./lab");
    try {
      const result = await lab.preflight(services, { environment: run.environment, timeoutMs: services?.config?.probe_timeout_ms || 60000 }, {});
      checks.push({ name: "lab_environment", ok: true, ...result });
    } catch (error) { checks.push({ name: "lab_environment", ok: false, reason: error.message }); }
  } else checks.push({ name: "lab_environment", ok: true, mode: "not_required" });
  const failed = checks.filter(check => !check.ok);
  return { ok: failed.length === 0, checks, topology: run.environment?.topology || { mode: "single_node", expected_nodes: 1 } };
}

async function start(runId, actor, services) {
  const current = get(runId);
  assertBoundNetworkScope(current);
  if (current.state === "running") return current; // idempotent
  const readiness = await preflight(current, services || {});
  if (!readiness.ok) throw new ResearchError("preflight_failed", "research run preflight failed; run remains not_run", { preflight: readiness });
  let testRun;
  try {
    testRun = kernel().transitionResearchTestRun(current.test_run_id, "running", { actor_id: actor, source: "security-research" });
  } catch (error) {
    throw records.mapKernelError(error);
  }
  bestEffortExecution(current.execution_id, "running");
  return { ...get(testRun.test_run_id), preflight: readiness };
}

/**
 * Resume: report the durable state and whether the run is resumable. Research
 * runs are declarative and their probes are idempotent (run-specific evidence
 * ids), so resuming is safe — it never blindly repeats a mutating step.
 */
function resume(runId) {
  const run = get(runId);
  assertBoundNetworkScope(run);
  const resumable = ["not_run", "running"].includes(run.state);
  return {
    ...run,
    resumable,
    next: run.state === "not_run" ? "start" : (run.state === "running" ? "probe_or_complete" : "terminal"),
  };
}

function cancel(runId, actor, reason) {
  const current = get(runId);
  if (["completed", "cancelled", "failed", "inconclusive"].includes(current.state)) {
    throw new ResearchError("state_conflict", `run is already terminal (${current.state}); evidence is preserved`);
  }
  let testRun;
  try {
    testRun = kernel().transitionResearchTestRun(current.test_run_id, "cancelled", { actor_id: actor, source: "security-research" });
  } catch (error) {
    throw records.mapKernelError(error);
  }
  bestEffortExecution(current.execution_id, "cancelled");
  return { ...decorate(testRun, null, current.environment), cancel_reason: reason || null };
}

/**
 * Complete a run with an outcome and evidence references. The kernel refuses to
 * complete without execution_id + outcome + at least one evidence ref.
 */
function complete(runId, { outcome, evidence, actor }) {
  const current = get(runId);
  const evidenceRefs = Array.isArray(evidence) && evidence.length ? evidence : current.evidence;
  let testRun;
  try {
    testRun = kernel().transitionResearchTestRun(current.test_run_id, "completed", {
      actor_id: actor,
      source: "security-research",
      outcome: requireText(outcome, "outcome"),
      evidence: evidenceRefs,
    });
  } catch (error) {
    throw records.mapKernelError(error);
  }
  bestEffortExecution(current.execution_id, "succeeded");
  return get(testRun.test_run_id);
}

function list(query) {
  return kernel().listResearchTestRuns(query || {}).map((r) => decorate(r, null, r.environment));
}

// Execution state transitions are bookkeeping for claims/audit; the test-run is
// the authoritative research state. Never fail a research operation because an
// execution transition was not permitted from its current state.
function bestEffortExecution(executionId, state) {
  if (!executionId) return;
  try {
    kernel().transitionExecution(executionId, state, { source: "security-research" });
  } catch {}
}

function decorate(testRun, execution, environment) {
  return {
    run_id: testRun.test_run_id,
    test_run_id: testRun.test_run_id,
    campaign_id: testRun.campaign_id,
    hypothesis_id: testRun.hypothesis_id,
    project_id: testRun.project_id,
    execution_id: testRun.execution_id,
    scope_snapshot_id: testRun.scope_snapshot_id || null,
    state: testRun.state,
    outcome: testRun.outcome || null,
    evidence: testRun.evidence || [],
    environment: environment || testRun.environment || null,
    execution_state: execution ? execution.state : undefined,
    created_at: testRun.created_at,
    updated_at: testRun.updated_at,
    metadata: testRun.metadata || {},
  };
}

module.exports = { plan, get, start, resume, cancel, complete, list, resolveEnvironment, gatherEvidence, preflight };
