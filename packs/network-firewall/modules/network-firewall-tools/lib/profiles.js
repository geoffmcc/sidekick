"use strict";
const path = require("path");
let resolveSecretRef;
try { ({ resolveSecretRef } = require("/home/sidekick/sidekick/src/connectors/resolve.js")); }
catch { ({ resolveSecretRef } = require(path.resolve(__dirname, "../../../../../../../src/connectors/resolve.js"))); }
const { NetworkFirewallError } = require("./errors");
const v = require("./validate");
function parse(name, raw, global = {}) {
  v.name(name, "profile"); if (!raw || typeof raw !== "object") throw new NetworkFirewallError("invalid_input", `profile ${name} must be an object`);
  const provider = String(raw.provider || "").toLowerCase(); if (!["openwrt","opnsense","pfsense","unifi"].includes(provider)) throw new NetworkFirewallError("invalid_input", `profile ${name} has unsupported provider`);
  const url = v.endpoint(raw.endpoint); if (!/^secret:\S+$/.test(String(raw.credential_ref || ""))) throw new NetworkFirewallError("invalid_input", `profile ${name} credential_ref must be secret:<name>`);
  if (raw.password || raw.token || raw.api_key || raw.secret) throw new NetworkFirewallError("invalid_input", `profile ${name} must not contain inline credentials`);
  const ca = raw.ca_pem || null;
  if (raw.ca_secret_ref && !/^secret:\S+$/.test(raw.ca_secret_ref)) throw new NetworkFirewallError("invalid_input", "ca_secret_ref must be secret:<name>");
  return { name, provider, display_name: raw.display_name || name, endpoint: url, site_id: raw.site_id || null, credential_ref: raw.credential_ref, credential: null, ca, ca_secret_ref: raw.ca_secret_ref || null, tls_servername: raw.tls_servername || null, timeout: Math.min(120000, Math.max(1000, Number(raw.request_timeout_ms) || 15000)), allow_mutations: raw.allow_mutations === true, is_default: raw.default === true, ssh: raw.ssh || null };
}
function list(config) { return Object.entries(config?.profiles || {}).map(([n, raw]) => { try { const p = parse(n, raw, config); return { name:n, provider:p.provider, endpoint:p.endpoint.origin, default:p.is_default, allow_mutations:p.allow_mutations, tls:p.ca ? "pinned_ca" : "system_ca", valid:true }; } catch (e) { return { name:n, valid:false, error:e.message }; } }); }
function resolve(config, requested) { const entries = Object.entries(config?.profiles || {}); if (!entries.length) throw new NetworkFirewallError("not_configured", "No network/firewall profiles are configured"); let name = requested; if (!name) { const defaults = entries.filter(([,p]) => p.default === true); if (entries.length === 1) name = entries[0][0]; else if (defaults.length === 1) name = defaults[0][0]; else throw new NetworkFirewallError("profile_ambiguous", "Multiple profiles are configured; specify profile"); } const raw = config.profiles[name]; if (!raw) throw new NetworkFirewallError("profile_not_found", `No profile named ${name}`); const profile=parse(name, raw, config); profile.credential=resolveSecretRef(profile.credential_ref); profile.ca=profile.ca || (profile.ca_secret_ref ? resolveSecretRef(profile.ca_secret_ref) : null); return profile; }
module.exports = { parse, list, resolve };
