"use strict";

const net = require("node:net");

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (net.isIP(host) === 4) return Number(host.split(".")[0]) === 127;
  return host === "::1";
}

function validateControlPlaneUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("Sidekick control-plane URL must be a valid absolute URL"); }
  if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Sidekick control-plane URL must use HTTP(S), include a host, and contain no credentials");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    const error = new Error("Sidekick control-plane credentials require HTTPS; plain HTTP is allowed only for loopback connections");
    error.code = "CONTROL_PLANE_INSECURE_TRANSPORT";
    throw error;
  }
  return url;
}

module.exports = { isLoopbackHost, validateControlPlaneUrl };
