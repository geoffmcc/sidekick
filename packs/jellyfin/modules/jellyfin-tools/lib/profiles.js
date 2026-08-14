"use strict";

const { requireSidekickSrc } = require("./deps");
const { resolveSecretRef } = requireSidekickSrc("src/connectors/resolve.js");
const { JellyfinError } = require("./errors");

const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

function parse(name, raw, globalConfig = {}) {
  if (!PROFILE_NAME.test(name)) {
    throw new JellyfinError(
      "invalid_input",
      `invalid Jellyfin profile name "${name}"`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new JellyfinError(
      "invalid_input",
      `profile "${name}" must be an object`,
    );
  }

  let endpoint;
  try {
    endpoint = new URL(raw.endpoint);
  } catch {
    throw new JellyfinError(
      "invalid_input",
      `profile "${name}" has an invalid endpoint`,
    );
  }

  const validScheme =
    endpoint.protocol === "https:" || endpoint.protocol === "http:";
  if (
    !validScheme ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new JellyfinError(
      "invalid_input",
      `profile "${name}" endpoint must be HTTPS/explicit internal HTTP without credentials, query or fragment`,
    );
  }
  if (endpoint.pathname !== "/" && /\/api(2)?\/json/i.test(endpoint.pathname)) {
    throw new JellyfinError(
      "invalid_input",
      `profile "${name}" endpoint must be the server origin, not an API path`,
    );
  }

  const insecureHttp =
    raw.allow_insecure_http === true ||
    globalConfig.allow_insecure_http === true;
  if (endpoint.protocol === "http:" && !insecureHttp) {
    throw new JellyfinError(
      "invalid_input",
      `profile "${name}" uses HTTP but insecure HTTP is not explicitly enabled`,
    );
  }
  if (!/^secret:[^\s]+$/.test(String(raw.api_key_ref || ""))) {
    throw new JellyfinError(
      "invalid_input",
      `profile "${name}" api_key_ref must be secret:<name>`,
    );
  }
  if (raw.api_key || raw.token || raw.password) {
    throw new JellyfinError(
      "invalid_input",
      `profile "${name}" must not contain inline credentials`,
    );
  }

  const configuredTimeout = Number(raw.request_timeout_ms);
  const timeout = Math.min(
    120000,
    Math.max(
      1000,
      Number.isFinite(configuredTimeout)
        ? Math.trunc(configuredTimeout)
        : 15000,
    ),
  );

  return {
    name,
    endpoint,
    api_key_ref: raw.api_key_ref,
    ca_pem: raw.ca_pem || null,
    ca_secret_ref: raw.ca_secret_ref || null,
    timeout,
    insecure: insecureHttp,
    allow_writes: raw.allow_writes === true,
    is_default: raw.default === true,
  };
}

function list(config) {
  const configured = config?.profiles || {};
  return Object.keys(configured).map((name) => {
    try {
      const profile = parse(name, configured[name], config);
      return {
        name,
        valid: true,
        endpoint: profile.endpoint.origin,
        tls:
          profile.endpoint.protocol === "https:"
            ? profile.ca_pem || profile.ca_secret_ref
              ? "pinned_ca"
              : "system_ca"
            : "explicit_http",
        is_default: profile.is_default,
        allow_writes: profile.allow_writes,
      };
    } catch (error) {
      return { name, valid: false, error: error.message };
    }
  });
}

function resolve(config, requestedName) {
  const configured = config?.profiles || {};
  const names = Object.keys(configured);
  if (!names.length) {
    throw new JellyfinError(
      "not_configured",
      "No Jellyfin profiles are configured",
    );
  }

  let name = requestedName;
  if (!name) {
    const defaults = names.filter(
      (candidate) => configured[candidate]?.default === true,
    );
    if (names.length === 1) name = names[0];
    else if (defaults.length === 1) name = defaults[0];
    else {
      throw new JellyfinError(
        "profile_ambiguous",
        `Multiple Jellyfin profiles are configured (${names.join(", ")}); specify profile`,
      );
    }
  }
  if (!Object.prototype.hasOwnProperty.call(configured, name)) {
    throw new JellyfinError(
      "profile_not_found",
      `No Jellyfin profile named "${name}"`,
    );
  }
  return parse(name, configured[name], config);
}

function credential(profile) {
  const key = resolveSecretRef(profile.api_key_ref);
  if (!key) {
    throw new JellyfinError(
      "authentication_failed",
      `API key for profile "${profile.name}" could not be resolved`,
    );
  }

  let ca = profile.ca_pem;
  if (!ca && profile.ca_secret_ref)
    ca = resolveSecretRef(profile.ca_secret_ref);
  if (profile.ca_secret_ref && !ca) {
    throw new JellyfinError(
      "tls_failed",
      `CA secret for profile "${profile.name}" could not be resolved`,
    );
  }
  return { key, ca: ca || null };
}

module.exports = { parse, list, resolve, credential };
