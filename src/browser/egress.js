"use strict";

// Browser egress governance.
//
// A real browser is a far larger network primitive than `web_fetch`: it
// follows redirects, loads subresources and iframes, opens WebSockets, and
// runs attacker-supplied JavaScript that can issue requests of its own.
// Playwright's route interception cannot see server-side redirect hops
// (verified empirically: Chromium follows them inside the network stack), so
// URL-level interception alone is not a boundary.
//
// Enforcement is therefore two layers, and the deep layer is the authority:
//
//   1. A URL-text policy applied in route interception and before agent
//      navigation — fast refusal with a useful error, plus evidence records.
//   2. A per-session loopback HTTP proxy that EVERY request from the session's
//      browser context traverses (Chromium is configured with the proxy and a
//      "<-loopback>" bypass rule so even localhost traffic goes through it).
//      The proxy sees every redirect hop, subresource, fetch/XHR and WebSocket
//      CONNECT. It resolves DNS itself, validates every resolved address, and
//      connects only to the address it validated — which closes DNS rebinding,
//      not just literal-IP tricks.
//
// Policy rules (all fail closed):
//   * schemes: http/https (ws/wss ride the same proxy paths);
//   * cloud metadata hosts and link-local addresses are ALWAYS refused;
//   * private/loopback/CGNAT/unique-local addresses require an operator-created
//     named network scope plus the operator ceiling;
//   * an allowed_hosts allowlist NARROWS the policy — it never widens it; a
//     private address stays refused without the private-network opt-in even
//     when listed;
//   * userinfo (credentials embedded in a URL) is refused.

const net = require("net");
const http = require("http");
const dns = require("dns");
const { METADATA_HOSTS } = require("../compute/endpoint-guard");
const { isPrivateAddress, isLinkLocal } = require("../security/outbound-url");
const networkScope = require("../security/network-scope");

const DNS_CACHE_TTL_MS = 30 * 1000;
const DNS_CACHE_MAX = 256;
const MAX_PROXY_CONNECTIONS = 64;
// Ports a CONNECT tunnel may reach. Standard HTTPS plus common local HTTPS dev
// ports; anything else is refused so CONNECT cannot smuggle non-web protocols.
const ALLOWED_CONNECT_PORTS = new Set([443, 8443]);

const dnsCache = new Map();

function stripBrackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLocalhostName(host) {
  const h = String(host || "").toLowerCase();
  return h === "localhost" || h === "localhost.localdomain" || h.endsWith(".localhost");
}

/**
 * Normalize per-session policy from open-time options against the operator
 * configuration. The config value is a ceiling: a session cannot opt into
 * anything the operator has not enabled.
 */
function buildSessionPolicy({ allowPrivateNetwork = false, allowedHosts = null, networkScope: requestedScope = null } = {}, config) {
  const patterns = Array.isArray(allowedHosts) && allowedHosts.length
    ? allowedHosts.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
    : null;
  let scope = null;
  let scopeError = null;
  if (requestedScope) {
    try { scope = require("../security/network-scopes").get(requestedScope); if (!scope) scopeError = "named network scope was not found"; }
    catch (error) { scopeError = error.message; }
  }
  return Object.freeze({
    allowPrivate: scope ? scope.allow_private_addresses === true && config.allowPrivateNetwork === true : allowPrivateNetwork === true && config.allowPrivateNetwork === true,
    requestedPrivate: allowPrivateNetwork === true,
    allowedHosts: patterns ? Object.freeze(patterns) : null,
    scope: scope ? Object.freeze(scope) : null,
    scopeError,
    networkScope: scope ? { scope_id: scope.scope_id, name: scope.name, revision: scope.revision, digest: scope.digest } : null,
  });
}

function matchHostPattern(host, pattern) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function hostAllowedByList(host, policy) {
  if (!policy.allowedHosts) return true;
  return policy.allowedHosts.some((pattern) => matchHostPattern(host, pattern));
}
function currentScope(policy) {
  if (!policy.scope) return true;
  try {
    const current = require("../security/network-scopes").get(policy.scope.scope_id, policy.scope.revision);
    return Boolean(current && current.enabled && current.is_current && current.digest === policy.scope.digest);
  } catch { return false; }
}

/**
 * Host-level policy: the rule both layers share. Returns a refusal string or
 * null. `host` may be a hostname or an IP literal (brackets stripped).
 */
function evaluateHost(host, policy) {
  const h = String(host || "").toLowerCase();
  if (!h) return "no host";
  if (policy.scope && !currentScope(policy)) return "named network scope is stale or disabled";
  if (METADATA_HOSTS.has(h)) return `host "${h}" is a cloud metadata endpoint and is never reachable from a browser session`;
  if (isLinkLocal(h)) return `host "${h}" is link-local and is never reachable from a browser session`;
  if (policy.scopeError) return policy.scopeError;
  if (policy.scope) {
    const decision = networkScope.decision(policy.scope, { host: h, allowedHosts: policy.allowedHosts });
    if (decision.reason === "destination_not_in_scope" && !net.isIP(h)) return null;
    if (!decision.ok && decision.reason !== "destination_not_in_scope") return `network scope denied destination (${decision.reason})`;
    if (decision.reason === "destination_not_in_scope") return `host "${h}" is outside the named network scope`;
    return null;
  }
  if (!hostAllowedByList(h, policy)) return `host "${h}" is not in this session's allowed_hosts`;
  if ((isPrivateAddress(h) || isLocalhostName(h)) && !policy.allowPrivate) {
    return `host "${h}" is private/loopback; this session does not permit private-network targets`;
  }
  return null;
}

/**
 * URL-text policy for navigations and intercepted requests. Returns a refusal
 * string or null.
 */
function evaluateBrowserUrl(value, policy, { schemes = ["http:", "https:"] } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return "not a valid URL";
  }
  if (!schemes.includes(url.protocol)) {
    return `scheme "${url.protocol}" is not allowed in a browser session (allowed: ${schemes.join(", ")})`;
  }
  if (url.username || url.password) return "credentials embedded in the URL are not allowed";
  const host = stripBrackets(url.hostname).toLowerCase();
  if (policy.scope) {
    const result = networkScope.decision(policy.scope, { host, protocol: url.protocol.slice(0, -1), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), allowedHosts: policy.allowedHosts });
    // A hostname may be authorized by an address CIDR only after the proxy's
    // pinned DNS lookup. The URL-text layer must defer that one decision to the
    // authoritative proxy rather than rejecting a hostname prematurely.
    if (result.reason === "destination_not_in_scope" && !net.isIP(host)) return null;
    if (!result.ok) return `network scope denied destination (${result.reason})`;
    return null;
  }
  return evaluateHost(host, policy);
}

/**
 * Resolve a hostname and validate EVERY address it resolves to. Fails closed
 * when any address is denied so a multi-answer record cannot smuggle one
 * denied address among allowed ones. Returns { address } (the pinned address
 * the caller must connect to) or { refusal }.
 */
async function resolveAndValidate(host, policy, { protocol = "https", port = 443 } = {}) {
  if (policy.scope && !currentScope(policy)) return { refusal: "named network scope is stale or disabled" };
  const h = String(host || "").toLowerCase();
  if (net.isIP(h)) {
    const refusal = policy.scope ? networkScope.decision(policy.scope, { host: h, address: h, protocol, port, allowedHosts: policy.allowedHosts }).ok ? null : `network scope denied destination` : evaluateHost(h, policy);
    return refusal ? { refusal } : { address: h, family: net.isIP(h) };
  }
  const nameRefusal = evaluateHost(h, policy);
  if (nameRefusal) return { refusal: nameRefusal };

  let records;
  const cached = dnsCache.get(h);
  if (cached && cached.expires > Date.now()) {
    records = cached.records;
  } else {
    try {
      records = await dns.promises.lookup(h, { all: true, verbatim: true });
    } catch (error) {
      return { refusal: `DNS resolution failed for "${h}": ${error.code || error.message}` };
    }
    if (dnsCache.size >= DNS_CACHE_MAX) dnsCache.clear();
    dnsCache.set(h, { records, expires: Date.now() + DNS_CACHE_TTL_MS });
  }
  if (!records || !records.length) return { refusal: `DNS resolution returned no addresses for "${h}"` };

  for (const record of records) {
    if (policy.scope) {
      const scoped = networkScope.decision(policy.scope, { host: h, address: record.address, protocol, port, allowedHosts: policy.allowedHosts });
      if (!scoped.ok) return { refusal: `network scope denied resolved destination (${scoped.reason})` };
      continue;
    }
    if (isLinkLocal(record.address)) return { refusal: `"${h}" resolves to link-local address ${record.address}` };
    if (isPrivateAddress(record.address) && !policy.allowPrivate) {
      return { refusal: `"${h}" resolves to private address ${record.address}; this session does not permit private-network targets` };
    }
  }
  return { address: records[0].address, family: records[0].family };
}

/**
 * Per-session forward proxy. Listens on loopback only; the session's browser
 * context is the intended client (Chromium is pointed at it with bypass
 * "<-loopback>"). One proxy per session keeps policy binding structural — the
 * port IS the session — and teardown deterministic.
 *
 * `onBlocked(record)` and `onRequest(record)` receive bounded evidence records.
 */
async function createSessionProxy(policy, { onBlocked = () => {}, onRequest = () => {}, credential = null } = {}) {
  let connections = 0;
  let selfPort = 0;

  // The proxy listens on loopback, so on a multi-user host any local process
  // could otherwise use it as an open forward proxy egressing with Sidekick's
  // identity. Require a per-session Proxy-Authorization credential; only the
  // browser (configured with it) can drive the proxy.
  const expectedAuth = credential
    ? "Basic " + Buffer.from(`${credential.username}:${credential.password}`).toString("base64")
    : null;

  function authorized(req) {
    if (!expectedAuth) return true;
    const provided = req.headers["proxy-authorization"] || "";
    if (provided.length !== expectedAuth.length) return false;
    try {
      return require("crypto").timingSafeEqual(Buffer.from(provided), Buffer.from(expectedAuth));
    } catch {
      return false;
    }
  }

  function blocked(kind, target, reason) {
    try { onBlocked({ kind, target: String(target).slice(0, 500), reason, at: new Date().toISOString() }); } catch { /* evidence only */ }
  }

  function isSelfTarget(host, port) {
    return Number(port) === selfPort && (isPrivateAddress(String(host).toLowerCase()) || isLocalhostName(host));
  }

  const server = http.createServer(async (req, res) => {
    // A client or upstream reset mid-request emits 'error' on these streams;
    // without listeners Node throws it as an unhandled error and takes the whole
    // process down. A proxy sees resets routinely (a page navigates away, a
    // session closes), so swallow them here — teardown, not a fault.
    req.on("error", () => {});
    res.on("error", () => {});
    if (!authorized(req)) {
      res.writeHead(407, { "Content-Type": "text/plain", "Proxy-Authenticate": "Basic realm=\"sidekick-browser\"" });
      res.end("Sidekick browser proxy: proxy authentication required");
      return;
    }
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Sidekick browser proxy: only absolute-URI proxy requests are accepted");
      return;
    }
    const refusal = evaluateBrowserUrl(url.href, policy);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (refusal || isSelfTarget(url.hostname, port)) {
      const reason = refusal || "request targets the session proxy itself";
      blocked("http", url.href, reason);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`Sidekick browser egress policy: ${reason}`);
      return;
    }
    const pinned = await resolveAndValidate(stripBrackets(url.hostname), policy, { protocol: url.protocol.slice(0, -1), port });
    if (pinned.refusal) {
      blocked("http", url.href, pinned.refusal);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`Sidekick browser egress policy: ${pinned.refusal}`);
      return;
    }
    // Re-check after resolution: a name that resolves to the proxy's own port
    // (only reachable at all under an open/private policy) must not loop back
    // into the proxy.
    if (isSelfTarget(pinned.address, port)) {
      blocked("http", url.href, "resolved address targets the session proxy itself");
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Sidekick browser egress policy: request targets the session proxy itself");
      return;
    }
    try { onRequest({ kind: "http", target: url.href.slice(0, 500) }); } catch { /* evidence only */ }

    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    // Connect to the address we validated, never to a re-resolved name.
    const upstream = http.request({
      host: pinned.address,
      port,
      path: url.pathname + url.search,
      method: req.method,
      headers,
      setHost: false,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.setHeader("Host", url.host);
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Sidekick browser proxy upstream error: ${error.code || error.message}`);
    });
    // A client reset must tear the upstream down too: node's pipe() leaves the
    // source running when the destination dies, so without this a reset client
    // leaks the upstream socket/fd until the origin finishes. (The HTTP path is
    // not covered by the CONNECT concurrency cap, so this matters.)
    const tearDownUpstream = () => { try { upstream.destroy(); } catch { /* already gone */ } };
    res.on("close", tearDownUpstream);
    req.on("error", tearDownUpstream);
    req.pipe(upstream);
  });

  server.on("connect", async (req, clientSocket) => {
    // Guard the tunnel client socket immediately: it can reset during the async
    // policy/DNS checks below, before the upstream is wired up, and an
    // unhandled reset would crash the process.
    clientSocket.on("error", () => {});
    if (!authorized(req)) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"sidekick-browser\"\r\n\r\n");
      return;
    }
    if (connections >= MAX_PROXY_CONNECTIONS) {
      clientSocket.end("HTTP/1.1 429 Too Many Connections\r\n\r\n");
      return;
    }
    const [rawHost, rawPort] = String(req.url).split(":");
    const host = stripBrackets(String(rawHost || "")).toLowerCase();
    const port = Number(rawPort || 443);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    // CONNECT tunnels raw bytes, so restrict it to the standard web TLS ports;
    // arbitrary-port CONNECT would let a page smuggle other protocols
    // (SMTP/Redis/…) to an allowed host. HTTPS_ALT covers common dev ports.
    if (!ALLOWED_CONNECT_PORTS.has(port)) {
      blocked("connect", `${host}:${port}`, `CONNECT to port ${port} is not permitted (allowed: ${[...ALLOWED_CONNECT_PORTS].join(", ")})`);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const refusal = evaluateHost(host, policy);
    if (refusal || isSelfTarget(host, port)) {
      blocked("connect", `${host}:${port}`, refusal || "request targets the session proxy itself");
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const pinned = await resolveAndValidate(host, policy, { protocol: "https", port });
    if (pinned.refusal) {
      blocked("connect", `${host}:${port}`, pinned.refusal);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (isSelfTarget(pinned.address, port)) {
      blocked("connect", `${host}:${port}`, "resolved address targets the session proxy itself");
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    try { onRequest({ kind: "connect", target: `${host}:${port}` }); } catch { /* evidence only */ }

    connections += 1;
    const upstream = net.connect(port, pinned.address, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // Idempotent teardown: both sockets fire error AND close, and destroying one
    // fires the other's close, so an unguarded handler would decrement
    // `connections` several times per tunnel and drift the cap toward zero.
    let torn = false;
    const done = () => {
      if (torn) return;
      torn = true;
      connections = Math.max(0, connections - 1);
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", done);
    upstream.on("close", done);
    clientSocket.on("error", done);
    clientSocket.on("close", done);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // The CONNECT counter above bounds tunnels, but ordinary absolute-URI HTTP
  // requests use the same per-session server and must not have an unbounded
  // socket path around that ceiling. Node enforces maxConnections at the
  // accepted-socket boundary for both request types.
  server.maxConnections = MAX_PROXY_CONNECTIONS;
  selfPort = server.address().port;

  // Post-listen resilience: a runtime server error or a malformed client
  // request must never crash the process. clientError destroys the offending
  // socket; a generic error is swallowed (the proxy is per-session and
  // disposable — a fault tears down the session, not Sidekick).
  server.on("error", () => {});
  server.on("clientError", (_err, socket) => { try { socket.destroy(); } catch { /* already gone */ } });

  return {
    port: selfPort,
    server,
    url: `http://127.0.0.1:${selfPort}`,
    close() {
      return new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
        // Force-close keep-alive sockets so session teardown is immediate.
        try { server.closeAllConnections(); } catch { /* node <18.2 */ }
      });
    },
  };
}

function clearDnsCache() {
  dnsCache.clear();
}

module.exports = {
  buildSessionPolicy,
  evaluateBrowserUrl,
  evaluateHost,
  resolveAndValidate,
  createSessionProxy,
  matchHostPattern,
  clearDnsCache,
};
