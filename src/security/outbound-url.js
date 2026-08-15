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
// SIDEKICK_ALLOW_PRIVATE_FETCH=true restores private and loopback destinations
// for deployments that legitimately fetch from their own LAN. Metadata and
// link-local hosts stay refused even then: that escape hatch exists for
// homelab reachability, not for credential endpoints.
//
// SCOPE LIMIT — this validates URL TEXT before the request. It cannot stop a
// hostname that resolves to a denied address (DNS rebinding), nor a redirect
// that lands on one. Redirects are not followed by any current caller, which is
// what keeps that gap closed today; any future redirect support must re-check
// every hop against this same function.

const net = require("net");
const { METADATA_HOSTS } = require("../compute/endpoint-guard");

function stripBrackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLinkLocal(host) {
  const version = net.isIP(host);
  if (version === 4) return /^169\.254\./.test(host);
  if (version === 6) return /^fe[89ab]/.test(host.toLowerCase());
  return false;
}

// Loopback, RFC1918, CGNAT (100.64/10), IPv6 unique-local (fc00::/7), and the
// unspecified addresses that resolve to loopback on most stacks.
function isPrivateAddress(host) {
  const version = net.isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    if (octets[0] === 127 || octets[0] === 0) return true;
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
    return false;
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    if (normalized === "::1" || normalized === "::") return true;
    if (/^f[cd]/.test(normalized)) return true;
    // IPv4-mapped addresses must not launder a private v4 address. WHATWG URL
    // parsing rewrites ::ffff:127.0.0.1 into its hex form (::ffff:7f00:1), so
    // both spellings have to be unmapped before the v4 rules are applied.
    const dotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
    return false;
  }
  // Not a literal IP. Hostnames that unambiguously name the local host are
  // treated as loopback; anything else can only be resolved at connect time.
  return isLocalhostName(host);
}

function isLocalhostName(host) {
  const h = host.toLowerCase();
  return h === "localhost" || h === "localhost.localdomain" || h.endsWith(".localhost");
}

function privateFetchAllowed() {
  return String(process.env.SIDEKICK_ALLOW_PRIVATE_FETCH || "").toLowerCase() === "true";
}

/**
 * Returns an error message describing why the target is refused, or null when
 * the URL may be requested. `label` names the argument in the message so the
 * caller sees which input was rejected.
 */
function validateOutboundUrl(value, label = "url") {
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

  if (METADATA_HOSTS.has(host)) {
    return `Refused ${label} host "${host}": cloud metadata endpoints are never a valid fetch target`;
  }
  if (isLinkLocal(host)) {
    return `Refused ${label} host "${host}": link-local addresses are never a valid fetch target`;
  }
  if (isPrivateAddress(host) && !privateFetchAllowed()) {
    return `Refused ${label} host "${host}": private and loopback addresses are not fetchable. ` +
      "Set SIDEKICK_ALLOW_PRIVATE_FETCH=true to allow requests to your own network.";
  }
  return null;
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
]);

/**
 * Drops caller headers that must not be overridable. Returns the accepted
 * headers plus the names that were refused, so the caller can report them
 * rather than silently ignoring the request.
 */
function filterRequestHeaders(headers) {
  const accepted = {};
  const rejected = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (FORBIDDEN_REQUEST_HEADERS.has(String(key).toLowerCase())) rejected.push(key);
    else accepted[key] = value;
  }
  return { accepted, rejected };
}

module.exports = {
  validateOutboundUrl,
  filterRequestHeaders,
  isPrivateAddress,
  isLinkLocal,
  FORBIDDEN_REQUEST_HEADERS,
};
