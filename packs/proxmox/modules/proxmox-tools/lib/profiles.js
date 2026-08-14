"use strict";

/**
 * Profile resolution: turn administrator-controlled pack configuration into a
 * usable, validated Proxmox target plus a late-resolved credential.
 *
 * The security model lives here:
 *
 *  - A tool never supplies an endpoint. It supplies a profile NAME, which is
 *    looked up in trusted pack configuration. This is what stops the pack from
 *    being an authenticated SSRF primitive.
 *  - Credentials are never stored in configuration. A profile carries a
 *    `token_ref` of the form `secret:<name>`; the value is resolved server-side
 *    at call time through Sidekick's existing secret store and never returned,
 *    logged, or placed on the profile object handed around the module.
 *  - TLS verification is always on. A self-signed Proxmox certificate is
 *    supported by PINNING its CA (`ca_pem` inline, or `ca_secret` from the
 *    secret store), never by disabling verification. There is deliberately no
 *    insecure mode.
 */

const { requireSidekickSrc } = require("./deps");
const validate = require("./validate");

// Reuse Sidekick's own secret-reference resolver — the same code the connector
// authority and compute credential path use. Resolution is server-side and the
// value never crosses the module boundary.
const { resolveSecretRef } = requireSidekickSrc("src/connectors/resolve.js");

const DEFAULTS = Object.freeze({
  request_timeout_ms: 15000,
  task_poll_interval_ms: 1000,
  task_timeout_ms: 120000,
  allow_lifecycle: false,
});

const MIN_TIMEOUT = 1000;
const MAX_REQUEST_TIMEOUT = 120000;
const MAX_TASK_TIMEOUT = 1800000; // 30 min upper bound on any single task wait

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function looksLikePem(value) {
  return typeof value === "string" && /-----BEGIN CERTIFICATE-----/.test(value);
}

/**
 * Validate a single profile's configuration shape WITHOUT resolving secrets.
 * Returns { ok, profile } or { ok:false, code, message }.
 */
function parseProfile(name, raw) {
  const nameCheck = validate.validateProfileName(name);
  if (!nameCheck.ok) return { ok: false, code: "profile_invalid", message: `profile name "${name}": ${nameCheck.message}` };
  if (!raw || typeof raw !== "object") return { ok: false, code: "profile_invalid", message: `profile "${name}" must be an object` };

  const endpoint = validate.validateEndpoint(raw.endpoint);
  if (!endpoint.ok) return { ok: false, code: "profile_invalid", message: `profile "${name}" endpoint: ${endpoint.message}` };

  const tokenRef = validate.validateSecretRef(raw.token_ref);
  if (!tokenRef.ok) return { ok: false, code: "profile_invalid", message: `profile "${name}" token_ref: ${tokenRef.message}` };

  // A configuration mistake that pastes a raw token into config instead of a
  // reference must be refused loudly — never carried as if it were valid.
  if (raw.token || raw.secret || raw.password) {
    return { ok: false, code: "profile_invalid", message: `profile "${name}" must not contain inline credentials; use token_ref: "secret:<name>"` };
  }

  if (raw.ca_pem !== undefined && !looksLikePem(raw.ca_pem)) {
    return { ok: false, code: "profile_invalid", message: `profile "${name}" ca_pem must be a PEM certificate` };
  }
  if (raw.ca_secret_ref !== undefined) {
    const caRef = validate.validateSecretRef(raw.ca_secret_ref);
    if (!caRef.ok) return { ok: false, code: "profile_invalid", message: `profile "${name}" ca_secret_ref: ${caRef.message}` };
  }

  let tlsServername = null;
  if (raw.tls_servername !== undefined) {
    const serverName = validate.validateTlsServerName(raw.tls_servername);
    if (!serverName.ok) return { ok: false, code: "profile_invalid", message: `profile "${name}" tls_servername: ${serverName.message}` };
    tlsServername = serverName.value;
  }

  return {
    ok: true,
    profile: {
      name,
      endpointParsed: { value: endpoint.value, hostname: endpoint.hostname, port: endpoint.port },
      token_ref: tokenRef.value,
      ca_pem: raw.ca_pem || null,
      ca_secret_ref: raw.ca_secret_ref || null,
      tls_servername: tlsServername,
      request_timeout_ms: clampInt(raw.request_timeout_ms, DEFAULTS.request_timeout_ms, MIN_TIMEOUT, MAX_REQUEST_TIMEOUT),
      task_poll_interval_ms: clampInt(raw.task_poll_interval_ms, DEFAULTS.task_poll_interval_ms, 250, 10000),
      task_timeout_ms: clampInt(raw.task_timeout_ms, DEFAULTS.task_timeout_ms, MIN_TIMEOUT, MAX_TASK_TIMEOUT),
      allow_lifecycle: raw.allow_lifecycle === true,
      is_default: raw.default === true,
    },
  };
}

/** List configured profile names and their validation state (no secrets). */
function listProfiles(config) {
  const profiles = config && config.profiles && typeof config.profiles === "object" ? config.profiles : {};
  const entries = [];
  for (const [name, raw] of Object.entries(profiles)) {
    const parsed = parseProfile(name, raw);
    entries.push(parsed.ok
      ? { name, valid: true, endpoint: parsed.profile.endpointParsed.value, allow_lifecycle: parsed.profile.allow_lifecycle, is_default: parsed.profile.is_default, tls: parsed.profile.ca_pem || parsed.profile.ca_secret_ref ? "pinned_ca" : "system_ca" }
      : { name, valid: false, error: parsed.message });
  }
  return entries;
}

/**
 * Resolve the profile a tool should use. If `name` is omitted, the single
 * configured profile is used, or the one flagged default. Ambiguity is an
 * error, not a silent guess.
 */
function resolveProfile(config, name) {
  const profiles = config && config.profiles && typeof config.profiles === "object" ? config.profiles : {};
  const names = Object.keys(profiles);
  if (!names.length) {
    return { ok: false, code: "not_configured", message: "No Proxmox profiles are configured. An administrator must configure at least one profile via the capability tool." };
  }

  let targetName = name;
  if (targetName === undefined || targetName === null || targetName === "") {
    if (names.length === 1) {
      targetName = names[0];
    } else {
      const defaults = names.filter(n => profiles[n] && profiles[n].default === true);
      if (defaults.length === 1) targetName = defaults[0];
      else return { ok: false, code: "profile_required", message: `Multiple profiles are configured (${names.join(", ")}); specify one with the profile argument.` };
    }
  } else {
    const nameCheck = validate.validateProfileName(targetName);
    if (!nameCheck.ok) return { ok: false, code: "invalid_input", message: nameCheck.message };
    if (!Object.prototype.hasOwnProperty.call(profiles, targetName)) {
      return { ok: false, code: "profile_not_found", message: `No Proxmox profile named "${targetName}". Configured profiles: ${names.join(", ")}.` };
    }
  }

  const parsed = parseProfile(targetName, profiles[targetName]);
  if (!parsed.ok) return parsed;
  return { ok: true, profile: parsed.profile };
}

/**
 * Resolve the credential (and pinned CA) for a profile. Returns
 * { ok, token, ca_pem } or { ok:false, code, message }. The token value stays
 * inside this result; callers pass it straight to the client and never surface
 * it.
 */
function resolveCredential(profile) {
  const token = resolveSecretRef(profile.token_ref);
  if (!token) {
    return { ok: false, code: "credential_missing", message: `The API token for profile "${profile.name}" could not be resolved from the secret store (token_ref ${profile.token_ref}). Store it with the secret tool.` };
  }
  let caPem = profile.ca_pem;
  if (!caPem && profile.ca_secret_ref) {
    caPem = resolveSecretRef(profile.ca_secret_ref);
    if (!caPem) {
      return { ok: false, code: "profile_invalid", message: `profile "${profile.name}" ca_secret_ref ${profile.ca_secret_ref} could not be resolved from the secret store` };
    }
  }
  return { ok: true, token, ca_pem: caPem || null };
}

module.exports = { parseProfile, listProfiles, resolveProfile, resolveCredential, DEFAULTS };
