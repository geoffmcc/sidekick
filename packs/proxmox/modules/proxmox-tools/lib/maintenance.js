"use strict";

// Read-only, deterministic maintenance preflight. Host update/reboot is not
// claimed here; this returns the facts and an explicit safety verdict for a
// later governed backend (Ansible or bounded SSH).

const normalize = require("./normalize");
const validate = require("./validate");
const { ProxmoxError } = require("./errors");

function nodeName(value) {
  const n = validate.validateNodeName(value);
  if (!n.ok) throw new ProxmoxError("invalid_input", n.message, { field: "node" });
  return n.value;
}

async function preflight(client, nodeValue) {
  const node = nodeName(nodeValue);
  const [clusterRows, nodes, resources, tasks, storage] = await Promise.all([
    client.get(["cluster", "status"]), client.get(["nodes"]), client.get(["cluster", "resources"]),
    client.get(["nodes", node, "tasks"], { limit: 100 }), client.get(["nodes", node, "storage"]),
  ]);
  const cluster = normalize.normalizeClusterStatus(clusterRows);
  const nodeRow = (Array.isArray(nodes) ? nodes : []).find(r => normalize.str(r.node || r.name) === node);
  const guests = (Array.isArray(resources) ? resources : []).filter(r => (r.type === "qemu" || r.type === "lxc") && normalize.str(r.node) === node).map(r => ({ vmid: normalize.num(r.vmid), type: r.type, name: normalize.str(r.name), status: normalize.str(r.status), ha_managed: Boolean(r.ha && (r.ha.managed === 1 || r.ha.managed === true)) }));
  const activeTasks = (Array.isArray(tasks) ? tasks : []).filter(t => normalize.str(t.status) === "running");
  const backupTasks = activeTasks.filter(t => /vzdump|backup/i.test(`${t.type || ""} ${t.id || ""}`));
  const migrationTasks = activeTasks.filter(t => /migrat/i.test(`${t.type || ""} ${t.id || ""}`));
  const replicationTasks = activeTasks.filter(t => /replicat/i.test(`${t.type || ""} ${t.id || ""}`));
  const blockers = [];
  if (!nodeRow || (normalize.str(nodeRow.status) !== "online" && normalize.bool(nodeRow.online) !== true)) blockers.push("target node is not online");
  if (cluster.mode === "cluster" && cluster.quorate !== true) blockers.push("cluster is not quorate");
  if (backupTasks.length) blockers.push("backup task is active");
  if (migrationTasks.length) blockers.push("migration task is active");
  if (replicationTasks.length) blockers.push("replication task is active");
  const localStorage = (Array.isArray(storage) ? storage : []).filter(s => s && (s.shared === 0 || s.shared === false));
  const decision = blockers.length ? "unsafe" : "safe_to_begin_preflight_only";
  return {
    node, cluster: { mode: cluster.mode, name: cluster.name, quorate: cluster.quorate, expected_nodes: cluster.expected_nodes, online_nodes: cluster.online_nodes },
    node_state: nodeRow ? { status: normalize.str(nodeRow.status), uptime_seconds: normalize.num(nodeRow.uptime) } : null,
    guests: { total: guests.length, running: guests.filter(g => g.status === "running").length, list: guests },
    ha: { managed_guests: guests.filter(g => g.ha_managed).length, state: guests.some(g => g.ha_managed) ? "present" : "not_detected" },
    tasks: { active: activeTasks.length, backups: backupTasks.length, migrations: migrationTasks.length, replications: replicationTasks.length },
    storage: { total: localStorage.length, local_or_node_bound: localStorage.map(s => normalize.str(s.storage)).filter(Boolean) },
    providers: { pve_api: "available", host_maintenance: "not_claimed_without_governed_backend" },
    decision, blockers, warning: "This is an API-only safety preflight. It does not update packages, reboot, or evacuate guests.",
  };
}

module.exports = { preflight };
