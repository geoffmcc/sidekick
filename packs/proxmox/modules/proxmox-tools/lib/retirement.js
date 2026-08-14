"use strict";

// Guarded retirement is intentionally a separate, critical tool. It performs
// a fresh lookup immediately before DELETE and requires both administrator
// enablement and positive Sidekick provenance. There is no force/bypass flag.

const validate = require("./validate");
const provision = require("./provision");
const provenance = require("./provenance");
const policy = require("./policy");
const { pollTask } = require("./service");
const { recordResourceEvent } = require("./events");
const { ProxmoxError } = require("./errors");

function requireVmid(value) {
  const v = validate.validateVmid(value);
  if (!v.ok) throw new ProxmoxError("invalid_input", v.message, { field: "vmid" });
  return v.value;
}

async function resolve(client, vmid) {
  const id = requireVmid(vmid);
  const located = await provision.findGuestKind(client, id);
  const config = await client.get(["nodes", located.node, located.kind, id, "config"]);
  const evidence = provenance.readProvenance(config);
  return { vmid: id, node: located.node, type: located.kind, name: config.name || config.hostname || null, tags: evidence.tags, protection: evidence.protection, evidence, config };
}

function decide(config, facts, { allowDestroy, requireTest = false, marker = null, matchers = [] } = {}) {
  if (allowDestroy !== true) return { result: "denied", reasons: ["administrator destroy policy is disabled"] };
  const base = policy.decide({ matchers, target: { ...facts, proxmox_protection: facts.protection }, provenance: facts.evidence, requireOwnership: true, blockIfProtected: true });
  if (base.result === "denied") return base;
  const ownership = provenance.checkOwnership(config, { requireManaged: true, requireTest, requireMarker: marker });
  return ownership.ok ? { result: "allowed", reasons: [] } : { result: "denied", reasons: [ownership.reason] };
}

async function retire(client, profile, params, context, signal) {
  const facts = await resolve(client, params.vmid);
  const decision = decide(facts.config, facts, { allowDestroy: params.allow_destroy, requireTest: params.require_test === true, marker: params.marker || null, matchers: params.protected_resources || [] });
  const explain = policy.explain({ operation: "delete", profile: profile.name, target: facts, decision, provenance: facts.evidence, expected_effect: `Delete ${facts.type} VMID ${facts.vmid} from ${facts.node}.` });
  if (decision.result === "denied") return { ok: false, outcome: "denied", code: "destruction_denied", explain };
  if (params.dry_run === true) return { ok: true, dry_run: true, outcome: "planned", explain };
  const upid = await client.delete(["nodes", facts.node, facts.type, facts.vmid]);
  if (typeof upid !== "string" || !upid.startsWith("UPID:")) throw new ProxmoxError("api_error", "Proxmox did not return a retirement task id.", { vmid: facts.vmid, node: facts.node });
  const terminal = await pollTask(client, facts.node, upid, { timeoutMs: profile.task_timeout_ms, intervalMs: profile.task_poll_interval_ms, signal });
  if (!terminal.ok) return { ok: false, outcome: "task_failed", explain, task: { upid, ok: false, exit_status: terminal.exit_status } };
  const stillThere = await provision.findGuestKind(client, facts.vmid).then(() => true).catch(e => e && e.code === "resource_missing" ? false : Promise.reject(e));
  if (stillThere) throw new ProxmoxError("reconciliation_required", "Retirement task completed but the guest still exists.", { vmid: facts.vmid, node: facts.node, upid });
  recordResourceEvent(context, { type: "resource_retired", profile: profile.name, node: facts.node, vmid: facts.vmid, kind: facts.type, name: facts.name, marker: facts.evidence.provenance && facts.evidence.provenance.marker, result: "completed", extra: { task: upid } });
  return { ok: true, outcome: "completed", explain, task: { upid, ok: true, exit_status: terminal.exit_status }, verified_absent: true };
}

module.exports = { resolve, decide, retire };
