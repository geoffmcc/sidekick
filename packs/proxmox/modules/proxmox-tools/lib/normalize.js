"use strict";

/**
 * Normalization of raw Proxmox API responses into stable, bounded, model-facing
 * shapes.
 *
 * Two hard rules, both learned from real Proxmox hardware:
 *
 *  1. Every numeric field may arrive as a number OR a string, and every boolean
 *     may arrive as true/false/0/1/"0"/"1". The `num`/`bool` helpers tolerate
 *     all of these so the pack never reports 0 for a value that was actually
 *     present as a string.
 *
 *  2. A completed task's outcome lives in `exitstatus` on the task-status
 *     endpoint, while the list endpoint reports it in `status`. Conflating the
 *     two makes every finished task look like a failure. `taskOutcome` handles
 *     both and treats "WARNINGS:..." as success (vzdump commonly warns).
 *
 * Nothing here fabricates data: a field that is absent normalizes to null (or
 * an empty array), never to an invented default.
 */

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function bool(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0" || value === undefined || value === null || value === "") return false;
  return Boolean(value);
}

function str(value) {
  return value === undefined || value === null ? null : String(value);
}

function pct(used, total) {
  const u = num(used);
  const t = num(total);
  if (u === null || t === null || t <= 0) return null;
  return Math.round((u / t) * 10000) / 100; // two decimals
}

function normalizeVersion(data) {
  if (!data || typeof data !== "object") return null;
  return { version: str(data.version), release: str(data.release), repoid: str(data.repoid) };
}

// /cluster/status → { standalone|cluster, name, quorate, nodes[] }.
function normalizeClusterStatus(items) {
  const list = Array.isArray(items) ? items : [];
  const clusterEntry = list.find(entry => entry && entry.type === "cluster");
  const nodeEntries = list.filter(entry => entry && entry.type === "node");
  const nodes = nodeEntries.map(entry => ({
    name: str(entry.name),
    online: bool(entry.online),
    ip: str(entry.ip),
    local: bool(entry.local),
    node_id: str(entry.nodeid),
  }));
  if (clusterEntry) {
    return {
      mode: "cluster",
      name: str(clusterEntry.name),
      quorate: bool(clusterEntry.quorate),
      expected_nodes: num(clusterEntry.nodes),
      online_nodes: nodes.filter(n => n.online).length,
      nodes,
    };
  }
  return { mode: "standalone", name: null, quorate: null, expected_nodes: nodes.length || 1, online_nodes: nodes.filter(n => n.online).length, nodes };
}

function normalizeNode(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    node: str(entry.node),
    status: str(entry.status),
    cpu_fraction: num(entry.cpu),
    max_cpu: num(entry.maxcpu),
    mem_bytes: num(entry.mem),
    max_mem_bytes: num(entry.maxmem),
    disk_bytes: num(entry.disk),
    max_disk_bytes: num(entry.maxdisk),
    uptime_seconds: num(entry.uptime),
    level: str(entry.level) || null,
    ssl_fingerprint: str(entry.ssl_fingerprint),
  };
}

// Guest from /cluster/resources (type qemu|lxc) or /nodes/{node}/{qemu,lxc}.
function normalizeGuest(entry, kind) {
  if (!entry || typeof entry !== "object") return null;
  const type = kind || (entry.type === "lxc" ? "lxc" : entry.type === "qemu" ? "qemu" : null);
  return {
    vmid: num(entry.vmid),
    name: str(entry.name),
    type,
    status: str(entry.status),
    qmp_status: str(entry.qmpstatus),
    node: str(entry.node),
    template: bool(entry.template),
    cpus: num(entry.cpus) ?? num(entry.maxcpu),
    max_mem_bytes: num(entry.maxmem),
    mem_bytes: num(entry.mem),
    max_disk_bytes: num(entry.maxdisk),
    disk_bytes: num(entry.disk),
    uptime_seconds: num(entry.uptime),
    ha_managed: entry.ha && typeof entry.ha === "object" ? bool(entry.ha.managed) : null,
    lock: str(entry.lock) || null,
    tags: entry.tags ? String(entry.tags).split(/[;,\s]+/).filter(Boolean) : [],
  };
}

function normalizeStorage(entry) {
  if (!entry || typeof entry !== "object") return null;
  const total = num(entry.total) ?? num(entry.maxdisk);
  const used = num(entry.used) ?? num(entry.disk);
  // Backend type: a /cluster/resources row reports type="storage" and puts the
  // real backend in plugintype; a /storage or /nodes/*/storage row puts the
  // backend directly in type. Prefer the specific backend over the literal
  // "storage" marker.
  const backendType = entry.type && entry.type !== "storage" ? str(entry.type) : str(entry.plugintype);
  return {
    storage: str(entry.storage),
    type: backendType,
    node: str(entry.node),
    content: entry.content ? String(entry.content).split(",").map(s => s.trim()).filter(Boolean) : [],
    enabled: entry.enabled === undefined ? null : bool(entry.enabled),
    active: entry.active === undefined ? null : bool(entry.active),
    shared: entry.shared === undefined || entry.shared === null ? null : bool(entry.shared),
    total_bytes: total,
    used_bytes: used,
    avail_bytes: num(entry.avail),
    used_fraction_pct: entry.used_fraction !== undefined ? Math.round(num(entry.used_fraction) * 10000) / 100 : pct(used, total),
  };
}

// Terminal outcome of a task. Accepts a task-status object (has exitstatus) or a
// task-list row (outcome in status). Returns { running, ok, exitstatus }.
function taskOutcome(entry) {
  if (!entry || typeof entry !== "object") return { running: false, ok: null, exitstatus: null };
  const rawStatus = str(entry.status);
  const exit = entry.exitstatus !== undefined ? str(entry.exitstatus) : null;
  const running = rawStatus === "running";
  // exitstatus present → status field is running/stopped; outcome is exitstatus.
  // exitstatus absent (list row) → status field carries the outcome (OK/error).
  const outcome = exit !== null ? exit : running ? null : rawStatus;
  const ok = outcome === null ? null : /^OK$/.test(outcome) || /^WARNINGS:/.test(outcome);
  return { running, ok, exitstatus: outcome };
}

function normalizeTask(entry) {
  if (!entry || typeof entry !== "object") return null;
  const outcome = taskOutcome(entry);
  return {
    upid: str(entry.upid),
    type: str(entry.type),
    node: str(entry.node),
    user: str(entry.user),
    id: str(entry.id) || null,
    pid: num(entry.pid),
    start_time: num(entry.starttime),
    end_time: num(entry.endtime),
    running: outcome.running,
    ok: outcome.ok,
    exit_status: outcome.exitstatus,
  };
}

// Detect a cloud-init drive from a guest config: a volume whose id ends in
// "cloudinit", or the presence of cloud-init-only keys.
function detectCloudInit(config) {
  if (!config || typeof config !== "object") return false;
  for (const [key, value] of Object.entries(config)) {
    if (/^(ide|sata|scsi|virtio)\d+$/.test(key) && typeof value === "string" && /cloudinit/i.test(value)) return true;
    if (/^(ciuser|cipassword|ipconfig\d+|sshkeys|citype|cicustom)$/.test(key)) return true;
  }
  return false;
}

module.exports = {
  num,
  bool,
  str,
  pct,
  normalizeVersion,
  normalizeClusterStatus,
  normalizeNode,
  normalizeGuest,
  normalizeStorage,
  normalizeTask,
  taskOutcome,
  detectCloudInit,
};
