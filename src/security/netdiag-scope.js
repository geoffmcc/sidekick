"use strict";

const dns = require("node:dns").promises;
const net = require("node:net");
const networkPolicy = require("./network-scope");
const { isLinkLocal, isMetadataAddress, isPrivateAddress } = require("./ip-address-policy");

function normalizeTarget(target) {
  const value = String(target || "").trim();
  const ipVersion = net.isIP(value);
  if (ipVersion) {
    const parsed = networkPolicy.parseAddress(value, "target");
    return { host: parsed.text, address: parsed.text, family: net.isIP(parsed.text) };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error("host-form diagnostics require a hostname or IP, not a URL");
  const hostname = networkPolicy.normalizePattern(value);
  if (hostname.startsWith("*.")) throw new Error("target must be a hostname or IP, not a wildcard");
  return { host: hostname, address: null, family: 0 };
}

async function authorizeNetDiagTarget({ target, probes, networkScope, networkScopeRevision } = {}, dependencies = {}) {
  const lookup = dependencies.lookup || dns.lookup;
  let normalized;
  try { normalized = normalizeTarget(target); }
  catch (error) { return { ok: false, code: "invalid_target", reason: error.message }; }
  if (isMetadataAddress(normalized.host) || isLinkLocal(normalized.host) || networkPolicy.permanentDenial(normalized.host)) {
    return { ok: false, code: "outbound_target_denied", reason: "target is a permanently denied local or metadata destination" };
  }

  let scope = null;
  if (networkScope) {
    const scopeGetter = dependencies.getScope || ((...args) => require("./network-scopes").get(...args));
    if (!Number.isSafeInteger(networkScopeRevision) || networkScopeRevision < 1) {
      return { ok: false, code: "network_scope_revision_required", reason: "a named network scope requires its current revision" };
    }
    scope = scopeGetter(networkScope, networkScopeRevision);
    if (!scope || !scope.enabled || scope.is_current !== true) {
      return { ok: false, code: "network_scope_unavailable", reason: "the named network scope revision is unavailable or no longer current" };
    }
  }

  let records;
  if (normalized.address) records = [{ address: normalized.address, family: normalized.family }];
  else {
    try { records = await lookup(normalized.host, { all: true, verbatim: true }); }
    catch (error) { return { ok: false, code: "dns_resolution_failed", reason: `target DNS lookup failed (${String(error.code || "lookup error").slice(0, 40)})` }; }
  }
  if (!Array.isArray(records) || records.length === 0) return { ok: false, code: "dns_resolution_failed", reason: "target DNS lookup returned no addresses" };
  if (records.length > 32) return { ok: false, code: "dns_resolution_failed", reason: "target DNS lookup returned too many addresses" };

  const unique = new Map();
  for (const record of records) {
    const address = String(record?.address || "").toLowerCase();
    const recordFamily = net.isIP(address);
    if (!recordFamily || (record.family && Number(record.family) !== recordFamily)) return { ok: false, code: "dns_resolution_failed", reason: "target DNS lookup returned an invalid address" };
    let parsed;
    try { parsed = networkPolicy.parseAddress(address, "resolved target"); }
    catch { return { ok: false, code: "dns_resolution_failed", reason: "target DNS lookup returned an invalid address" }; }
    const canonicalAddress = parsed.text;
    const family = net.isIP(canonicalAddress);
    unique.set(canonicalAddress, { address: canonicalAddress, family });
  }
  records = [...unique.values()];

  // DNS lookup can take time while an administrator revises or disables the
  // scope. Re-read the exact revision after resolution so a stale authority
  // snapshot cannot authorize the subsequently pinned probe.
  if (networkScope) {
    const scopeGetter = dependencies.getScope || ((...args) => require("./network-scopes").get(...args));
    scope = scopeGetter(networkScope, networkScopeRevision);
    if (!scope || !scope.enabled || scope.is_current !== true) {
      return { ok: false, code: "network_scope_unavailable", reason: "the named network scope changed or was disabled during target resolution" };
    }
  }

  for (const record of records) {
    if (isMetadataAddress(record.address) || isLinkLocal(record.address) || networkPolicy.permanentDenial(record.address)) {
      return { ok: false, code: "outbound_target_denied", reason: "target resolves to a permanently denied address" };
    }
    if ((networkPolicy.isPrivate(record.address) || isPrivateAddress(record.address)) && !scope) {
      return { ok: false, code: "network_scope_required", reason: "private or local network diagnostics require a named network scope" };
    }
    for (const probe of probes || []) {
      if (!probe || !["tcp", "udp", "icmp"].includes(probe.protocol) || (probe.port != null && (!Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65535))) {
        return { ok: false, code: "invalid_probe_policy", reason: "diagnostic probe policy is invalid" };
      }
      if (scope) {
        if (["tcp", "udp"].includes(probe.protocol) && probe.port != null) {
          const explicitlyAllowed = scope.allowed_ports.some(range => {
            const [start, end] = String(range).split("-").map(Number);
            return probe.port >= start && probe.port <= (end || start);
          });
          if (!explicitlyAllowed) return { ok: false, code: "network_scope_denied", reason: `network scope does not explicitly allow ${probe.protocol} port ${probe.port}` };
        }
        let decision;
        try { decision = networkPolicy.decision(scope, { host: normalized.host, address: record.address, protocol: probe.protocol, port: probe.port }); }
        catch { return { ok: false, code: "network_scope_denied", reason: "network scope could not validate the target" }; }
        if (!decision.ok) return { ok: false, code: "network_scope_denied", reason: `network scope denied ${probe.protocol}${probe.port ? ` port ${probe.port}` : ""} (${decision.reason})` };
      }
    }
  }

  return { ok: true, host: normalized.host, address: records[0].address, family: records[0].family, addresses: records.map(record => record.address), scope_id: scope?.scope_id || null, scope_revision: scope?.revision || null };
}

module.exports = { normalizeTarget, authorizeNetDiagTarget };
