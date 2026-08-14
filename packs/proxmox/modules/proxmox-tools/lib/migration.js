"use strict";

// Same-cluster guest migration. This module owns the resolved-facts and
// reconciliation boundary; the handler owns profile/policy and the dispatcher
// owns approval/audit. There is intentionally no cross-cluster path.

const validate = require("./validate");
const normalize = require("./normalize");
const operations = require("./operations");
const { pollTask } = require("./service");
const { ProxmoxError } = require("./errors");

function validNode(value, field) {
  const result = validate.validateNodeName(value);
  if (!result.ok) throw new ProxmoxError("invalid_input", result.message, { field });
  return result.value;
}

async function resolve(client, vmid, targetNode) {
  const located = await operations.findGuest(client, vmid);
  const target = validNode(targetNode, "target_node");
  const source = validNode(located.node, "source_node");
  if (source === target) throw new ProxmoxError("state_conflict", `VMID ${vmid} is already on target node ${target}.`, { vmid, source_node: source, target_node: target });

  const [nodes, resources, config] = await Promise.all([
    client.get(["nodes"]),
    client.get(["cluster", "resources"]),
    client.get(["nodes", source, located.type, vmid, "config"]),
  ]);
  const sourceRow = (Array.isArray(nodes) ? nodes : []).find(n => normalize.str(n.node) === source);
  const targetRow = (Array.isArray(nodes) ? nodes : []).find(n => normalize.str(n.node) === target);
  if (!sourceRow || normalize.str(sourceRow.status || sourceRow.online) !== "online" && normalize.bool(sourceRow.online) !== true) {
    throw new ProxmoxError("state_conflict", `Source node ${source} is not online.`, { source_node: source });
  }
  if (!targetRow || (normalize.str(targetRow.status) !== "online" && normalize.bool(targetRow.online) !== true)) {
    throw new ProxmoxError("state_conflict", `Target node ${target} is not online.`, { target_node: target });
  }
  const guest = (Array.isArray(resources) ? resources : []).find(r => r && normalize.num(r.vmid) === vmid && (r.type === "qemu" || r.type === "lxc"));
  if (!guest) throw new ProxmoxError("resource_missing", `VMID ${vmid} disappeared while resolving migration facts.`, { vmid });
  const status = normalize.str(guest.status) || "unknown";
  const storage = Object.entries(config || {}).filter(([key]) => /^(scsi|sata|virtio|ide|efidisk|tpmstate|rootfs|mp)\d*$/.test(key)).map(([, value]) => String(value));
  const localStorage = storage.filter(v => !/^(?:[^:]+):/.test(v) || /^(?:local|local-lvm|zfspool):/.test(v));
  return {
    vmid, type: located.type, source_node: source, target_node: target, status,
    running: status === "running", protection: config && (config.protection === 1 || config.protection === "1"),
    name: normalize.str(config && (config.name || config.hostname)),
    storage: { volumes: storage.length, local_volumes: localStorage.length, requires_local_storage_copy: localStorage.length > 0 },
  };
}

async function plan(client, vmid, targetNode) {
  const facts = await resolve(client, vmid, targetNode);
  return {
    ...facts,
    mode: facts.running ? "online" : "offline",
    same_cluster: true,
    cross_cluster: false,
    expected_effect: `Move ${facts.type} VMID ${facts.vmid} from ${facts.source_node} to ${facts.target_node}.`,
    known_blockers: facts.protection ? ["Proxmox protection flag is set"] : [],
  };
}

async function migrate(client, profile, vmid, targetNode, { online, wait = true, signal } = {}) {
  const facts = await resolve(client, vmid, targetNode);
  if (facts.protection) throw new ProxmoxError("protected_resource", `VMID ${vmid} has Proxmox protection enabled.`, facts);
  const useOnline = online === undefined ? facts.running : online === true;
  if (useOnline && !facts.running) throw new ProxmoxError("state_conflict", "Online migration was requested for a stopped guest; use offline migration.", facts);
  const params = { target: facts.target_node, online: useOnline ? 1 : 0 };
  if (facts.storage.requires_local_storage_copy) params["with-local-disks"] = 1;
  const upid = await client.post(["nodes", facts.source_node, facts.type, facts.vmid, "migrate"], params);
  if (typeof upid !== "string" || !upid.startsWith("UPID:")) throw new ProxmoxError("api_error", "Proxmox did not return a migration task id.", facts);
  if (!wait) return { operation: "migrate", ...facts, outcome: "submitted", monitored: false, task: { upid } };
  const terminal = await pollTask(client, facts.source_node, upid, { timeoutMs: profile.task_timeout_ms, intervalMs: profile.task_poll_interval_ms, signal });
  if (!terminal.ok) return { operation: "migrate", ...facts, outcome: "task_failed", monitored: true, task: { upid, ok: false, exit_status: terminal.exit_status } };
  const after = await operations.findGuest(client, facts.vmid).catch(() => null);
  if (!after || after.node !== facts.target_node) throw new ProxmoxError("reconciliation_required", "Migration task completed but the guest was not verified on the target node.", { ...facts, observed_node: after && after.node, upid });
  return { operation: "migrate", ...facts, outcome: "completed", monitored: true, task: { upid, ok: true, exit_status: terminal.exit_status }, final_node: after.node };
}

module.exports = { resolve, plan, migrate };
