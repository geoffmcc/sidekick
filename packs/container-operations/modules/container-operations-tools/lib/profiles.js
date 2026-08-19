"use strict";

const net = require("net");
const { ContainerError } = require("./errors");
const { requireSidekickSrc } = require("./deps");
const { resolveSecretRef } = requireSidekickSrc("src/connectors/resolve.js");

const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const SOCKET_RE = /^(?:\/|[A-Za-z]:[\\/])[^\0]{1,498}$/;
const COMPOSE_BINARIES = new Set(["docker", "docker-compose", "podman", "podman-compose"]);

function parseProfile(name, raw) {
  if (!NAME_RE.test(String(name || ""))) return { ok: false, error: `Invalid engine profile name "${name}"` };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `Profile "${name}" must be an object` };
  if (!["docker", "podman"].includes(raw.provider)) return { ok: false, error: `Profile "${name}" provider must be docker or podman` };
  if (raw.socket && raw.endpoint) return { ok: false, error: `Profile "${name}" must choose socket or endpoint, not both` };
  if (!raw.socket && !raw.endpoint) return { ok: false, error: `Profile "${name}" requires a local socket or authenticated HTTPS endpoint` };
  if (raw.socket && !SOCKET_RE.test(String(raw.socket))) return { ok: false, error: `Profile "${name}" socket is invalid` };
  let endpoint = null;
  if (raw.endpoint) {
    try {
      endpoint = new URL(raw.endpoint);
      if (endpoint.protocol !== "https:") throw new Error("only https endpoints are allowed");
      if (endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("endpoint must be an origin without credentials or path");
      if (net.isIP(endpoint.hostname) && !raw.tls?.servername) throw new Error("IP endpoints require tls.servername for certificate identity");
    } catch (error) { return { ok: false, error: `Profile "${name}" endpoint is invalid: ${error.message}` }; }
  }
  if (raw.tls && typeof raw.tls !== "object") return { ok: false, error: `Profile "${name}" tls must be an object` };
  if (raw.tls && (raw.tls.ca_ref || raw.tls.cert_ref || raw.tls.key_ref)) {
    for (const key of ["ca_ref", "cert_ref", "key_ref"]) {
      if (raw.tls[key] && !/^secret:[A-Za-z0-9_.:@/-]+$/.test(raw.tls[key])) return { ok: false, error: `Profile "${name}" tls.${key} must be a secret reference` };
    }
  }
  const compose = raw.compose || null;
  if (compose) {
    if (compose.binary && !COMPOSE_BINARIES.has(compose.binary)) return { ok: false, error: `Profile "${name}" compose binary is not allowlisted` };
    if (compose.project_roots && (!Array.isArray(compose.project_roots) || compose.project_roots.some(p => typeof p !== "string" || !p))) return { ok: false, error: `Profile "${name}" compose project_roots is invalid` };
  }
  const timeout = Number(raw.request_timeout_ms || 15000);
  const operationTimeout = Number(raw.operation_timeout_ms || 120000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) return { ok: false, error: `Profile "${name}" request_timeout_ms must be 1000..120000` };
  if (!Number.isInteger(operationTimeout) || operationTimeout < 1000 || operationTimeout > 1800000) return { ok: false, error: `Profile "${name}" operation_timeout_ms must be 1000..1800000` };
  return { ok: true, profile: { name, provider: raw.provider, display_name: raw.display_name || name, socket: raw.socket || null, endpoint: endpoint ? endpoint.toString() : null, tls: raw.tls || {}, compose, request_timeout_ms: timeout, operation_timeout_ms: operationTimeout, allow_mutations: raw.allow_mutations === true, default: raw.default === true } };
}

function listProfiles(config = {}) {
  const profiles = config.profiles && typeof config.profiles === "object" ? config.profiles : {};
  return Object.entries(profiles).map(([name, raw]) => {
    const parsed = parseProfile(name, raw);
    return parsed.ok ? { name, provider: parsed.profile.provider, display_name: parsed.profile.display_name, transport: parsed.profile.socket ? "unix_socket" : "https_tls", default: parsed.profile.default, allow_mutations: parsed.profile.allow_mutations } : { name, valid: false, error: parsed.error };
  });
}

function resolve(config, name) {
  const profiles = config && config.profiles && typeof config.profiles === "object" ? config.profiles : {};
  const names = Object.keys(profiles);
  if (!names.length) throw new ContainerError("not_configured", "No Docker/Podman engine profiles are configured");
  let selected = name;
  if (!selected) {
    const defaults = names.filter(n => profiles[n] && profiles[n].default === true);
    if (names.length === 1) selected = names[0];
    else if (defaults.length === 1) selected = defaults[0];
    else throw new ContainerError("profile_required", `Multiple engine profiles are configured (${names.join(", ")}); specify profile`);
  }
  if (!Object.prototype.hasOwnProperty.call(profiles, selected)) throw new ContainerError("profile_not_found", `No engine profile named "${selected}"`);
  const parsed = parseProfile(selected, profiles[selected]);
  if (!parsed.ok) throw new ContainerError("profile_invalid", parsed.error);
  return parsed.profile;
}

function resolveTls(tls = {}) {
  const out = {};
  for (const [key, ref] of [["ca", tls.ca_ref], ["cert", tls.cert_ref], ["key", tls.key_ref]]) {
    if (ref) {
      const value = resolveSecretRef(ref);
      if (!value) throw new ContainerError("credential_missing", `TLS secret ${ref} could not be resolved`);
      out[key] = value;
    }
  }
  if (tls.servername) out.servername = tls.servername;
  return out;
}

module.exports = { parseProfile, listProfiles, resolve, resolveTls, COMPOSE_BINARIES };
