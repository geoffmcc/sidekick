"use strict";

/**
 * The Proxmox VE API client.
 *
 * One place builds every request. The invariants this file owns:
 *
 *  - The endpoint comes from a validated administrator-configured profile.
 *    Nothing model-supplied ever chooses a destination.
 *  - The API token travels ONLY in the Authorization header — never in a URL,
 *    never in a log, never in an error, never in a result. Any text that
 *    could echo it (Proxmox error bodies can reflect request headers) has the
 *    literal token split-replaced out before it can reach an Error object.
 *  - TLS verification is always on. A profile may PIN additional trust with
 *    ca_pem (the Proxmox cluster CA, or the node's self-signed certificate);
 *    there is no insecure mode and no code path that sets
 *    rejectUnauthorized: false.
 *  - Every path segment is validated upstream and URL-encoded here anyway,
 *    so an identifier can never smuggle path syntax.
 *  - Requests carry bounded timeouts and honor the dispatcher's cancellation
 *    signal. Responses are size-capped before parsing.
 *  - GET requests may be retried once on transient transport failures.
 *    Mutating requests are NEVER retried: after an ambiguous failure the
 *    caller must inspect state, not replay the mutation.
 */

const https = require("https");
const net = require("net");
const { ProxmoxError, classifyNetworkError, classifyHttpError } = require("./errors");

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const API_BASE = "/api2/json";
// Transient transport errors worth a single idempotent-GET retry. Refusals,
// DNS failures and TLS failures are not transient; timeouts are ambiguous and
// retried only for GETs (a timed-out GET cannot have mutated anything).
const RETRYABLE_GET_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"]);

/** Remove the token (and any Authorization echo) from text destined for errors or results. */
function scrubSecrets(text, token) {
  let out = typeof text === "string" ? text : JSON.stringify(text);
  if (out === undefined || out === null) return "";
  if (token) out = out.split(token).join("[REDACTED]");
  return out
    .replace(/(PVEAPIToken=)[^\s"',]+/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*[:=]\s*)[^\s"',]+/gi, "$1[REDACTED]");
}

// Escape a path segment the way Proxmox expects: '/' (the segment separator)
// and the genuinely path-unsafe characters are percent-encoded, but ':' '@'
// '!' '=' are left literal. A UPID legitimately contains ':' '@' '!' '='
// (`UPID:node:...:user@realm!token:`), and some Proxmox builds reject the
// percent-encoded form. Every segment reaching here has already passed strict
// validation upstream, so this is a compatibility encoder, not the security
// boundary. Anything outside the known-safe set is still encoded, fail-safe.
const PATH_SAFE_RE = /[A-Za-z0-9._~:@!=-]/;
function pathEscapeSegment(value) {
  let out = "";
  for (const ch of value) {
    out += PATH_SAFE_RE.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
}

function buildApiPath(segments) {
  const parts = [];
  for (const segment of segments) {
    const value = String(segment);
    if (!value.length) throw new ProxmoxError("invalid_input", "Empty API path segment");
    parts.push(pathEscapeSegment(value));
  }
  return `${API_BASE}/${parts.join("/")}`;
}

function encodeParams(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  return search.toString();
}

/**
 * Create a client bound to one resolved profile and one resolved credential.
 * The token is captured in this closure and never placed on the returned
 * object, so nothing that serializes the client can see it.
 */
function createClient({ profile, token, signal }) {
  if (!profile || !profile.endpointParsed) throw new ProxmoxError("profile_invalid", "Client requires a resolved profile");
  if (!token) throw new ProxmoxError("credential_missing", `No API token available for profile "${profile.name}"`);

  const { hostname, port } = profile.endpointParsed;
  const requestTimeoutMs = profile.request_timeout_ms || DEFAULT_REQUEST_TIMEOUT_MS;

  function rawRequest(method, segments, params, options = {}) {
    const apiPath = buildApiPath(segments);
    const query = method === "GET" ? encodeParams(params) : "";
    const body = method === "GET" ? null : encodeParams(params);
    const timeoutMs = options.timeoutMs || requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname,
        port,
        method,
        path: query ? `${apiPath}?${query}` : apiPath,
        // TLS: verification stays ON. ca REPLACES the default root store for
        // this connection, which is exactly right for a pinned cluster CA.
        rejectUnauthorized: true,
        ...(profile.ca_pem ? { ca: profile.ca_pem } : {}),
        // SNI is only meaningful for hostnames; setting it to an IP literal is
        // an RFC 6066 violation Node warns about and future versions ignore.
        ...(net.isIP(hostname) ? {} : { servername: hostname }),
        headers: {
          Authorization: `PVEAPIToken=${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
        },
        timeout: timeoutMs,
      };

      const request = https.request(requestOptions, response => {
        const chunks = [];
        let received = 0;
        response.on("data", chunk => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            request.destroy();
            reject(new ProxmoxError("response_invalid", `Response from ${hostname} exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
        response.on("error", error => reject(classifyNetworkError(error, hostname)));
      });

      request.on("timeout", () => {
        request.destroy(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }));
      });
      request.on("error", error => reject(classifyNetworkError(error, hostname)));

      if (signal) {
        if (signal.aborted) {
          request.destroy(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
        } else {
          const onAbort = () => request.destroy(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
          signal.addEventListener("abort", onAbort, { once: true });
          request.on("close", () => signal.removeEventListener("abort", onAbort));
        }
      }

      if (body) request.write(body);
      request.end();
    });
  }

  async function request(method, segments, params, options = {}) {
    let response;
    try {
      response = await rawRequest(method, segments, params, options);
    } catch (error) {
      const classified = error instanceof ProxmoxError ? error : classifyNetworkError(error, hostname);
      const retryable = method === "GET" && !options.noRetry && RETRYABLE_GET_CODES.has(classified.details?.cause);
      if (!retryable) throw classified;
      // One retry, GETs only: a timed-out or reset read is safe to reissue.
      response = await rawRequest(method, segments, params, { ...options, noRetry: true });
    }

    let parsed;
    try {
      parsed = response.body ? JSON.parse(response.body) : {};
    } catch {
      if (response.status >= 200 && response.status < 300) {
        throw new ProxmoxError("response_invalid", `Proxmox returned a non-JSON response (status ${response.status})`);
      }
      parsed = {};
    }

    if (response.status < 200 || response.status >= 300) {
      // PVE error bodies: { message?, errors?: {field: reason}, data: null }.
      // Status lines carry the useful message on many endpoints.
      const messageParts = [];
      if (parsed && typeof parsed.message === "string") messageParts.push(parsed.message.trim());
      if (parsed && parsed.errors && typeof parsed.errors === "object") {
        for (const [field, reason] of Object.entries(parsed.errors).slice(0, 8)) {
          messageParts.push(`${field}: ${String(reason).trim()}`);
        }
      }
      const scrubbed = scrubSecrets(messageParts.join("; ").slice(0, 2000), token);
      throw classifyHttpError(response.status, scrubbed, { path: buildApiPath(segments) });
    }

    return parsed ? parsed.data : undefined;
  }

  return {
    profileName: profile.name,
    endpoint: profile.endpointParsed.value,
    get: (segments, params, options) => request("GET", segments, params, options),
    post: (segments, params, options) => request("POST", segments, params, { ...(options || {}), noRetry: true }),
    scrub: text => scrubSecrets(text, token),
  };
}

module.exports = { createClient, scrubSecrets, buildApiPath, MAX_RESPONSE_BYTES };
