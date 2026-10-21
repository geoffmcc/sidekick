"use strict";

const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Require an out-of-band bootstrap token whenever unauthenticated setup could
 * be reached through a network-facing bind or a trusted reverse proxy.
 */
function requiresBootstrapToken(bindHost, trustProxy) {
  return Boolean(trustProxy) || !LOOPBACK_BIND_HOSTS.has(String(bindHost || "").trim().toLowerCase());
}

module.exports = { requiresBootstrapToken };
