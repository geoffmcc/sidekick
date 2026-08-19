"use strict";

/**
 * Read operations — the composite capabilities behind the read tool.
 *
 * Each function issues a small, bounded set of Proxmox API calls and returns a
 * NORMALIZED structured view, never a raw API payload. The model receives
 * enough to reason and to name a follow-up target (vmid, node, storage, upid),
 * without megabytes of irrelevant fields.
 *
 * `/cluster/resources` is the workhorse for inventory: one call yields nodes,
 * guests and storage, and it works on a standalone node too. Per-node fan-out
 * is only used where the cluster view lacks detail.
 */

const normalize = require("./normalize");
const { isFeatureAbsent } = require("./service");
const { ProxmoxError } = require("./errors");
const validate = require("./validate");

async function clusterResources(client) {
  const rows = await client.get(["cluster", "resources"]);
  return Array.isArray(rows) ? rows : [];
}

/** Locate a guest's node and kind from its vmid via the cluster resource view. */
async function findGuest(client, vmid) {
  const rows = await clusterResources(client);
  const match = rows.find(r => r && (r.type === "qemu" || r.type === "lxc") && normalize.num(r.vmid) === vmid);
  if (!match) throw new ProxmoxError("resource_missing", `No guest with VMID ${vmid} was found in this environment.`, { vmid });
  return { node: normalize.str(match.node), type: match.type === "lxc" ? "lxc" : "qemu", resource: match };
}

async function clusterSummary(client) {
  const [version, statusRows, resources] = await Promise.all([
    client.get(["version"]).catch(() => null),
    client.get(["cluster", "status"]).catch(() => null),
    clusterResources(client).catch(() => []),
  ]);

  const cluster = normalize.normalizeClusterStatus(statusRows);
  const nodes = resources.filter(r => r && r.type === "node").map(normalize.normalizeNode).filter(Boolean);
  const guests = resources.filter(r => r && (r.type === "qemu" || r.type === "lxc")).map(r => normalize.normalizeGuest(r));
  const storage = resources.filter(r => r && r.type === "storage").map(normalize.normalizeStorage).filter(Boolean);

  const guestCounts = { qemu: 0, lxc: 0, running: 0, stopped: 0, templates: 0 };
  for (const g of guests) {
    if (g.type === "qemu") guestCounts.qemu++;
    if (g.type === "lxc") guestCounts.lxc++;
    if (g.template) guestCounts.templates++;
    else if (g.status === "running") guestCounts.running++;
    else guestCounts.stopped++;
  }

  const storageTypes = [...new Set(storage.map(s => s.type).filter(Boolean))].sort();

  return {
    version: normalize.normalizeVersion(version),
    cluster: { mode: cluster.mode, name: cluster.name, quorate: cluster.quorate, expected_nodes: cluster.expected_nodes, online_nodes: cluster.online_nodes },
    nodes: {
      total: nodes.length,
      online: nodes.filter(n => n.status === "online").length,
      list: nodes.map(n => ({ node: n.node, status: n.status, cpu_fraction: n.cpu_fraction, max_cpu: n.max_cpu, mem_bytes: n.mem_bytes, max_mem_bytes: n.max_mem_bytes, uptime_seconds: n.uptime_seconds })),
    },
    guests: guestCounts,
    storage: { total: storage.length, types: storageTypes },
  };
}

async function listNodes(client) {
  const rows = await client.get(["nodes"]);
  return { nodes: (Array.isArray(rows) ? rows : []).map(normalize.normalizeNode).filter(Boolean).sort((a, b) => String(a.node).localeCompare(String(b.node))) };
}

async function nodeStatus(client, node) {
  const data = await client.get(["nodes", node, "status"]);
  if (!data || typeof data !== "object") throw new ProxmoxError("response_invalid", "Unexpected node status response");
  const mem = data.memory || {};
  const root = data.rootfs || {};
  const load = Array.isArray(data.loadavg) ? data.loadavg.map(normalize.num) : [];
  return {
    node,
    uptime_seconds: normalize.num(data.uptime),
    pve_version: normalize.str(data.pveversion),
    kernel: normalize.str(data["current-kernel"] && data["current-kernel"].release) || normalize.str(data.kversion),
    cpu_fraction: normalize.num(data.cpu),
    cpu_count: normalize.num(data.cpuinfo && data.cpuinfo.cpus),
    load_average: load,
    memory: { used_bytes: normalize.num(mem.used), total_bytes: normalize.num(mem.total), used_fraction_pct: normalize.pct(mem.used, mem.total) },
    rootfs: { used_bytes: normalize.num(root.used), total_bytes: normalize.num(root.total), used_fraction_pct: normalize.pct(root.used, root.total) },
  };
}

async function listGuests(client, { node, type } = {}) {
  const rows = await clusterResources(client);
  let guests = rows.filter(r => r && (r.type === "qemu" || r.type === "lxc")).map(r => normalize.normalizeGuest(r)).filter(Boolean);
  if (node) guests = guests.filter(g => g.node === node);
  if (type === "qemu" || type === "lxc") guests = guests.filter(g => g.type === type);
  guests.sort((a, b) => (a.vmid || 0) - (b.vmid || 0));
  return {
    total: guests.length,
    filtered_by: { node: node || null, type: type || null },
    guests: guests.map(g => ({ vmid: g.vmid, name: g.name, type: g.type, status: g.status, node: g.node, template: g.template, cpus: g.cpus, max_mem_bytes: g.max_mem_bytes, uptime_seconds: g.uptime_seconds, tags: g.tags })),
    note: "An empty or short list can also result from an API token whose privileges filter /cluster/resources. Verify the token has VM.Audit where guests are expected.",
  };
}

async function guestStatus(client, { vmid, node: hintNode }) {
  const located = hintNode ? { node: hintNode, type: null } : await findGuest(client, vmid);
  const node = located.node;
  // Determine kind if not known: try qemu then lxc.
  let kind = located.type;
  let status;
  if (kind) {
    status = await client.get(["nodes", node, kind, vmid, "status", "current"]);
  } else {
    try {
      status = await client.get(["nodes", node, "qemu", vmid, "status", "current"]);
      kind = "qemu";
    } catch (e) {
      if (e instanceof ProxmoxError && e.code === "resource_missing") {
        status = await client.get(["nodes", node, "lxc", vmid, "status", "current"]);
        kind = "lxc";
      } else throw e;
    }
  }

  const guest = normalize.normalizeGuest({ ...status, vmid, node, type: kind }, kind);
  const config = await client.get(["nodes", node, kind, vmid, "config"]).catch(() => ({}));
  const cloudInit = normalize.detectCloudInit(config);
  const agentEnabled = kind === "qemu" ? normalize.bool(config.agent && String(config.agent).split(",")[0]) : false;

  const result = {
    vmid,
    node,
    type: kind,
    name: guest.name || normalize.str(config.name),
    status: guest.status,
    qmp_status: guest.qmp_status,
    cpus: guest.cpus,
    max_mem_bytes: guest.max_mem_bytes,
    mem_bytes: guest.mem_bytes,
    uptime_seconds: guest.uptime_seconds,
    ha_managed: guest.ha_managed,
    lock: guest.lock,
    template: guest.template,
    cloud_init: { configured: cloudInit },
    guest_agent: { configured: agentEnabled, reachable: false, state: agentEnabled ? "configured" : "not_configured" },
  };

  // Enrich from the guest agent only when it is configured AND the guest is
  // running; degrade gracefully when the agent is absent or unreachable.
  if (agentEnabled && guest.status === "running") {
    try {
      const osinfo = await client.get(["nodes", node, "qemu", vmid, "agent", "get-osinfo"]);
      const info = osinfo && osinfo.result ? osinfo.result : osinfo;
      result.guest_agent.reachable = true;
      result.guest_agent.state = "reachable";
      result.guest_agent.os = { name: normalize.str(info && info.name), version: normalize.str(info && (info["version-id"] || info.version)), kernel: normalize.str(info && info["kernel-release"]) };
    } catch (e) {
      if (!isFeatureAbsent(e)) throw e;
      result.guest_agent.state = "unreachable";
    }
    try {
      const ifaces = await client.get(["nodes", node, "qemu", vmid, "agent", "network-get-interfaces"]);
      const list = ifaces && ifaces.result ? ifaces.result : [];
      const addresses = [];
      for (const iface of Array.isArray(list) ? list : []) {
        if (iface && iface.name === "lo") continue;
        for (const addr of (iface && iface["ip-addresses"]) || []) {
          if (addr && addr["ip-address"] && !/^127\.|^::1$|^fe80:/i.test(addr["ip-address"])) addresses.push(normalize.str(addr["ip-address"]));
        }
      }
      result.guest_agent.reachable = true;
      if (result.guest_agent.state !== "reachable") result.guest_agent.state = "reachable";
      result.guest_agent.ip_addresses = [...new Set(addresses)];
    } catch (e) {
      if (!isFeatureAbsent(e)) throw e;
    }
  }
  return result;
}

async function listStorage(client, { node } = {}) {
  const rows = node ? await client.get(["nodes", node, "storage"]) : await client.get(["storage"]);
  const storage = (Array.isArray(rows) ? rows : []).map(s => normalize.normalizeStorage({ ...s, node: s.node || node || null })).filter(Boolean);
  storage.sort((a, b) => String(a.storage).localeCompare(String(b.storage)));
  return { total: storage.length, scope: node ? { node } : { scope: "cluster" }, types: [...new Set(storage.map(s => s.type).filter(Boolean))].sort(), storage };
}

async function storageStatus(client, { node, storage }) {
  const data = await client.get(["nodes", node, "storage", storage, "status"]);
  const normalized = normalize.normalizeStorage({ ...data, storage, node });
  return { node, ...normalized };
}

async function listTasks(client, { node, limit = 50, errors = false } = {}) {
  const params = { limit: Math.min(Math.max(1, limit), 500) };
  if (errors) params.errors = 1;
  let nodes = [];
  if (node) nodes = [node];
  else {
    const nodeRows = await client.get(["nodes"]).catch(() => []);
    nodes = (Array.isArray(nodeRows) ? nodeRows : []).map(n => normalize.str(n.node)).filter(Boolean);
  }
  const collected = [];
  for (const n of nodes.slice(0, 16)) {
    const rows = await client.get(["nodes", n, "tasks"], params).catch(() => []);
    for (const row of Array.isArray(rows) ? rows : []) collected.push(normalize.normalizeTask(row));
  }
  collected.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
  return { total: collected.length, scope: node ? { node } : { scope: "cluster", nodes: nodes.length }, errors_only: Boolean(errors), tasks: collected.slice(0, limit) };
}

async function taskStatus(client, { upid, node }) {
  const parsed = validate.parseUpid(upid);
  const targetNode = node || (parsed.ok ? parsed.node : null);
  if (!targetNode) throw new ProxmoxError("invalid_input", "Could not determine the task's node; supply node explicitly.");
  const data = await client.get(["nodes", targetNode, "tasks", upid, "status"]);
  const outcome = normalize.taskOutcome(data);
  return {
    upid,
    node: targetNode,
    type: normalize.str(data.type),
    user: normalize.str(data.user),
    running: outcome.running,
    ok: outcome.ok,
    exit_status: outcome.exitstatus,
    start_time: normalize.num(data.starttime),
  };
}

async function backupStatus(client) {
  // PVE-side backup awareness WITHOUT requiring PBS credentials: scheduled
  // vzdump jobs plus the most recent backup task outcomes.
  const jobs = await client.get(["cluster", "backup"]).catch(() => []);
  const jobList = (Array.isArray(jobs) ? jobs : []).map(j => ({
    id: normalize.str(j.id),
    enabled: j.enabled === undefined ? null : normalize.bool(j.enabled),
    schedule: normalize.str(j.schedule) || normalize.str(j.starttime),
    storage: normalize.str(j.storage),
    node: normalize.str(j.node),
    selection: normalize.str(j.vmid) || normalize.str(j.pool) || (normalize.bool(j.all) ? "all" : null),
    mode: normalize.str(j.mode),
  }));

  const nodeRows = await client.get(["nodes"]).catch(() => []);
  const nodes = (Array.isArray(nodeRows) ? nodeRows : []).map(n => normalize.str(n.node)).filter(Boolean);
  const recent = [];
  for (const n of nodes.slice(0, 16)) {
    const rows = await client.get(["nodes", n, "tasks"], { typefilter: "vzdump", limit: 20 }).catch(() => []);
    for (const row of Array.isArray(rows) ? rows : []) recent.push(normalize.normalizeTask(row));
  }
  recent.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
  const failures = recent.filter(t => t.ok === false).slice(0, 10);

  return {
    jobs: { total: jobList.length, list: jobList },
    recent_backups: { total: recent.length, failures: failures.length, most_recent: recent.slice(0, 10) },
    note: "This reflects Proxmox-side (vzdump) backup configuration and task history. Direct Proxmox Backup Server datastore/verification queries are not part of this release.",
  };
}

async function versionStatus(client) {
  const version = await client.get(["version"]);
  return { version: normalize.normalizeVersion(version) };
}

async function clusterHealth(client) {
  const summary = await clusterSummary(client);
  const failedTasks = await listTasks(client, { errors: true, limit: 20 });
  const blockers = [];
  if (summary.cluster.quorate === false) blockers.push({ code: "cluster_not_quorate", detail: "Proxmox reports the cluster is not quorate." });
  if (summary.nodes.online < summary.nodes.total) blockers.push({ code: "nodes_offline", detail: `${summary.nodes.total - summary.nodes.online} node(s) are not online.` });
  if (failedTasks.total > 0) blockers.push({ code: "failed_tasks", detail: `${failedTasks.total} failed task(s) were returned by the bounded task query.` });
  return {
    status: blockers.length ? "attention" : "healthy",
    cluster: summary.cluster,
    nodes: summary.nodes,
    guests: summary.guests,
    storage: summary.storage,
    failed_tasks: failedTasks,
    blockers,
    bounded: true,
    note: "Health is derived from current cluster, resource and bounded task evidence; it does not prove guest application health.",
  };
}

async function storageCapacity(client) {
  const inventory = await listStorage(client);
  const totals = inventory.storage.reduce((acc, storage) => {
    if (storage.total_bytes !== null) acc.total_bytes += storage.total_bytes;
    if (storage.used_bytes !== null) acc.used_bytes += storage.used_bytes;
    if (storage.avail_bytes !== null) acc.avail_bytes += storage.avail_bytes;
    if (storage.total_bytes !== null) acc.capacity_sources++;
    if (storage.active === false || storage.enabled === false) acc.inactive++;
    return acc;
  }, { total_bytes: 0, used_bytes: 0, avail_bytes: 0, capacity_sources: 0, inactive: 0 });
  return {
    scope: inventory.scope,
    total: inventory.total,
    totals: {
      total_bytes: totals.capacity_sources ? totals.total_bytes : null,
      used_bytes: totals.capacity_sources ? totals.used_bytes : null,
      avail_bytes: totals.capacity_sources ? totals.avail_bytes : null,
      used_fraction_pct: totals.capacity_sources && totals.total_bytes > 0 ? normalize.pct(totals.used_bytes, totals.total_bytes) : null,
    },
    inactive_storage_count: totals.inactive,
    storage: inventory.storage,
    bounded: true,
    note: "Capacity is returned only when the Proxmox endpoint supplies total/used/available bytes; no filesystem or PBS datastore inference is performed.",
  };
}

async function upgradeReadiness(client) {
  const [version, health, backup] = await Promise.all([
    versionStatus(client),
    clusterHealth(client),
    backupStatus(client),
  ]);
  const blockers = [...health.blockers];
  if (backup.recent_backups.failures > 0) blockers.push({ code: "recent_backup_failures", detail: `${backup.recent_backups.failures} recent backup task(s) failed.` });
  const backupEvidence = backup.jobs.total > 0 || backup.recent_backups.total > 0;
  if (!backupEvidence) blockers.push({ code: "backup_evidence_missing", detail: "No Proxmox-side backup jobs or recent vzdump tasks were returned." });
  return {
    status: blockers.length ? "blocked_or_review" : "ready_for_review",
    version: version.version,
    cluster_health: health,
    backup_status: backup,
    blockers,
    bounded: true,
    note: "Readiness is an evidence-based preflight, not an approval or a claim that an upgrade is safe for every guest workload.",
  };
}

module.exports = {
  findGuest,
  clusterSummary,
  listNodes,
  nodeStatus,
  listGuests,
  guestStatus,
  listStorage,
  storageStatus,
  listTasks,
  taskStatus,
  backupStatus,
  versionStatus,
  clusterHealth,
  storageCapacity,
  upgradeReadiness,
};
