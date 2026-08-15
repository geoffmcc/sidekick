"use strict";

/**
 * Storage preflight for library-state-affecting maintenance.
 *
 * Jellyfin's configured library paths prove nothing about CURRENT storage
 * availability: an unmounted NAS looks identical to an empty library, and a
 * scan against missing storage can mass-remove items. The preflight therefore
 * composes an INDEPENDENT evidence source through the module services facade
 * (`services.dispatch`, deny-by-default manifest permissions):
 *
 *   - storage_provider.type === "proxmox": the `proxmox` read tool's
 *     storage_status for the administrator-named node/storage backing the
 *     libraries — free space, active/enabled state.
 *   - storage_provider.type === "local" (Jellyfin runs on the Sidekick host):
 *     the `status` tool's disk section. That tool reports the host ROOT
 *     filesystem only, so the evidence granularity is stated honestly.
 *   - no provider configured: `not_verifiable` with the required capability
 *     named — never a bare "unknown", and never treated as safe.
 *
 * `safe_for_library_state_mutation` is DERIVED from evidence and is false for
 * anything other than a verified-ok state.
 */

const { JellyfinError } = require("./errors");

// Parse a facade dispatch result: {content:[{text}], isError?, code?}. The
// payload is treated as data; a malformed body degrades to null, never throws.
function parseDispatch(dispatched) {
  if (!dispatched || typeof dispatched !== "object") {
    return { ok: false, code: "empty_dispatch_result", data: null };
  }
  if (dispatched.isError || dispatched.code === "module_permission_denied") {
    const text =
      Array.isArray(dispatched.content) && dispatched.content[0]
        ? String(dispatched.content[0].text || "").slice(0, 300)
        : "";
    return { ok: false, code: dispatched.code || "dispatch_error", detail: text, data: null };
  }
  const text =
    Array.isArray(dispatched.content) && dispatched.content[0]
      ? String(dispatched.content[0].text || "")
      : "";
  try {
    return { ok: true, code: null, data: JSON.parse(text) };
  } catch {
    return { ok: false, code: "unparseable_dispatch_result", data: null };
  }
}

// "50G"/"512M"/"1.5T" -> approximate bytes (df -h human units). Approximate is
// fine: this feeds a coarse low-space guard, not accounting.
function humanToBytes(value) {
  const match = /^([\d.]+)\s*([KMGTP]?)i?B?$/i.exec(String(value || "").trim());
  if (!match) return null;
  const scale = { "": 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40, P: 2 ** 50 };
  const bytes = Number(match[1]) * scale[match[2].toUpperCase()];
  return Number.isFinite(bytes) ? Math.trunc(bytes) : null;
}

async function collectLibraries(client) {
  const raw = await client.get("/Library/VirtualFolders");
  const libraries = (Array.isArray(raw) ? raw : []).slice(0, 100).map((x) => ({
    id: x.ItemId || null,
    name: x.Name || null,
    locations: Array.isArray(x.Locations) ? x.Locations.slice(0, 20) : [],
  }));
  return { libraries, locations: libraries.flatMap((l) => l.locations) };
}

async function preflight({ services, client, profile }) {
  const { libraries, locations } = await collectLibraries(client);
  const base = {
    profile: profile.name,
    libraries,
    paths_checked: locations,
    checked_at: new Date().toISOString(),
  };
  const provider = profile.storage_provider;

  if (!provider) {
    return {
      ...base,
      state: "not_verifiable",
      safe_for_library_state_mutation: false,
      provider: null,
      reason: "no_storage_provider_configured",
      required_capability:
        'profile storage_provider ({type:"proxmox", profile, node, storage} or {type:"local"}) so availability can be established through a governed tool',
      evidence: { locations_configured: locations.length },
    };
  }

  if (typeof services?.dispatch !== "function") {
    // A facade without dispatch cannot compose evidence; fail closed rather
    // than pretending the provider was consulted.
    return {
      ...base,
      state: "not_verifiable",
      safe_for_library_state_mutation: false,
      provider: provider.type,
      reason: "dispatch_unavailable",
      evidence: {},
    };
  }

  const reasons = [];
  let evidence = {};

  if (provider.type === "proxmox") {
    const dispatched = await services.dispatch("proxmox", {
      action: "storage_status",
      profile: provider.profile,
      node: provider.node,
      storage: provider.storage,
    });
    const parsed = parseDispatch(dispatched);
    if (!parsed.ok || parsed.data?.ok === false) {
      return {
        ...base,
        state: "not_verifiable",
        safe_for_library_state_mutation: false,
        provider: "proxmox",
        reason: "storage_provider_error",
        provider_error: parsed.code || parsed.data?.code || "provider_reported_failure",
        evidence: { node: provider.node, storage: provider.storage },
      };
    }
    const s = parsed.data;
    evidence = {
      source: "proxmox storage_status",
      node: provider.node,
      storage: provider.storage,
      active: s.active ?? null,
      enabled: s.enabled ?? null,
      total_bytes: s.total_bytes ?? null,
      avail_bytes: s.avail_bytes ?? null,
      used_percent: s.used_fraction_pct ?? null,
    };
    if (s.active === false) reasons.push("storage_inactive");
    if (s.enabled === false) reasons.push("storage_disabled");
    if (evidence.avail_bytes === null) reasons.push("free_space_unknown");
    else if (evidence.avail_bytes < provider.min_free_bytes) reasons.push("low_free_space");
    if (evidence.used_percent !== null && evidence.used_percent >= provider.max_used_percent)
      reasons.push("high_utilization");
  } else if (provider.type === "local") {
    const dispatched = await services.dispatch("status", { include: "disk" });
    const parsed = parseDispatch(dispatched);
    const disk = parsed.ok ? parsed.data?.disk : null;
    if (!disk || disk.error || !disk.mount) {
      return {
        ...base,
        state: "not_verifiable",
        safe_for_library_state_mutation: false,
        provider: "local",
        reason: "storage_provider_error",
        provider_error: parsed.code || disk?.error || "no_disk_evidence",
        evidence: {},
      };
    }
    const availBytes = humanToBytes(disk.avail);
    const usedPercent = Number(String(disk.pct || "").replace("%", ""));
    evidence = {
      source: "status include=disk",
      mount: disk.mount,
      avail: disk.avail,
      avail_bytes_approx: availBytes,
      used_percent: Number.isFinite(usedPercent) ? usedPercent : null,
      // Honest granularity: the status tool reports the host root filesystem,
      // not per-location mounts. Library paths on other mounts are NOT
      // individually verified by this evidence.
      granularity: "host_root_filesystem_only",
      locations_not_individually_verified: locations,
    };
    if (availBytes === null) reasons.push("free_space_unknown");
    else if (availBytes < provider.min_free_bytes) reasons.push("low_free_space");
    if (evidence.used_percent !== null && evidence.used_percent >= provider.max_used_percent)
      reasons.push("high_utilization");
  } else {
    throw new JellyfinError("invalid_input", `unsupported storage_provider type "${provider.type}"`);
  }

  const unverifiable = reasons.includes("free_space_unknown");
  const state = unverifiable ? "not_verifiable" : reasons.length ? "unsafe" : "ok";
  return {
    ...base,
    state,
    safe_for_library_state_mutation: state === "ok",
    provider: provider.type,
    reasons,
    evidence,
    thresholds: {
      min_free_bytes: provider.min_free_bytes,
      max_used_percent: provider.max_used_percent,
    },
  };
}

module.exports = { preflight, parseDispatch, humanToBytes };
