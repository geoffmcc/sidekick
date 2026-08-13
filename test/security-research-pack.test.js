"use strict";

/**
 * Security Research pack — integration + synthetic end-to-end tests.
 *
 * Drives the pack through its REAL surfaces: bundled install + enable, the
 * governed tool dispatcher (callInternalTool), and the workflow engine. Nothing
 * about Sidekick itself is mocked. Command probes run against tiny synthetic
 * local fixtures confined to an external temp workspace; no real target and no
 * private research is used anywhere. Labels SR.1…
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const TEST_DATA_DIR = path.join(__dirname, "test-data-security-research-pack");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "sr-pack-ws-"));

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(TEST_DATA_DIR, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_SECRET_KEY = "security-research-pack-test-secret-key";

require(path.join(REPO, "src/db")).runPendingMigrations();
const bundled = require(path.join(REPO, "src/packs/bundled"));
const packLifecycle = require(path.join(REPO, "src/packs/lifecycle"));
const platformKernel = require(path.join(REPO, "src/platform/kernel"));
const { callInternalTool } = require(path.join(REPO, "src/tools/dispatcher"));
const labLib = require(path.join(REPO, "packs/security-research/modules/security-research-tools/lib/lab.js"));

const PROJECT = "demo_project"; // already canonical, so scope project_id matches

let failures = 0;
async function test(label, fn) {
  try { await fn(); console.log(`Passed: ${label}`); }
  catch (e) { failures += 1; console.error(`FAILED: ${label}\n  ${e && e.stack ? e.stack : e}`); }
}
function json(result) { return JSON.parse(result.content[0].text); }
async function call(tool, args) {
  const r = await callInternalTool(tool, args);
  return { r, j: json(r), isError: Boolean(r.isError), code: r.code || null };
}
async function okCall(tool, args) {
  const out = await call(tool, args);
  if (out.isError) throw new Error(`${tool} ${args.action || ""} failed: ${JSON.stringify(out.j)}`);
  return out.j;
}

function makeGitRepo() {
  const repo = path.join(WORKSPACE, "srcrepo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=test@example.test", "-c", "user.name=Test", ...a], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "service.txt"), "status=403\n");
  git("add", "-A"); git("commit", "-q", "-m", "baseline"); git("tag", "v1");
  fs.writeFileSync(path.join(repo, "service.txt"), "status=200\n");
  git("add", "-A"); git("commit", "-q", "-m", "candidate"); git("tag", "v2");
  return repo;
}

(async () => {
  // --- install ----------------------------------------------------------------
  await test("SR.1 installs and enables healthy", async () => {
    bundled.installBundledPack("security-research", {
      enable: true,
      config: {
        workspace: WORKSPACE,
        allow_local_probes: true,
        http: { allowed_hosts: ["*.example.test"], allow_private_addresses: false },
        environments: { lab: { kind: "local" } },
      },
    });
    const health = packLifecycle.health("security-research");
    assert.strictEqual(health.status, "healthy", `health: ${JSON.stringify(health)}`);
  });

  await test("SR.2 research_status reports configured workspace and available capabilities", async () => {
    const s = await okCall("research_status", {});
    assert.strictEqual(s.workspace.state, "configured");
    assert.strictEqual(s.capabilities.bash, true);
    assert.strictEqual(s.policy.local_probes_enabled, true);
    assert.ok(s.ready);
  });

  // --- records ---------------------------------------------------------------
  let campaignId, hypothesisId, runId;

  await test("SR.3 campaign create/get/list/transition", async () => {
    const created = await okCall("research_project", { action: "create", project_id: PROJECT, name: "Synthetic regression campaign" });
    campaignId = created.campaign.campaign_id;
    const got = await okCall("research_project", { action: "get", campaign_id: campaignId });
    assert.strictEqual(got.campaign.campaign_id, campaignId);
    const listed = await okCall("research_project", { action: "list", project_id: PROJECT });
    assert.ok(listed.campaigns.some((c) => c.campaign_id === campaignId));
    const activated = await okCall("research_project", { action: "transition", campaign_id: campaignId, state: "active" });
    assert.strictEqual(activated.campaign.state, "active");
  });

  await test("SR.4 hypothesis lifecycle", async () => {
    const created = await okCall("research_hypothesis", { action: "create", campaign_id: campaignId, title: "Behavior changed across versions", claim: "The synthetic service status changes after the version bump", confidence: 0.4 });
    hypothesisId = created.hypothesis.hypothesis_id;
    assert.strictEqual(created.hypothesis.state, "proposed");
    const ready = await okCall("research_hypothesis", { action: "transition", hypothesis_id: hypothesisId, state: "ready" });
    assert.strictEqual(ready.hypothesis.state, "ready");
  });

  await test("SR.5 scope snapshot create + evaluate (in and out of scope)", async () => {
    const snap = await okCall("research_scope", { action: "create", project_id: PROJECT, targets: [{ kind: "host", value: "lab" }], rules: { allowed_operations: ["execute", "http.request"] } });
    const inScope = await okCall("research_scope", { action: "evaluate", snapshot_id: snap.snapshot.snapshot_id, project_id: PROJECT, target: "lab", target_kind: "host", operation: "execute" });
    assert.strictEqual(inScope.decision.ok, true);
    const outScope = await okCall("research_scope", { action: "evaluate", snapshot_id: snap.snapshot.snapshot_id, project_id: PROJECT, target: "prod", target_kind: "host", operation: "execute" });
    assert.strictEqual(outScope.decision.ok, false);
    assert.strictEqual(outScope.decision.reason, "target_not_in_scope");
  });

  await test("SR.6 run plan/start is durable (backed by a platform execution)", async () => {
    const planned = await okCall("research_run", { action: "plan", hypothesis_id: hypothesisId, name: "regression run", environment: { kind: "local", name: "lab" } });
    runId = planned.run.run_id;
    assert.strictEqual(planned.run.state, "not_run");
    assert.ok(planned.run.execution_id);
    const execution = platformKernel.getExecution(planned.run.execution_id);
    assert.ok(execution, "execution should be persisted in the kernel");
    const started = await okCall("research_run", { action: "start", run_id: runId });
    assert.strictEqual(started.run.state, "running");
    const resumed = await okCall("research_run", { action: "resume", run_id: runId });
    assert.strictEqual(resumed.run.resumable, true);
  });

  // --- probes + evidence (composition) ---------------------------------------
  let baselineRef, candidateRef;

  await test("SR.7 command probes compose bash and capture observations as evidence", async () => {
    const baseline = await okCall("research_probe", { run_id: runId, probe: { name: "baseline", type: "command", target: "lab", command: "printf 'status:403'" } });
    const candidate = await okCall("research_probe", { run_id: runId, probe: { name: "candidate", type: "command", target: "lab", command: "printf 'status:200'" } });
    assert.strictEqual(baseline.observation.succeeded, true);
    assert.ok(baseline.evidence.reference.startsWith("artifact:"));
    assert.ok(baseline.evidence.content_hash.startsWith("sha256:"));
    baselineRef = baseline.evidence.reference;
    candidateRef = candidate.evidence.reference;
    // The raw evidence bytes must exist in the EXTERNAL workspace, not in the repo.
    assert.ok(fs.existsSync(path.join(WORKSPACE, baseline.evidence.storage_ref)));
  });

  await test("SR.8 deterministic comparison of the two observations", async () => {
    const cmp = await okCall("research_compare", { baseline_evidence: baselineRef, candidate_evidence: candidateRef, mode: "text" });
    assert.strictEqual(cmp.comparison.changed, true);
    // Comparing evidence must not echo the raw evidence values back into the result.
    const statusCmp = await okCall("research_compare", { baseline_evidence: baselineRef, candidate_evidence: candidateRef, mode: "status" });
    assert.strictEqual(statusCmp.comparison.changed, true);
    assert.strictEqual(statusCmp.comparison.values_redacted, true);
    assert.strictEqual(statusCmp.comparison.baseline, undefined, "raw evidence values must not be echoed");
    assert.strictEqual(statusCmp.comparison.candidate, undefined, "raw evidence values must not be echoed");
  });

  await test("SR.9 validate completes the run and records a confirmed finding", async () => {
    const val = await okCall("research_validate", {
      expected: "status:403", observed: "status:200", mode: "status",
      run_id: runId, record_outcome: true, outcome_label: "regression_confirmed",
      create_finding: { title: "Synthetic status regression", claim: "Status changed 403 -> 200", status: "confirmed" },
    });
    assert.strictEqual(val.validation.matched, false);
    assert.strictEqual(val.run.state, "completed");
    assert.strictEqual(val.finding.status, "confirmed");
  });

  await test("SR.10 evidence list (by run) / inspect (metadata only) / redact (derivative)", async () => {
    const list = await okCall("research_evidence", { action: "list", run_id: runId });
    assert.ok(list.evidence.length >= 2);
    const inspect = await okCall("research_evidence", { action: "inspect", references: [baselineRef] });
    assert.strictEqual(inspect.evidence[0].reference, baselineRef);
    assert.strictEqual(inspect.evidence[0].output, undefined, "inspect must not return raw evidence content");
    const evidenceId = baselineRef.replace("artifact:", "");
    const red = await okCall("research_evidence", { action: "redact", evidence_id: evidenceId });
    assert.strictEqual(red.evidence.redaction_state, "redacted");
    assert.strictEqual(red.evidence.supersedes, evidenceId);
  });

  await test("SR.11 report material is evidence-linked and written into the workspace", async () => {
    const findings = await okCall("research_report", { action: "list", campaign_id: campaignId });
    const rep = await okCall("research_report", {
      action: "materialize", campaign_id: campaignId, title: "Synthetic regression report", run_id: runId,
      summary: "A synthetic status regression was observed and validated.",
      claims: [{ statement: "Status changed from 403 to 200", disposition: "validated", evidence_refs: [candidateRef] }],
    });
    assert.ok(rep.report.report_id);
    assert.ok(rep.evidence_count >= 1);
    assert.ok(fs.existsSync(path.join(WORKSPACE, rep.material_storage_ref)));
    const got = await okCall("research_report", { action: "get", report_id: rep.report.report_id });
    assert.strictEqual(got.report.report_id, rep.report.report_id);
    void findings;
  });

  // --- scope enforcement + negative composition ------------------------------
  await test("SR.12 a scope-bound run enforces scope on its probes", async () => {
    const snap = await okCall("research_scope", { action: "create", project_id: PROJECT, targets: [{ kind: "host", value: "lab" }], rules: { allowed_operations: ["execute"] } });
    const camp = await okCall("research_project", { action: "create", project_id: PROJECT, name: "scoped campaign", scope_snapshot_id: snap.snapshot.snapshot_id });
    const hyp = await okCall("research_hypothesis", { action: "create", campaign_id: camp.campaign.campaign_id, title: "scoped", claim: "scoped probe" });
    const run = await okCall("research_run", { action: "plan", hypothesis_id: hyp.hypothesis.hypothesis_id, environment: { kind: "local", name: "lab" } });
    await okCall("research_run", { action: "start", run_id: run.run.run_id });
    const inScope = await call("research_probe", { run_id: run.run.run_id, probe: { type: "command", target: "lab", command: "printf ok" } });
    assert.strictEqual(inScope.isError, false, `in-scope probe should pass: ${JSON.stringify(inScope.j)}`);
    const outScope = await call("research_probe", { run_id: run.run.run_id, probe: { type: "command", target: "prod", command: "printf nope" } });
    assert.strictEqual(outScope.isError, true);
    assert.strictEqual(outScope.code, "scope_denied");
  });

  await test("SR.13 http probe to a non-allowlisted host is refused before any request", async () => {
    const planned = await okCall("research_run", { action: "plan", hypothesis_id: hypothesisId, environment: { kind: "remote", name: "ext" } });
    await okCall("research_run", { action: "start", run_id: planned.run.run_id });
    const denied = await call("research_probe", { run_id: planned.run.run_id, probe: { type: "http", url: "https://evil.test/x" } });
    assert.strictEqual(denied.isError, true);
    assert.strictEqual(denied.code, "scope_denied");
  });

  await test("SR.14 a run can be cancelled and evidence is preserved", async () => {
    const planned = await okCall("research_run", { action: "plan", hypothesis_id: hypothesisId, environment: { kind: "local", name: "lab" } });
    await okCall("research_run", { action: "start", run_id: planned.run.run_id });
    await okCall("research_probe", { run_id: planned.run.run_id, probe: { type: "command", target: "lab", command: "printf keep" } });
    const cancelled = await okCall("research_run", { action: "cancel", run_id: planned.run.run_id, reason: "no longer needed" });
    assert.strictEqual(cancelled.run.state, "cancelled");
    const ev = await okCall("research_evidence", { action: "list", run_id: planned.run.run_id });
    assert.ok(ev.evidence.length >= 1, "evidence should be preserved after cancel");
  });

  // --- workflows -------------------------------------------------------------
  await test("SR.15 source-regression workflow runs read-only and records a hypothesis", async () => {
    const repo = makeGitRepo();
    const run = await okCall("workflow", {
      action: "run", name: "security-research/source-regression",
      inputs: { repo_path: repo, baseline_ref: "v1", candidate_ref: "v2", campaign_id: campaignId, title: "status changed in service.txt", claim: "The synthetic service status line changed between v1 and v2" },
    });
    assert.strictEqual(run.owner, "pack:security-research");
    assert.ok(run.result && run.result.hypothesis, `workflow result should carry the hypothesis: ${JSON.stringify(run.result)}`);
  });

  await test("SR.16 version-regression-check workflow composes probes + compare", async () => {
    const planned = await okCall("research_run", { action: "plan", hypothesis_id: hypothesisId, environment: { kind: "local", name: "lab" } });
    await okCall("research_run", { action: "start", run_id: planned.run.run_id });
    const run = await okCall("workflow", {
      action: "run", name: "security-research/version-regression-check",
      inputs: {
        run_id: planned.run.run_id,
        baseline_probe: { name: "baseline", type: "command", target: "lab", command: "printf 'status:403'" },
        candidate_probe: { name: "candidate", type: "command", target: "lab", command: "printf 'status:200'" },
        compare_mode: "text",
      },
    });
    assert.strictEqual(run.owner, "pack:security-research");
    assert.ok(run.result && run.result.comparison, `workflow should return a comparison: ${JSON.stringify(run.result)}`);
    assert.strictEqual(run.result.comparison.changed, true);
  });

  // --- disposable lab composition (stub provider, offline) -------------------
  // The Proxmox pack is not installed in this test process, so we exercise the
  // composition seam by injecting a fake services.dispatch — proving lab.js
  // dispatches the right governed tool with the operator-supplied spec, records
  // provenance, and cleans up honestly, without any Proxmox or homelab details.
  await test("SR.17 lab provision composes proxmox_provision and records provenance", async () => {
    const planned = await okCall("research_run", {
      action: "plan", hypothesis_id: hypothesisId,
      environment: { kind: "proxmox", provider_profile: "lab-profile", provision: { action: "clone", clone: { source_vmid: 9000, newid: 9999, node: "pve-fixture" } } },
    });
    assert.strictEqual(planned.run.environment.kind, "proxmox");
    assert.deepStrictEqual(planned.run.environment.provision.clone, { source_vmid: 9000, newid: 9999, node: "pve-fixture" });
    const ctx = {
      root: WORKSPACE, config: {}, campaignId: planned.run.campaign_id, runId: planned.run.run_id,
      projectId: planned.run.project_id, executionId: planned.run.execution_id, environment: planned.run.environment,
      actor: "tester", timeoutMs: 5000,
    };
    let captured = null;
    const fake = { dispatch: async (name, a) => {
      captured = { name, a };
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "clone", profile: a.profile, vmid: a.clone.newid, node: a.clone.node, marker: "sk-run-fixture", outcome: "created" }) }] };
    } };
    const prov = await labLib.provision(fake, ctx, {});
    assert.strictEqual(captured.name, "proxmox_provision", "must dispatch the governed provider tool");
    assert.strictEqual(captured.a.profile, "lab-profile");
    assert.strictEqual(captured.a.action, "clone");
    assert.strictEqual(prov.resource_ref, "9999@lab-profile");
    assert.ok(prov.resource_artifact.startsWith("artifact:"));
    // Provenance is a custody artifact linked to the run's execution.
    const owned = labLib.ownedResources(ctx);
    assert.strictEqual(owned.length, 1);
    assert.strictEqual(owned[0].identity.vmid, 9999);
    // Save ctx for the cleanup test.
    global.__srLabCtx = ctx;
  });

  await test("SR.18 lab cleanup requests an authorized shutdown and reports deletion pending/manual", async () => {
    const ctx = global.__srLabCtx;
    let guestCall = null;
    const fake = { dispatch: async (name, a) => {
      guestCall = { name, a };
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "shutdown", outcome: "stopped" }) }] };
    } };
    const result = await labLib.cleanup(fake, ctx, {});
    assert.strictEqual(guestCall.name, "proxmox_guest");
    assert.strictEqual(guestCall.a.action, "shutdown");
    assert.strictEqual(result.cleanup, "pending_manual");
    assert.strictEqual(result.resources[0].deletion, "pending_manual");
    assert.strictEqual(result.resources[0].shutdown.ok, true);
  });

  await test("SR.19 lab composition fails closed: missing provider, provider refusal, non-proxmox env", async () => {
    const ctx = global.__srLabCtx;
    // Proxmox pack absent -> dependency_missing (never a silent shell fallback).
    const absent = { dispatch: async () => ({ content: [{ type: "text", text: "Unknown tool: proxmox_provision" }], isError: true, code: "unknown_tool" }) };
    await assert.rejects(labLib.provision(absent, ctx, {}), (e) => e.code === "dependency_missing");
    // Provider refuses (e.g. lifecycle disabled) -> policy_denied, not swallowed.
    const refused = { dispatch: async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, code: "lifecycle_disabled", error: "profile is read-only" }) }] }) };
    await assert.rejects(labLib.provision(refused, ctx, {}), (e) => e.code === "policy_denied");
    // A non-proxmox environment cannot provision a lab.
    const localCtx = { ...ctx, environment: { kind: "local", name: "lab" } };
    const never = { dispatch: async () => { throw new Error("should not dispatch"); } };
    await assert.rejects(labLib.provision(never, localCtx, {}), (e) => e.code === "unsupported_operation");
  });

  await test("SR.20 lab dry-run validates the provider without creating anything", async () => {
    const planned = await okCall("research_run", {
      action: "plan", hypothesis_id: hypothesisId,
      environment: { kind: "proxmox", provider_profile: "lab-profile", provision: { action: "clone", dry_run: true, clone: { source_vmid: 9000, newid: 9998, node: "pve-fixture" } } },
    });
    const ctx = {
      root: WORKSPACE, config: {}, campaignId: planned.run.campaign_id, runId: planned.run.run_id,
      projectId: planned.run.project_id, executionId: planned.run.execution_id, environment: planned.run.environment,
      actor: "tester", timeoutMs: 5000,
    };
    const fake = { dispatch: async (name, a) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, action: "clone", profile: a.profile, dry_run: true, explain: { operation: "clone", expected_effect: "would create vmid 9998" } }) }] }) };
    const prov = await labLib.provision(fake, ctx, {});
    assert.strictEqual(prov.dry_run, true);
    assert.strictEqual(prov.resource_ref, null);
    assert.strictEqual(labLib.ownedResources(ctx).length, 0, "dry-run must not record a resource");
  });

  await test("SR.21 provider_profile is authoritative over a stray provision.profile", async () => {
    const planned = await okCall("research_run", {
      action: "plan", hypothesis_id: hypothesisId,
      environment: { kind: "proxmox", provider_profile: "lab-profile", provision: { action: "clone", profile: "other-profile", clone: { source_vmid: 9000, newid: 9997, node: "pve-fixture" } } },
    });
    const ctx = {
      root: WORKSPACE, config: {}, campaignId: planned.run.campaign_id, runId: planned.run.run_id,
      projectId: planned.run.project_id, executionId: planned.run.execution_id, environment: planned.run.environment,
      actor: "tester", timeoutMs: 5000,
    };
    let dispatchedProfile = null;
    const fake = { dispatch: async (name, a) => {
      dispatchedProfile = a.profile;
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, vmid: a.clone.newid, node: a.clone.node, profile: a.profile, outcome: "created" }) }] };
    } };
    await labLib.provision(fake, ctx, {});
    assert.strictEqual(dispatchedProfile, "lab-profile", "provider_profile must win over a stray provision.profile");
  });

  await test("SR.22 cleanup reports shutdown_incomplete when a shutdown fails", async () => {
    const ctx = global.__srLabCtx;
    const failing = { dispatch: async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, code: "lifecycle_disabled" }) }], isError: true, code: "handler_error" }) };
    const result = await labLib.cleanup(failing, ctx, {});
    assert.strictEqual(result.cleanup, "shutdown_incomplete");
    assert.strictEqual(result.resources[0].shutdown.ok, false);
  });

  // cleanup
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  if (failures) { console.error(`\n${failures} security-research pack test(s) failed`); process.exit(1); }
  console.log("\nAll security-research pack tests passed");
  process.exit(0);
})().catch((e) => { console.error("security-research pack suite crashed:", e); process.exit(1); });
