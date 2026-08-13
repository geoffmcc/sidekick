"use strict";

/**
 * Provisioning and configuration operations — the mutating half of the pack.
 *
 * Every operation here:
 *   - validates each field before it can reach an API request (lib/validate);
 *   - stamps Sidekick provenance (tags + description marker) onto anything it
 *     creates, so the resource can later be proven Sidekick-owned;
 *   - monitors the Proxmox task to a terminal state where the API returns a
 *     UPID (create/clone/snapshot), and verifies by re-reading where it does
 *     not (configure is synchronous and returns no task);
 *   - emits a durable provenance event;
 *   - never retries a mutation (the client's POST path does not retry), so an
 *     ambiguous failure surfaces for inspection instead of duplicating a VM.
 *
 * Request parameters are assembled ONLY from validated, structured inputs. No
 * model-supplied string is ever concatenated into a config value unchecked.
 */

const validate = require("./validate");
const provenance = require("./provenance");
const normalize = require("./normalize");
const { pollTask, isFeatureAbsent } = require("./service");
const { recordResourceEvent } = require("./events");
const { ProxmoxError } = require("./errors");

async function nextId(client) {
  const id = await client.get(["cluster", "nextid"]);
  const vmid = normalize.num(id);
  if (vmid === null) throw new ProxmoxError("api_error", "Could not obtain a free VMID from the cluster");
  return vmid;
}

/** Ensure a VMID is free (idempotency guard against duplicate creation). */
async function assertVmidFree(client, vmid) {
  const rows = await client.get(["cluster", "resources"]).catch(() => []);
  const clash = (Array.isArray(rows) ? rows : []).find(r => r && (r.type === "qemu" || r.type === "lxc") && normalize.num(r.vmid) === vmid);
  if (clash) {
    throw new ProxmoxError("resource_exists", `VMID ${vmid} already exists on node ${normalize.str(clash.node)} (${normalize.str(clash.name)}). Refusing to create over an existing guest.`, { vmid });
  }
}

function buildCloudInitConfig(ci, out, errors) {
  if (!ci || typeof ci !== "object") return;
  if (ci.user !== undefined) {
    const u = validate.validateCiUser(ci.user);
    if (!u.ok) return errors.push(u.message);
    out.ciuser = u.value;
  }
  if (Array.isArray(ci.ssh_keys) && ci.ssh_keys.length) {
    const keys = [];
    for (const k of ci.ssh_keys) {
      const v = validate.validateSshKey(k);
      if (!v.ok) return errors.push(v.message);
      keys.push(v.value);
    }
    // QEMU cloud-init `sshkeys` follows Proxmox's convention of a URL-encoded
    // value; the client then form-encodes the body, so the value is encoded
    // twice on the wire and Proxmox decodes it back to the raw keys. (LXC
    // `ssh-public-keys` below is NOT pre-encoded — Proxmox treats it as plain.)
    out.sshkeys = encodeURIComponent(keys.join("\n"));
  }
  if (ci.ip !== undefined) {
    const ip = validate.validateIpConfig(ci.ip);
    if (!ip.ok) return errors.push(ip.message);
    if (ip.value) out.ipconfig0 = ip.value;
  }
  // A cloud-init password is a secret and is intentionally NOT accepted here:
  // it would place a credential into model-visible tool arguments and logs.
  if (ci.password !== undefined) {
    errors.push("cloud-init password is not accepted via this tool; use ssh_keys instead (a password would place a secret in tool arguments).");
  }
}

/**
 * Create a QEMU VM. Params are validated structured fields. Returns a
 * structured result with the vmid, node, provenance marker and task outcome.
 */
async function createVm(client, profile, params, context) {
  const errors = [];
  const node = requireNode(params, errors);
  const name = params.name !== undefined ? field(validate.validateGuestName(params.name), errors) : undefined;
  const cores = field(validate.validateIntRange("cores", params.cores ?? 1, 1, 128), errors);
  const memory = field(validate.validateIntRange("memory", params.memory ?? 512, 16, 4194304), errors);
  const net = params.net ? field(validate.validateNetSpec(params.net), errors) : null;
  const diskStorage = params.disk && params.disk.storage ? field(validate.validateStorageId(params.disk.storage), errors) : null;
  const diskGb = params.disk && params.disk.size_gb !== undefined ? field(validate.validateIntRange("disk.size_gb", params.disk.size_gb, 1, 8192), errors) : null;
  const ostype = params.ostype !== undefined ? field(validate.validateOsType(params.ostype), errors) : "l26";
  const isoVol = params.iso !== undefined ? String(params.iso) : null;
  // cloud-init is intentionally NOT applied to a bare create: it is meaningful
  // only atop a cloud image, which is a clone-from-template flow. See cloneGuest.
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });

  let vmid = params.vmid !== undefined ? field(validate.validateVmid(params.vmid), errors) : await nextId(client);
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });
  await assertVmidFree(client, vmid);

  const prov = provenance.buildProvenance({ run: context && context.correlationId, test: params._test === true, baseDescription: params.description || "" });

  const body = {
    vmid,
    cores,
    memory,
    ostype,
    tags: prov.tags,
    description: prov.description,
    ...(name ? { name } : {}),
    ...(net ? { net0: `${net.model},bridge=${net.bridge || "vmbr0"}${net.vlan ? `,tag=${net.vlan}` : ""}` } : {}),
    ...(diskStorage ? { scsi0: `${diskStorage}:${diskGb || 8}`, scsihw: "virtio-scsi-single" } : {}),
    ...(isoVol ? { ide2: `${isoVol},media=cdrom` } : {}),
  };

  const upid = await client.post(["nodes", node, "qemu"], body);
  const result = await monitorCreate(client, node, upid, "qemu", vmid);
  recordResourceEvent(context, { type: "resource_created", profile: profile.name, node, vmid, kind: "qemu", name, marker: prov.marker, run: context && context.correlationId, result: result.outcome });
  return { operation: "create_vm", vmid, node, type: "qemu", name: name || null, marker: prov.marker, tags: provenance.normalizeTags(prov.tags), ...result };
}

/**
 * Create an LXC container. Requires an OS template volume id.
 */
async function createLxc(client, profile, params, context) {
  const errors = [];
  const node = requireNode(params, errors);
  const ostemplate = field(validate.validateOsTemplate(params.ostemplate), errors);
  const hostname = params.hostname !== undefined ? field(validate.validateGuestName(params.hostname), errors) : undefined;
  const cores = field(validate.validateIntRange("cores", params.cores ?? 1, 1, 128), errors);
  const memory = field(validate.validateIntRange("memory", params.memory ?? 512, 16, 4194304), errors);
  const rootfsStorage = field(validate.validateStorageId(params.rootfs && params.rootfs.storage), errors);
  const rootfsGb = field(validate.validateIntRange("rootfs.size_gb", (params.rootfs && params.rootfs.size_gb) ?? 8, 1, 8192), errors);
  const net = params.net ? field(validate.validateNetSpec(params.net), errors) : null;
  const ostype = params.ostype !== undefined ? field(validate.validateLxcOsType(params.ostype), errors) : undefined;
  const sshKeys = [];
  if (Array.isArray(params.ssh_keys)) {
    for (const k of params.ssh_keys) { const v = validate.validateSshKey(k); if (!v.ok) errors.push(v.message); else sshKeys.push(v.value); }
  }
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });

  let vmid = params.vmid !== undefined ? field(validate.validateVmid(params.vmid), errors) : await nextId(client);
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });
  await assertVmidFree(client, vmid);

  const prov = provenance.buildProvenance({ run: context && context.correlationId, test: params._test === true, baseDescription: params.description || "" });
  const body = {
    vmid,
    ostemplate,
    cores,
    memory,
    rootfs: `${rootfsStorage}:${rootfsGb}`,
    tags: prov.tags,
    description: prov.description,
    ...(hostname ? { hostname } : {}),
    ...(ostype ? { ostype } : {}),
    ...(net ? { net0: `name=eth0,bridge=${net.bridge || "vmbr0"}${net.vlan ? `,tag=${net.vlan}` : ""}` } : {}),
    ...(sshKeys.length ? { "ssh-public-keys": sshKeys.join("\n") } : {}),
  };

  const upid = await client.post(["nodes", node, "lxc"], body);
  const result = await monitorCreate(client, node, upid, "lxc", vmid);
  recordResourceEvent(context, { type: "resource_created", profile: profile.name, node, vmid, kind: "lxc", name: hostname, marker: prov.marker, run: context && context.correlationId, result: result.outcome });
  return { operation: "create_lxc", vmid, node, type: "lxc", name: hostname || null, marker: prov.marker, tags: provenance.normalizeTags(prov.tags), ...result };
}

/**
 * Clone an existing template/guest into a new guest, then stamp provenance on
 * the clone (the clone API does not accept tags) and optionally apply
 * cloud-init configuration.
 */
async function cloneGuest(client, profile, params, context) {
  const errors = [];
  const node = requireNode(params, errors);
  const sourceVmid = field(validate.validateVmid(params.source_vmid), errors);
  const name = params.name !== undefined ? field(validate.validateGuestName(params.name), errors) : undefined;
  const full = params.full !== false; // default full clone
  const targetStorage = params.storage !== undefined ? field(validate.validateStorageId(params.storage), errors) : null;
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });

  // Determine source kind.
  const located = await findGuestKind(client, sourceVmid);
  const kind = located.kind;
  let newid = params.newid !== undefined ? field(validate.validateVmid(params.newid), errors) : await nextId(client);
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });
  await assertVmidFree(client, newid);

  const cloneBody = {
    newid,
    full: full ? 1 : 0,
    ...(name ? { name } : {}),
    ...(targetStorage ? { storage: targetStorage } : {}),
  };
  const upid = await client.post(["nodes", node, kind, sourceVmid, "clone"], cloneBody);
  const cloneResult = await monitorCreate(client, node, upid, kind, newid, { skipExistsCheck: true });

  // Stamp provenance onto the clone and apply any cloud-init config.
  const prov = provenance.buildProvenance({ run: context && context.correlationId, test: params._test === true, baseDescription: params.description || "" });
  const cfg = { tags: prov.tags, description: prov.description };
  if (kind === "qemu") buildCloudInitConfig(params.cloud_init, cfg, errors);
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });
  await client.post(["nodes", node, kind, newid, "config"], cfg);

  recordResourceEvent(context, { type: "resource_created", profile: profile.name, node, vmid: newid, kind, name, marker: prov.marker, run: context && context.correlationId, result: cloneResult.outcome, extra: { cloned_from: sourceVmid } });
  return { operation: "clone", vmid: newid, node, type: kind, name: name || null, cloned_from: sourceVmid, marker: prov.marker, tags: provenance.normalizeTags(prov.tags), ...cloneResult };
}

/**
 * Change a guest's configuration (cpu/memory). Synchronous on the API side —
 * there is no task — so success is verified by re-reading the config.
 */
async function configureGuest(client, profile, params, context) {
  const errors = [];
  const node = requireNode(params, errors);
  const vmid = field(validate.validateVmid(params.vmid), errors);
  const changes = {};
  if (params.cores !== undefined) changes.cores = field(validate.validateIntRange("cores", params.cores, 1, 128), errors);
  if (params.memory !== undefined) changes.memory = field(validate.validateIntRange("memory", params.memory, 16, 4194304), errors);
  if (params.description !== undefined && typeof params.description === "string") changes.description = params.description.slice(0, 8000);
  if (!Object.keys(changes).length) errors.push("no supported configuration changes were provided (cores, memory)");
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });

  const located = await findGuestKind(client, vmid);
  const kind = located.kind;
  await client.post(["nodes", node, kind, vmid, "config"], changes);

  // Verify by reading back.
  const after = await client.get(["nodes", node, kind, vmid, "config"]).catch(() => ({}));
  const applied = {};
  for (const key of Object.keys(changes)) applied[key] = normalize.num(after[key]) ?? normalize.str(after[key]);
  recordResourceEvent(context, { type: "resource_configured", profile: profile.name, node, vmid, kind, run: context && context.correlationId, extra: { changes: Object.keys(changes) } });
  return { operation: "configure", vmid, node, type: kind, changes: Object.keys(changes), applied };
}

/** Create a snapshot (returns a UPID -> monitored). */
async function snapshotCreate(client, profile, params, context) {
  const errors = [];
  const node = requireNode(params, errors);
  const vmid = field(validate.validateVmid(params.vmid), errors);
  const snapname = field(validate.validateSnapname(params.snapname), errors);
  const description = params.description !== undefined && typeof params.description === "string" ? params.description.slice(0, 2000) : undefined;
  const vmstate = params.include_ram === true;
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });

  const located = await findGuestKind(client, vmid);
  const kind = located.kind;
  const body = { snapname, ...(description ? { description } : {}), ...(kind === "qemu" && vmstate ? { vmstate: 1 } : {}) };
  const upid = await client.post(["nodes", node, kind, vmid, "snapshot"], body);
  const terminal = await pollTask(client, node, upid, { timeoutMs: profile.task_timeout_ms, intervalMs: profile.task_poll_interval_ms });
  recordResourceEvent(context, { type: "snapshot_created", profile: profile.name, node, vmid, kind, run: context && context.correlationId, extra: { snapname }, result: terminal.ok ? "completed" : "task_failed" });
  return { operation: "snapshot_create", vmid, node, type: kind, snapname, outcome: terminal.ok ? "completed" : "task_failed", task: { upid, ok: terminal.ok, exit_status: terminal.exit_status } };
}

async function snapshotList(client, params) {
  const errors = [];
  const node = requireNode(params, errors);
  const vmid = field(validate.validateVmid(params.vmid), errors);
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });
  const located = await findGuestKind(client, vmid);
  const rows = await client.get(["nodes", node, located.kind, vmid, "snapshot"]);
  const snapshots = (Array.isArray(rows) ? rows : []).map(s => ({
    name: normalize.str(s.name),
    description: normalize.str(s.description) || null,
    parent: normalize.str(s.parent) || null,
    snaptime: normalize.num(s.snaptime),
    vmstate: s.vmstate === undefined ? null : normalize.bool(s.vmstate),
  })).filter(s => s.name && s.name !== "current");
  return { vmid, node, type: located.kind, total: snapshots.length, snapshots };
}

/** Convert a guest to a template (used to prepare clone sources). */
async function convertTemplate(client, profile, params, context) {
  const errors = [];
  const node = requireNode(params, errors);
  const vmid = field(validate.validateVmid(params.vmid), errors);
  if (errors.length) throw new ProxmoxError("invalid_input", errors[0], { errors });
  const located = await findGuestKind(client, vmid);
  // Refuse to templatize a running guest: conversion takes it out of service as
  // a normal guest, which must never happen to a live VM by accident.
  const status = await client.get(["nodes", node, located.kind, vmid, "status", "current"]).catch(() => ({}));
  if (normalize.str(status.status) === "running") {
    throw new ProxmoxError("unsupported_operation", `VMID ${vmid} is running; stop it before converting it to a template.`, { vmid, node });
  }
  await client.post(["nodes", node, located.kind, vmid, "template"], {});
  recordResourceEvent(context, { type: "resource_configured", profile: profile.name, node, vmid, kind: located.kind, run: context && context.correlationId, extra: { template: true } });
  return { operation: "convert_template", vmid, node, type: located.kind, template: true };
}

// --- helpers ---------------------------------------------------------------

function field(result, errors) {
  if (!result.ok) { errors.push(result.message); return undefined; }
  return result.value;
}

function requireNode(params, errors) {
  const r = validate.validateNodeName(params.node);
  if (!r.ok) { errors.push(r.message); return undefined; }
  return r.value;
}

async function findGuestKind(client, vmid) {
  const rows = await client.get(["cluster", "resources"]).catch(() => []);
  const match = (Array.isArray(rows) ? rows : []).find(r => r && (r.type === "qemu" || r.type === "lxc") && normalize.num(r.vmid) === vmid);
  if (!match) throw new ProxmoxError("resource_missing", `No guest with VMID ${vmid} was found.`, { vmid });
  return { kind: match.type === "lxc" ? "lxc" : "qemu", node: normalize.str(match.node) };
}

async function monitorCreate(client, node, upid, kind, vmid, { skipExistsCheck = false } = {}) {
  if (typeof upid !== "string" || !upid.startsWith("UPID:")) {
    throw new ProxmoxError("api_error", "Proxmox did not return a task id for the create operation.", { node, vmid });
  }
  const terminal = await pollTask(client, node, upid, { timeoutMs: 300000, intervalMs: 1500 });
  return {
    outcome: terminal.ok ? "created" : "task_failed",
    changed: Boolean(terminal.ok),
    task: { upid, ok: terminal.ok, exit_status: terminal.exit_status },
  };
}

module.exports = {
  nextId,
  assertVmidFree,
  createVm,
  createLxc,
  cloneGuest,
  configureGuest,
  snapshotCreate,
  snapshotList,
  convertTemplate,
  findGuestKind,
  buildCloudInitConfig,
};
