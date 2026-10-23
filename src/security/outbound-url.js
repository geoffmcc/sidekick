"use strict";

// Validation for caller-supplied outbound request targets.
//
// `web_fetch`, `notify` and `download` all take a URL from the caller — which,
// for an agent-driven system, means from a model acting on untrusted input.
// Without a destination policy each of those is a server-side request forgery
// primitive: the request originates inside the trust boundary, so it reaches
// loopback admin ports, LAN services, and cloud instance-metadata endpoints
// that are unreachable from outside.
//
// Policy:
//   * scheme must be http or https (anything else is refused outright);
//   * credentials embedded in the URL are refused;
//   * cloud metadata hosts and link-local addresses are ALWAYS refused — there
//     is no legitimate agent fetch of an instance-credential endpoint;
//   * loopback and private/CGNAT/unique-local addresses are refused by default,
//     because reaching them is the SSRF case rather than a normal fetch.
//
// Private destinations require an operator-created named network scope. The
// historical environment flag is retained as a parsed compatibility setting,
// but is intentionally not an authority grant.
//
// Direct HTTP callers use resolveOutboundUrl below, which pins DNS results to
// the socket and rejects denied answers. Redirects are not followed by current
// direct callers; any future redirect support must resolve and validate every
// hop before opening its socket.

const net = require("node:net");
const dns = require("dns").promises;
const { stripBrackets, isLinkLocal, isMetadataAddress, isNonUnicastAddress, isPrivateAddress, isIPv4MappedAddress } = require("./ip-address-policy");

/**
 * Returns an error message describing why the target is refused, or null when
 * the URL may be requested. `label` names the argument in the message so the
 * caller sees which input was rejected.
 */
function validateOutboundUrl(value, label = "url", options = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return `Invalid ${label}: not a valid URL`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Invalid ${label} scheme "${url.protocol}": Only http and https are allowed`;
  }
  if (url.username || url.password) {
    return `Invalid ${label}: credentials embedded in the URL are not allowed`;
  }

  const host = stripBrackets(url.hostname).toLowerCase();
  if (!host) return `Invalid ${label}: no host`;

  if (isMetadataAddress(host)) {
    return `Refused ${label} host "${host}": cloud metadata endpoints are never a valid fetch target`;
  }
  if (isLinkLocal(host)) {
    return `Refused ${label} host "${host}": link-local addresses are never a valid fetch target`;
  }
  if (isNonUnicastAddress(host)) {
    return `Refused ${label} host "${host}": non-unicast addresses are never a valid fetch target`;
  }
  if (isIPv4MappedAddress(host)) {
    return `Refused ${label} host "${host}": IPv4-mapped IPv6 addresses are not valid network destinations`;
  }
   const allowPrivate = options.allowPrivate === true;
  if (isPrivateAddress(host) && !allowPrivate) {
    return `Refused ${label} host "${host}": private and loopback addresses are not fetchable. ` +
      "Bind the request to an operator-created named network scope.";
  }
  return null;
}

/**
 * Resolve and pin a caller-supplied destination before opening a socket.
 *
 * Text validation alone is not an SSRF boundary: an attacker-controlled DNS
 * name can resolve to loopback/private space after validation.  Callers must
 * connect to the returned address and retain the original hostname for TLS
 * SNI and the HTTP Host header.  If a name has multiple answers, reject it if
 * any answer is forbidden; otherwise a later resolver choice could select a
 * denied address.
 */
async function resolveOutboundUrl(value, label = "url", options = {}) {
  if (options.networkScope) {
    const scopes = require("./network-scopes");
    const scope = typeof options.networkScope === "object" ? options.networkScope : scopes.get(options.networkScope, options.networkScopeRevision);
    if (!scope) return { refusal: "named network scope is missing or invalid", code: "network_scope_unavailable" };
    const scoped = await require("./network-scope").resolveDestination(scope, value, { allowedHosts: options.allowedHosts });
    if (!scoped.ok) return { refusal: `network scope denied destination (${scoped.reason})`, code: "network_scope_denied" };
    return scoped;
  }
  const refusal = validateOutboundUrl(value, label, options);
  if (refusal) return { refusal, code: /operator-created named network scope/i.test(refusal) ? "network_scope_required" : "outbound_target_denied" };

  const url = new URL(String(value));
  const hostname = stripBrackets(url.hostname).toLowerCase();
  const ipVersion = net.isIP(hostname);
  if (ipVersion) return { url, address: hostname, family: ipVersion };

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    return { refusal: `Unable to resolve ${label}: ${error.code || "DNS lookup failed"}`, code: "dns_resolution_failed" };
  }
  if (!records || records.length === 0) return { refusal: `Unable to resolve ${label}: no addresses returned`, code: "dns_resolution_failed" };

  for (const record of records) {
    const address = stripBrackets(String(record.address || "").toLowerCase());
    if (isMetadataAddress(address) || isLinkLocal(address)) {
      return { refusal: `Refused ${label}: resolved address is a protected link-local or metadata endpoint`, code: "outbound_target_denied" };
    }
    if (isNonUnicastAddress(address)) {
      return { refusal: `Refused ${label}: hostname resolves to a non-unicast address`, code: "outbound_target_denied" };
    }
    const allowPrivate = options.allowPrivate === true;
    if (isPrivateAddress(address) && !allowPrivate) {
      return { refusal: `Refused ${label}: hostname resolves to a private or loopback address`, code: "network_scope_required" };
    }
  }

  const first = records[0];
  return { url, address: first.address, family: first.family };
}

// Request headers a caller must never control: they either impersonate a
// different destination or attach credentials the caller should not be able to
// set on a request the server makes with its own network identity.
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "te",
]);

/**
 * Drops caller headers that must not be overridable. Returns the accepted
 * headers plus the names that were refused, so the caller can report them
 * rather than silently ignoring the request.
 */
function filterRequestHeaders(headers) {
  const accepted = Object.create(null);
  const rejected = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (FORBIDDEN_REQUEST_HEADERS.has(String(key).toLowerCase())) rejected.push(key);
    else accepted[key] = value;
  }
  return { accepted, rejected };
}

module.exports = {
  validateOutboundUrl,
  resolveOutboundUrl,
  filterRequestHeaders,
  isPrivateAddress,
  isLinkLocal,
  FORBIDDEN_REQUEST_HEADERS,
};
