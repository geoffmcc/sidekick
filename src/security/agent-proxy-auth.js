"use strict";

const crypto = require("crypto");

const MAX_CLOCK_SKEW_MS = 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{20,100}$/;
const SIGNATURE_RE = /^[a-f0-9]{64}$/;

function assertDistinctProxySecret(mcpApiKey, proxyKey) {
  if (typeof mcpApiKey !== "string" || !mcpApiKey || typeof proxyKey !== "string" || !proxyKey) {
    throw new Error("MCP and Agent proxy credentials must both be configured");
  }
  if (mcpApiKey === proxyKey) throw new Error("SIDEKICK_AGENT_PROXY_KEY must differ from SIDEKICK_API_KEY");
  return true;
}

function assertDistinctAgentSchedulerSecret(proxyKey, schedulerKey) {
  if (typeof schedulerKey !== "string" || !schedulerKey) {
    throw new Error("SIDEKICK_AGENT_SCHEDULER_KEY must be configured for authenticated Agent scheduler reloads");
  }
  const values = [proxyKey, schedulerKey];
  if (values.some(value => typeof value !== "string" || !value) || new Set(values).size !== values.length) {
    throw new Error("SIDEKICK_AGENT_SCHEDULER_KEY must differ from SIDEKICK_AGENT_PROXY_KEY");
  }
  return true;
}

function bodyDigest(body) {
  return crypto.createHash("sha256").update(String(body || ""), "utf8").digest("hex");
}

function signaturePayload({ method, path, timestamp, nonce, principalId = "", scopes = "[]", delegationId = "", service = "dashboard-proxy", body = "" }) {
  return ["sidekick-agent-proxy-v1", String(method || "GET").toUpperCase(), String(path || ""), String(timestamp), String(nonce), String(principalId), String(scopes), String(delegationId), String(service), bodyDigest(body)].join("\n");
}

function createAgentProxyHeaders({ secret, method, path, body = "", principalId = "", scopes = [], delegationId = "", service = "dashboard-proxy", now = Date.now(), nonce = crypto.randomBytes(24).toString("base64url") }) {
  if (typeof secret !== "string" || !secret) throw new Error("Agent proxy authentication key is unavailable");
  const timestamp = String(now);
  if (scopes !== null && !Array.isArray(scopes)) throw new Error("Agent proxy scopes must be an array or null");
  const scopesJson = scopes === null ? "null" : JSON.stringify(scopes.slice(0, 80).map(String));
  const serviceName = String(service || "dashboard-proxy").slice(0, 80);
  const signature = crypto.createHmac("sha256", secret).update(signaturePayload({ method, path, timestamp, nonce, principalId, scopes: scopesJson, delegationId, service: serviceName, body })).digest("hex");
  return {
    "X-Sidekick-Principal-ID": String(principalId || "").slice(0, 160),
    "X-Sidekick-Principal-Scopes": scopesJson,
    "X-Sidekick-Delegation-ID": String(delegationId || "").slice(0, 160),
    "X-Sidekick-Agent-Service": serviceName,
    "X-Sidekick-Agent-Timestamp": timestamp,
    "X-Sidekick-Agent-Nonce": nonce,
    "X-Sidekick-Agent-Signature": signature,
  };
}

function createSqliteNonceConsumer(db, maxEntries = 10000) {
  if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") throw new Error("Agent proxy nonce store requires a SQLite database");
  return (nonce, expiresAt, now = Date.now()) => db.transaction(() => {
    db.prepare("DELETE FROM agent_proxy_nonces WHERE expires_at <= ?").run(now);
    const active = db.prepare("SELECT COUNT(*) AS count FROM agent_proxy_nonces WHERE expires_at > ?").get(now)?.count || 0;
    if (active >= maxEntries) return false;
    const nonceHash = crypto.createHash("sha256").update(String(nonce), "utf8").digest("hex");
    return db.prepare("INSERT OR IGNORE INTO agent_proxy_nonces (nonce_hash, expires_at) VALUES (?, ?)").run(nonceHash, expiresAt).changes === 1;
  }).immediate();
}

function verifyAgentProxyRequest({ secret, method, path, body = "", headers = {}, now = Date.now(), usedNonces, consumeNonce = null }) {
  if (typeof secret !== "string" || !secret) return null;
  const get = name => headers[name] ?? headers[name.toLowerCase()] ?? "";
  const timestamp = String(get("X-Sidekick-Agent-Timestamp"));
  const nonce = String(get("X-Sidekick-Agent-Nonce"));
  const supplied = String(get("X-Sidekick-Agent-Signature"));
  const numericTimestamp = Number(timestamp);
  if (!/^\d{10,16}$/.test(timestamp) || !Number.isFinite(numericTimestamp) || Math.abs(now - numericTimestamp) > MAX_CLOCK_SKEW_MS) return null;
  if (!NONCE_RE.test(nonce) || !SIGNATURE_RE.test(supplied)) return null;

  const principalId = String(get("X-Sidekick-Principal-ID"));
  const scopesJson = String(get("X-Sidekick-Principal-Scopes") || "[]");
  const delegationId = String(get("X-Sidekick-Delegation-ID"));
  const service = String(get("X-Sidekick-Agent-Service") || "dashboard-proxy");
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(service)) return null;
  const expected = crypto.createHmac("sha256", secret).update(signaturePayload({ method, path, timestamp, nonce, principalId, scopes: scopesJson, delegationId, service, body })).digest();
  const actual = Buffer.from(supplied, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  let scopes = null;
  if (principalId) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(principalId) || delegationId && !/^[A-Za-z0-9_.:-]{1,160}$/.test(delegationId)) return null;
    try { scopes = JSON.parse(scopesJson); } catch { return null; }
    if (scopes !== null && (!Array.isArray(scopes) || scopes.length > 80 || scopes.some(scope => typeof scope !== "string" || scope.length > 160))) return null;
  }
  const expiresAt = numericTimestamp + MAX_CLOCK_SKEW_MS;
  if (typeof consumeNonce === "function") {
    try { if (!consumeNonce(nonce, expiresAt, now)) return null; } catch { return null; }
  } else if (usedNonces instanceof Map) {
    for (const [value, expiry] of usedNonces) if (expiry <= now) usedNonces.delete(value);
    if (usedNonces.has(nonce) || usedNonces.size >= 10000) return null;
    usedNonces.set(nonce, expiresAt);
  } else return null;
  if (!principalId) return Object.freeze({ service, principal_id: null });
  return Object.freeze({ service, principal_id: principalId, scopes: Array.isArray(scopes) ? Object.freeze(scopes) : null, delegation_id: delegationId || null, authentication_method: "signed_dashboard_proxy" });
}

module.exports = Object.freeze({ createAgentProxyHeaders, createSqliteNonceConsumer, verifyAgentProxyRequest, assertDistinctProxySecret, assertDistinctAgentSchedulerSecret, MAX_CLOCK_SKEW_MS });
