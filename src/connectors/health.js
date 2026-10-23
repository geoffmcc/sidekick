"use strict";

// Provider-specific bounded probes; the platform kernel remains the authority
// for connector state, persistence, and health events.
const https = require("https");
const { resolveConnectorCredential } = require("./resolve");
const { resolveOutboundUrl } = require("../security/outbound-url");

function resultFromProbeHeaders(response, endpoint) {
  const status = Number(response.statusCode || 0);
  return { ok: status >= 200 && status < 300, status, endpoint };
}

function finishProbeFromHeaders(response, endpoint, resolve) {
  resolve(resultFromProbeHeaders(response, endpoint));
  // Resolve first so a resulting socket error cannot replace the HTTP status.
  response.destroy();
}

async function probeGithub(connector, { timeoutMs = 10000, context } = {}) {
  if (!connector || connector.type !== "github") return Promise.resolve({ ok: false, error: "unsupported_connector_type" });
  const token = resolveConnectorCredential(connector, { context, requireIdentity: true });
  if (!token) return Promise.resolve({ ok: false, error: "credential_unavailable" });
  let base;
  try { base = new URL(String(connector.endpoint || "")); } catch { return Promise.resolve({ ok: false, error: "invalid_endpoint" }); }
  if (base.protocol !== "https:") return Promise.resolve({ ok: false, error: "endpoint_requires_https" });
  const resolved = await resolveOutboundUrl(base.href, "connector endpoint");
  if (resolved.refusal) return { ok: false, error: "endpoint_refused" };
  const path = `${base.pathname.replace(/\/$/, "")}/rate_limit`;
  return new Promise(resolve => {
    const request = https.request({ hostname: resolved.address, port: base.port || 443, servername: base.hostname, path, method: "GET", timeout: timeoutMs,
      headers: { Host: base.host, Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Sidekick-MCP/1.0" } }, response => {
      // The probe only needs the status code. Never download an untrusted
      // response body from a connector endpoint merely to discard it.
      finishProbeFromHeaders(response, base.origin, resolve);
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", error => resolve({ ok: false, error: error.code === "ETIMEDOUT" ? "timeout" : "connection_failed" }));
    request.end();
  });
}

async function probeConnector(connector, options = {}) {
  return connector && connector.type === "github" ? probeGithub(connector, options) : { ok: false, error: "unsupported_connector_type" };
}

module.exports = { probeConnector, probeGithub, resultFromProbeHeaders, finishProbeFromHeaders };
