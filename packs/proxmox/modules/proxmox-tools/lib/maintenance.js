"use strict";

// Read-only, deterministic maintenance preflight. Host update/reboot is not
// claimed here; this returns the facts and an explicit safety verdict for a
// later governed backend (Ansible or bounded SSH).

const normalize = require("./normalize");
const validate = require("./validate");
const { ProxmoxError } = require("./errors");
const migration = require("./migration");

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

// Build a read-only evacuation proposal for a node maintenance window. Each
// guest is assessed against online peers using the same per-guest migration
// resolver used by the explicit migration planner. This does not claim target
// capacity, shared-storage compatibility beyond the API facts, or application
// readiness, and never executes a migration.
async function plan(client, nodeValue) {
  const base = await preflight(client, nodeValue);
  const rows = await client.get(["nodes"]);
  const allTargets = (Array.isArray(rows) ? rows : [])
    .filter(row => normalize.str(row.node || row.name) !== base.node)
    .filter(row => normalize.str(row.status) === "online" || normalize.bool(row.online) === true)
    .map(row => normalize.str(row.node || row.name)).filter(Boolean).sort();
  const targets = allTargets.slice(0, 4);
  const guests = [];
  const assessedGuests = base.guests.list.slice(0, 25);
  for (const guest of assessedGuests) {
    const assessments = [];
    for (const target of targets) {
      try {
        const candidate = await migration.plan(client, guest.vmid, target);
        assessments.push({ target_node: target, feasible_by_api_facts: candidate.known_blockers.length === 0, mode: candidate.mode, storage: candidate.storage, blockers: candidate.known_blockers });
      } catch (error) {
        assessments.push({ target_node: target, feasible_by_api_facts: false, blockers: [String(error.message || error).slice(0, 240)] });
      }
    }
    guests.push({ vmid: guest.vmid, type: guest.type, name: guest.name, status: guest.status, ha_managed: guest.ha_managed, candidates: assessments });
  }
  const withoutTarget = guests.filter(guest => !guest.candidates.some(candidate => candidate.feasible_by_api_facts)).map(guest => guest.vmid);
  const blockers = [...base.blockers];
  if (targets.length === 0 && guests.length) blockers.push("no online peer node is available as a migration candidate");
  if (withoutTarget.length) blockers.push(`${withoutTarget.length} guest(s) have no candidate target based on the available API facts`);
  const omittedGuests = Math.max(0, base.guests.total - guests.length);
  if (omittedGuests || allTargets.length > targets.length) blockers.push("candidate assessment was capped; review the omitted guests or peer nodes before planning maintenance");
  return {
    ...base,
    guests: { total: base.guests.total, assessed: guests.length, omitted: omittedGuests, running: base.guests.running, list: guests },
    candidate_target_nodes: targets,
    omitted_candidate_target_nodes: Math.max(0, allTargets.length - targets.length),
    guests_without_candidate: withoutTarget,
    decision: blockers.length ? "blocked_or_review" : "plan_ready_for_operator_review",
    blockers,
    bounded: true,
    note: "Read-only evacuation proposal only. Candidate targets do not prove free capacity, workload health, backup recoverability, or application readiness. Review each migration_plan and use separately governed migration calls; no guest is moved here.",
  };
}

module.exports = { preflight, plan };
