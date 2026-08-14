"use strict";

/**
 * Capability detection for a Proxmox profile.
 *
 * Produces a structured report that distinguishes the states the architecture
 * actually supports, rather than collapsing everything to a boolean:
 *
 *   reachable | unreachable | authenticated | auth_failed |
 *   detected  | not_detected | configured | not_configured |
 *   permission_limited | installed | not_installed | not_implemented
 *
 * Every probe degrades: an optional subsystem that is absent reports
 * `not_detected`, not an error, and a probe the token is not privileged for
 * reports `permission_limited` — never a false outage.
 */

const normalize = require("./normalize");
const providers = require("./providers");
const { isFeatureAbsent } = require("./service");
const { ProxmoxError } = require("./errors");

const GUEST_CONFIG_SCAN_CAP = 60;

async function probe(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof ProxmoxError) {
      if (error.code === "permission_denied") return { ok: false, state: "permission_limited", error };
      if (isFeatureAbsent(error)) return { ok: false, state: "not_detected", error };
      return { ok: false, state: "error", error };
    }
    throw error;
  }
}

async function detectCapabilities(client, profile, config = {}) {
  const report = {
    profile: profile.name,
    endpoint: profile.endpointParsed.value,
    tls: profile.ca_pem ? "pinned_ca" : "system_ca",
    operations: {
      guest_lifecycle: profile.allow_lifecycle ? "enabled" : "disabled_by_profile",
      provisioning: "enabled_via_governed_tool",
      migration: "available_same_cluster_api",
      maintenance_preflight: "available_via_pve_api",
      host_maintenance: "unavailable_without_governed_backend",
      destruction: config.allow_destroy === true ? "enabled_but_provenance_gated" : "disabled_by_administrator",
    },
  };

  // --- PVE API: reachable + authenticated -------------------------------
  const version = await probe(() => client.get(["version"]));
  if (version.ok) {
    report.api = { state: "authenticated", version: normalize.normalizeVersion(version.data) };
  } else if (version.error && version.error.code === "auth_failed") {
    report.api = { state: "auth_failed", detail: "reachable but the API token was rejected" };
    return report; // nothing else is knowable without auth
  } else if (version.error && ["dns_failure", "connection_refused", "connection_failed", "network_timeout", "tls_failure"].includes(version.error.code)) {
    report.api = { state: "unreachable", detail: version.error.code };
    return report;
  } else {
    report.api = { state: "error", detail: version.error ? version.error.code : "unknown" };
    return report;
  }

  // --- cluster / quorum -------------------------------------------------
  const clusterStatus = await probe(() => client.get(["cluster", "status"]));
  if (clusterStatus.ok) {
    const c = normalize.normalizeClusterStatus(clusterStatus.data);
    report.cluster = { mode: c.mode, name: c.name, quorate: c.quorate, expected_nodes: c.expected_nodes, online_nodes: c.online_nodes };
  } else {
    report.cluster = { mode: "unknown", state: clusterStatus.state };
  }

  // --- resources: storage types + guest inventory for scans -------------
  const resources = await probe(() => client.get(["cluster", "resources"]));
  const rows = resources.ok && Array.isArray(resources.data) ? resources.data : [];
  const storage = rows.filter(r => r && r.type === "storage").map(normalize.normalizeStorage).filter(Boolean);
  const storageTypes = [...new Set(storage.map(s => s.type).filter(Boolean))].sort();
  report.storage = { state: resources.ok ? "detected" : resources.state, types: storageTypes, count: storage.length };
  if (!resources.ok) report.storage.detail = "storage inventory unavailable (permission or API error)";

  // PBS as a Proxmox storage backend (detection only; direct PBS API deferred).
  report.pbs = { state: storageTypes.includes("pbs") ? "detected" : "not_detected", detail: "Detected as a Proxmox storage backend. Direct PBS datastore/verification queries are a future phase.", datastores: storageTypes.includes("pbs") ? storage.filter(s => s.type === "pbs").map(s => s.storage) : [] };

  // ZFS awareness is storage-type detection, never a hard dependency.
  report.zfs = { state: storageTypes.includes("zfspool") ? "detected" : "not_detected" };

  // --- Ceph -------------------------------------------------------------
  const ceph = await probe(() => client.get(["cluster", "ceph", "status"]));
  if (ceph.ok) {
    const health = ceph.data && ceph.data.health ? normalize.str(ceph.data.health.status) : null;
    report.ceph = { state: "detected", health };
  } else {
    report.ceph = { state: ceph.state === "permission_limited" ? "permission_limited" : "not_detected" };
  }

  // --- SDN --------------------------------------------------------------
  const sdn = await probe(() => client.get(["cluster", "sdn", "vnets"]));
  if (sdn.ok) {
    const count = Array.isArray(sdn.data) ? sdn.data.length : 0;
    report.sdn = { state: count > 0 ? "configured" : "not_configured", vnets: count };
  } else {
    report.sdn = { state: sdn.state === "permission_limited" ? "permission_limited" : "not_detected" };
  }

  // --- QEMU guest agent + cloud-init (bounded per-guest config scan) -----
  const qemuGuests = rows.filter(r => r && r.type === "qemu" && !normalize.bool(r.template));
  const scan = qemuGuests.slice(0, GUEST_CONFIG_SCAN_CAP);
  let agentConfigured = 0;
  let cloudInitGuests = 0;
  let scanErrors = 0;
  for (const g of scan) {
    const node = normalize.str(g.node);
    const vmid = normalize.num(g.vmid);
    if (!node || vmid === null) continue;
    const cfg = await probe(() => client.get(["nodes", node, "qemu", vmid, "config"]));
    if (!cfg.ok) { scanErrors++; continue; }
    if (normalize.bool(cfg.data.agent && String(cfg.data.agent).split(",")[0])) agentConfigured++;
    if (normalize.detectCloudInit(cfg.data)) cloudInitGuests++;
  }
  const templates = rows.filter(r => r && r.type === "qemu" && normalize.bool(r.template)).length;
  report.guest_agent = {
    state: agentConfigured > 0 ? "detected" : "not_detected",
    configured_guests: agentConfigured,
    scanned_guests: scan.length,
    total_qemu_guests: qemuGuests.length,
    truncated: qemuGuests.length > GUEST_CONFIG_SCAN_CAP,
    scan_errors: scanErrors,
    detail: "Per-guest reachability is only confirmed on demand via guest_status; this counts guests with the agent enabled in configuration.",
  };
  report.cloud_init = {
    state: cloudInitGuests > 0 || templates > 0 ? "detected" : "not_detected",
    guests_with_cloud_init: cloudInitGuests,
    qemu_templates: templates,
    detail: "Provisioning from templates/cloud-init is available through the governed proxmox_provision capability; this reports detected configuration only.",
  };

  // --- optional local automation providers ------------------------------
  report.automation = providers.detectAll(["ansible", "nodex", "ssh", "opentofu", "terraform"]);

  return report;
}

module.exports = { detectCapabilities };
