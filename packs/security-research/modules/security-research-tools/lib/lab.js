"use strict";

/**
 * Disposable research lab composition.
 *
 * A run whose environment is `kind: "proxmox"` can provision a disposable guest
 * by composing the Proxmox pack's `proxmox_provision` tool, and later request
 * cleanup by composing `proxmox_guest`. This module expresses REQUIREMENTS and
 * dispatches through the governed module facade — it contains no Proxmox API
 * code, no `qm`/`pvesh`, no UPID parsing. Which lab (endpoint, profile, clone
 * spec) is supplied entirely by the operator at runtime through pack
 * configuration and the Proxmox pack's own profiles/secret references; none of
 * it lives in this repository.
 *
 * Two boundaries are deliberate:
 *   - Research intent confers no infrastructure privilege. The provision/cleanup
 *     calls go through `proxmox_provision`/`proxmox_guest`/`proxmox_retire`, which
 *     enforce their own profiles, destroy policy, protected-resource and
 *     provenance controls. This pack cannot say "this is research, therefore
 *     bypass them".
 */

const path = require("path");
const { kernel, labPolicy } = require("./platform");
const { ResearchError, classifyDispatchFailure } = require("./errors");
const workspace = require("./workspace");
const evidence = require("./evidence");

const LAB_RESOURCE_TYPE = "research-lab-resource";

function parseResult(result) {
  const text = result && result.content && result.content[0] ? result.content[0].text : "";
  let payload = {};
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  return payload;
}

function requireDispatchOk(result, whatFailed) {
  if (result && result.isError) {
    throw new ResearchError(classifyDispatchFailure(result.code), `${whatFailed}: ${result.code || "dispatch error"}`, { underlying_code: result.code || null });
  }
  const payload = parseResult(result);
  if (payload.ok === false) {
    // A structured provider refusal (e.g. protected_resource, lifecycle_disabled)
    // is surfaced as a policy denial, never swallowed.
    throw new ResearchError("policy_denied", `${whatFailed}: ${payload.code || payload.error || "provider refused"}`, { provider_code: payload.code || null });
  }
  return payload;
}

// Record the identity of a provisioned lab resource as a custody artifact linked
// to the run's execution, so cleanup can find exactly the workflow-owned
// resources and the provisioning is auditable. The resource identity, not any
// secret, is stored.
function recordResource(ctx, identity) {
  const dir = path.join(workspace.projectDir(ctx.root, ctx.campaignId), "labs");
  const filename = `lab-${workspace.safeSegment(String(identity.vmid), "vmid")}.json`;
  const abs = path.join(dir, filename);
  const buffer = Buffer.from(JSON.stringify(identity, null, 2), "utf8");
  workspace.atomicWrite(ctx.root, abs, buffer);
  const digest = evidence.sha256Hex(buffer);
  return kernel().registerArtifact({
    type: LAB_RESOURCE_TYPE,
    name: filename,
    project_id: ctx.projectId || undefined,
    execution_id: ctx.executionId || undefined,
    producer: "security-research",
    storage_ref: workspace.relToWorkspace(ctx.root, abs),
    content_type: "application/json",
    byte_size: buffer.length,
    content_hash: `sha256:${digest}`,
    retention_class: "standard",
    sensitivity: "sensitive",
    redaction_state: "none",
    lineage: { role: "original" },
    verification: { algorithm: "sha256", digest },
    metadata: { research_run_id: ctx.runId, campaign_id: ctx.campaignId, kind: "lab-resource", ...identity },
    source: "security-research",
  });
}

/**
 * Provision a disposable lab for a run whose environment is kind "proxmox".
 * Returns { resource_ref, vmid, node, marker, outcome, resource_artifact }.
 */
async function provision(services, ctx, runtime) {
  const env = ctx.environment || {};
  // PROVIDER-EXTRACTION POINT: this branch is the only place that embeds Proxmox-provider specifics (tool names, result fields, no-delete cleanup); when a second environment provider is added, split it into per-provider adapters and keep research_run provision/cleanup provider-agnostic.
  //
  // `disposable` and `proxmox` are both fulfilled by the Proxmox pack, as the
  // environment schema states. `disposable` additionally asserts the fixture
  // policy — isolated, no production access, fixture-or-no networking — which
  // was written and tested but had no caller, so the stricter kind was in
  // practice simply rejected rather than enforced.
  if (env.kind !== "proxmox" && env.kind !== "disposable") {
    throw new ResearchError("unsupported_operation", `lab provisioning is only implemented for a 'proxmox' or 'disposable' environment (got '${env.kind}')`);
  }
  if (env.kind === "disposable") {
    const decision = labPolicy().evaluateLabPolicy(env, { destructive: false });
    if (!decision.ok) {
      throw new ResearchError("policy_denied", `disposable lab policy denied: ${decision.reasons.join(", ")}`, { policy: decision.policy, reasons: decision.reasons });
    }
  }
  if (!env.provider_profile) {
    throw new ResearchError("environment_failed", "a proxmox environment requires provider_profile (the Proxmox pack profile name, configured at runtime)");
  }
  if (!env.provision || typeof env.provision !== "object" || !env.provision.action) {
    throw new ResearchError("environment_failed", "environment.provision must supply a proxmox_provision action and its parameters (e.g. { action: 'clone', clone: { source_vmid, newid, node } }); these are operator-supplied at runtime, never committed");
  }

  // Pass the operator-supplied provision spec straight through to the governed
  // Proxmox tool. The profile is injected LAST so provider_profile is
  // authoritative: a stray provision.profile cannot silently retarget the
  // dispatch or desync the run's audit trail. No Proxmox specifics are encoded
  // here; correlationId ties the provider's provenance marker to this run.
  const dryRun = env.provision.dry_run === true;
  const args = { ...env.provision, profile: env.provider_profile };
  const result = await services.dispatch("proxmox_provision", args, {
    signal: runtime && runtime.signal,
    timeoutMs: ctx.timeoutMs,
    correlationId: ctx.executionId || ctx.runId,
  });
  const payload = requireDispatchOk(result, "lab provisioning failed");

  // A dry-run validates auth/TLS/policy against the real provider without
  // creating anything. Short-circuit only when nothing was actually created (no
  // vmid); if the provider ignored dry_run and returned a vmid, fall through and
  // record it so a real guest is never left untracked.
  if ((dryRun || payload.dry_run === true) && !payload.vmid) {
    return { dry_run: true, plan: payload.explain || payload.plan || null, resource_ref: null };
  }

  if (!payload.vmid) {
    throw new ResearchError("ambiguous_state", "provisioning returned no vmid; the resource state is unknown and must not be assumed", { outcome: payload.outcome || null });
  }
  const identity = {
    provider: "proxmox",
    profile: payload.profile || env.provider_profile,
    vmid: payload.vmid,
    node: payload.node || null,
    marker: payload.marker || null,
    outcome: payload.outcome || null,
    provisioned_at: new Date().toISOString(),
  };
  const artifact = recordResource(ctx, identity);
  return {
    resource_ref: `${identity.vmid}@${identity.profile}`,
    vmid: identity.vmid,
    node: identity.node,
    marker: identity.marker,
    outcome: identity.outcome,
    resource_artifact: `artifact:${artifact.artifact_id}`,
  };
}

// Find the lab resources this run owns (custody artifacts on its execution).
function ownedResources(ctx) {
  if (!ctx.executionId) return [];
  const artifacts = kernel().listArtifacts({ execution_id: ctx.executionId, custody_role: "original", limit: 100 });
  return artifacts.filter((a) => a.type === LAB_RESOURCE_TYPE).map((a) => {
    let identity = {};
    try { identity = JSON.parse(workspace.readInside(ctx.root, path.join(ctx.root, a.storage_ref)).toString("utf8")); } catch {}
    return { artifact_id: a.artifact_id, identity };
  });
}

/**
 * Request cleanup of the run's workflow-owned lab resources. Performs an
 * authorized graceful shutdown, then consumes the Proxmox pack's guarded
 * retirement capability. Research code never issues a DELETE itself and
 * cannot bypass the provider's destroy policy or provenance checks.
 */
async function cleanup(services, ctx, runtime) {
  const resources = ownedResources(ctx);
  if (!resources.length) {
    return { cleanup: "nothing_to_clean", resources: [] };
  }
  const results = [];
  for (const resource of resources) {
    const { vmid, profile } = resource.identity;
    let shutdown = null;
    if (vmid && profile) {
      try {
        const res = await services.dispatch("proxmox_guest", { action: "shutdown", vmid, profile, wait: true }, { signal: runtime && runtime.signal, timeoutMs: ctx.timeoutMs });
        const payload = parseResult(res);
        shutdown = res.isError ? { ok: false, code: res.code || null } : { ok: payload.ok !== false, outcome: payload.outcome || null };
      } catch (error) {
        shutdown = { ok: false, error: error.message };
      }
    }
    results.push({
      resource_ref: vmid && profile ? `${vmid}@${profile}` : null,
      shutdown,
      deletion: "pending_manual",
    });
    if (shutdown && shutdown.ok && vmid && profile) {
      try {
        const res = await services.dispatch("proxmox_retire", {
          action: "retire", vmid, profile, dry_run: false, require_test: true, marker: resource.identity.marker,
        }, { signal: runtime && runtime.signal, timeoutMs: ctx.timeoutMs, correlationId: ctx.executionId || ctx.runId });
        const payload = parseResult(res);
        results[results.length - 1].deletion = res.isError ? "pending_manual" : (payload.outcome || "pending_manual");
        results[results.length - 1].deletion_code = res.isError ? (res.code || null) : (payload.code || null);
      } catch (error) {
        results[results.length - 1].deletion = "pending_manual";
        results[results.length - 1].deletion_error = error.message;
      }
    }
  }
  // Reflect partial failure in the aggregate so a caller keying on the top-level
  // field cannot over-read success: any failed shutdown makes it incomplete.
  const shutdownIncomplete = results.some((r) => r.shutdown && r.shutdown.ok === false);
  const deletionPending = results.some(r => r.deletion === "pending_manual" || r.deletion === "denied");
  return {
    cleanup: shutdownIncomplete ? "shutdown_incomplete" : deletionPending ? "pending_manual" : "completed",
    note: "Cleanup consumes the Proxmox pack's guarded retirement capability. If destruction is disabled, policy denies the request and cleanup remains pending_manual."
      + (shutdownIncomplete ? " One or more shutdowns did not complete — see resources[].shutdown." : ""),
    resources: results,
  };
}

module.exports = { provision, cleanup, ownedResources, LAB_RESOURCE_TYPE };
