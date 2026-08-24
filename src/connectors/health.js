"use strict";

// Provider-specific bounded probes; the platform kernel remains the authority
// for connector state, persistence, and health events.
const https = require("https");
const { resolveConnectorCredential } = require("./resolve");
const { resolveOutboundUrl } = require("../security/outbound-url");

async function probeGithub(connector, { timeoutMs = 10000 } = {}) {
  if (!connector || connector.type !== "github") return Promise.resolve({ ok: false, error: "unsupported_connector_type" });
  const token = resolveConnectorCredential(connector);
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
      response.resume();
      response.on("end", () => { const status = Number(response.statusCode || 0); resolve({ ok: status >= 200 && status < 300, status, endpoint: base.origin }); });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", error => resolve({ ok: false, error: error.code === "ETIMEDOUT" ? "timeout" : "connection_failed" }));
    request.end();
  });
}

async function probeConnector(connector, options = {}) {
  return connector && connector.type === "github" ? probeGithub(connector, options) : { ok: false, error: "unsupported_connector_type" };
}

module.exports = { probeConnector, probeGithub };
