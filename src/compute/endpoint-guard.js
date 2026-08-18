// Validation for caller-supplied provider endpoints.
//
// A provider endpoint is a destination the server will POST inference payloads
// to, so a caller who can set it gets a request-forgery primitive. The policy
// here is deliberately an allowlist of schemes plus a denylist of destinations
// that are never legitimate providers — NOT a blanket block on private
// addressing. Loopback and RFC1918 providers are first-class: a host Ollama
// provider typically listens on http://127.0.0.1:11434, and an accelerator host
// is commonly a private LAN address.
//
// This is the write-time policy guard. Provider adapters additionally resolve
// and pin the destination before every request; metadata/link-local answers
// remain forbidden, and redirects are not followed. Keeping both checks is
// intentional: registry policy rejects unsafe configuration while the HTTP
// layer closes DNS-rebinding and post-registration resolution gaps.
const net = require("net");

// Hostnames that serve cloud instance credentials. Reaching any of these from
// a provider endpoint is never a legitimate inference call.
const METADATA_HOSTS = new Set([
  "169.254.169.254",          // AWS / Azure / OpenStack / DigitalOcean
  "fd00:ec2::254",            // AWS IMDSv2 over IPv6
  "100.100.100.200",          // Alibaba Cloud
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
]);

function stripBrackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLinkLocal(host) {
  const version = net.isIP(host);
  if (version === 4) return /^169\.254\./.test(host);
  if (version === 6) {
    const normalized = host.toLowerCase();
    // fe80::/10 spans fe80 through febf.
    return /^fe[89ab]/.test(normalized);
  }
  return false;
}

// Returns an error message, or null when the endpoint is acceptable.
function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return `Invalid base_url "${value}": not a valid URL`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Invalid base_url scheme "${url.protocol}": only http and https are allowed`;
  }
  if (url.username || url.password) {
    return "Invalid base_url: credentials embedded in the URL are not allowed; providers do not authenticate this way";
  }

  const host = stripBrackets(url.hostname).toLowerCase();
  if (!host) return "Invalid base_url: no host";
  if (isLinkLocal(host)) {
    return `Invalid base_url host "${host}": link-local addresses are not valid provider endpoints`;
  }
  if (METADATA_HOSTS.has(host)) {
    return `Invalid base_url host "${host}": cloud metadata endpoints are not valid provider endpoints`;
  }
  return null;
}

module.exports = { validateEndpoint, METADATA_HOSTS };
