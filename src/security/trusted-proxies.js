"use strict";

const net = require("node:net");

const MAX_TRUSTED_PROXY_ENTRIES = 64;
const MAX_TRUSTED_PROXY_VALUE_LENGTH = 2048;

function parseTrustedProxyConfig(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || ["false", "0", "off", "no"].includes(raw)) return false;

  // Compatibility posture is constrained to same-host reverse proxies. A
  // proxy on another host must be named explicitly by address or CIDR.
  const entries = raw === "true" ? ["loopback"] : raw.split(",").map(item => item.trim()).filter(Boolean);
  if (!entries.length || entries.length > MAX_TRUSTED_PROXY_ENTRIES || raw.length > MAX_TRUSTED_PROXY_VALUE_LENGTH) {
    throw new Error("SIDEKICK_DASHBOARD_TRUST_PROXY must contain at most 64 proxy IPs/CIDRs");
  }

  for (const entry of entries) {
    if (entry === "loopback") continue;
    const parts = entry.split("/");
    if (parts.length > 2) throw new Error("SIDEKICK_DASHBOARD_TRUST_PROXY entries must be IP addresses or CIDRs");
    const family = net.isIP(parts[0]);
    if (!family) throw new Error("SIDEKICK_DASHBOARD_TRUST_PROXY entries must be IP addresses or CIDRs");
    if (parts.length === 2) {
      if (!/^\d+$/.test(parts[1])) throw new Error("SIDEKICK_DASHBOARD_TRUST_PROXY contains an invalid CIDR prefix");
      const prefix = Number(parts[1]);
      const maxPrefix = family === 4 ? 32 : 128;
      if (prefix > maxPrefix || prefix === 0) {
        throw new Error("SIDEKICK_DASHBOARD_TRUST_PROXY CIDRs must use a prefix from 1 through 32 or 128");
      }
    }
  }
  return entries;
}

module.exports = { parseTrustedProxyConfig, MAX_TRUSTED_PROXY_ENTRIES, MAX_TRUSTED_PROXY_VALUE_LENGTH };
