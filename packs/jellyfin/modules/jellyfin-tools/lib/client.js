"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const { JellyfinError } = require("./errors");

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function scrub(value, key) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  if (key) text = text.split(key).join("[REDACTED]");
  return text
    .replace(
      /(api[_-]?key|token|authorization)\s*[:=]\s*["']?[^\s,"'}]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 2000);
}

function classifyNetworkError(error, key) {
  if (error?.code === "ABORT_ERR")
    return new JellyfinError("timeout", "Jellyfin request cancelled");
  if (
    [
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    ].includes(error?.code)
  ) {
    return new JellyfinError("tls_failed", "Jellyfin TLS verification failed");
  }
  if (error?.code === "ETIMEDOUT")
    return new JellyfinError("timeout", "Jellyfin request timed out");
  return new JellyfinError(
    "connection_failed",
    `Jellyfin connection failed: ${scrub(error?.message || error, key)}`,
  );
}

function classifyStatus(status, data, key) {
  // 401/403 are the credential; 404 is the object/route; 400 is OUR request
  // shape (invalid_input, not a server fault); 429 is throttling the caller
  // should surface as such rather than a generic failure.
  if (status === 400)
    return new JellyfinError(
      "invalid_input",
      scrub(data?.Message || data?.message || "Jellyfin rejected the request as invalid", key),
    );
  if (status === 401 || status === 403)
    return new JellyfinError(
      "authentication_failed",
      "Jellyfin rejected the configured API credential",
    );
  if (status === 404)
    return new JellyfinError(
      "not_found",
      "Jellyfin endpoint or object was not found",
    );
  if (status === 429)
    return new JellyfinError("rate_limited", "Jellyfin rate limited the request");
  return new JellyfinError(
    "server_error",
    scrub(data?.Message || data?.message || `Jellyfin returned HTTP ${status}`, key),
    { status },
  );
}

function createClient(profile, key, signal, ca) {
  const origin = profile.endpoint;
  const basePath =
    origin.pathname === "/" ? "" : origin.pathname.replace(/\/$/, "");
  // The CA actually used for pinning: the caller threads the RESOLVED value
  // (profiles.credential() resolves ca_secret_ref) so a pinned-CA profile pins
  // even when the PEM lives in the secret store, not inline configuration.
  const pinnedCa = ca || profile.ca_pem || null;

  function buildOptions(method, url, extraHeaders) {
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method,
      timeout: profile.timeout,
      headers: {
        Accept: "application/json",
        Authorization: `MediaBrowser Client="Sidekick", Device="Sidekick", DeviceId="sidekick", Version="1.0", Token="${key}"`,
        ...(extraHeaders || {}),
      },
    };
    if (url.protocol === "https:") {
      options.rejectUnauthorized = true;
      if (pinnedCa) options.ca = pinnedCa;
      if (!net.isIP(url.hostname)) options.servername = url.hostname;
    }
    return options;
  }

  function buildUrl(requestPath, query) {
    const url = new URL(basePath + requestPath, origin);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null)
        url.searchParams.set(name, String(value));
    }
    return url;
  }

  function request(method, requestPath, query, body) {
    const url = buildUrl(requestPath, query);
    const transport = url.protocol === "https:" ? https : http;
    const options = buildOptions(method, url);

    return new Promise((resolve, reject) => {
      let requestHandle;
      const fail = (error) => reject(classifyNetworkError(error, key));

      requestHandle = transport.request(options, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            requestHandle.destroy();
            reject(
              new JellyfinError(
                "server_error",
                "Jellyfin response exceeded the bounded response size",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            reject(
              new JellyfinError(
                "connection_failed",
                "Jellyfin redirect refused",
              ),
            );
            return;
          }

          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              if (response.statusCode >= 200 && response.statusCode < 300) {
                reject(
                  new JellyfinError(
                    "server_error",
                    "Jellyfin returned invalid JSON",
                  ),
                );
                return;
              }
            }
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(classifyStatus(response.statusCode, data, key));
          } else {
            resolve(data);
          }
        });
      });

      requestHandle.on("error", fail);
      requestHandle.on("timeout", () =>
        requestHandle.destroy(
          Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        ),
      );
      if (signal) {
        if (signal.aborted)
          requestHandle.destroy(
            Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }),
          );
        else
          signal.addEventListener(
            "abort",
            () =>
              requestHandle.destroy(
                Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }),
              ),
            { once: true },
          );
      }

      if (body) {
        const raw = JSON.stringify(body);
        requestHandle.setHeader("Content-Type", "application/json");
        requestHandle.setHeader("Content-Length", Buffer.byteLength(raw));
        requestHandle.write(raw);
      }
      requestHandle.end();
    });
  }

  /**
   * Bounded tail retrieval for text endpoints (GET /System/Logs/Log returns
   * text/plain, not JSON). Honesty contract: the returned text is a TRUE tail
   * of the file or the call reports why one could not be obtained — a partial
   * head read is never passed off as a tail.
   *
   *   - Sends `Range: bytes=-N` first; a 206 is the exact tail.
   *   - A 200 small enough to read fully is read and sliced to the tail.
   *   - A 200 too large to read fully (server ignored Range) is refused with
   *     `log_too_large_without_range_support` rather than mislabelled.
   *   - 416 on a suffix range means an empty file: an empty tail, honestly.
   */
  function getTail(requestPath, query, tailBytes) {
    const bounded = Math.min(1024 * 1024, Math.max(1024, tailBytes || 65536));
    const url = buildUrl(requestPath, query);
    const transport = url.protocol === "https:" ? https : http;
    const options = buildOptions("GET", url, {
      Accept: "text/plain, application/json",
      Range: `bytes=-${bounded}`,
    });

    return new Promise((resolve, reject) => {
      let requestHandle;
      const fail = (error) => reject(classifyNetworkError(error, key));
      requestHandle = transport.request(options, (response) => {
        const status = response.statusCode;
        if (status === 416) {
          // Suffix range on an empty file: nothing to tail.
          response.resume();
          resolve({ ok: true, method: "range", text: "", total_size: 0, status });
          return;
        }
        if (status < 200 || status >= 300) {
          // Includes redirects: an authenticated request must not follow a
          // Location to a different origin, so any 3xx is refused here too.
          const chunks = [];
          response.on("data", (c) => { if (chunks.reduce((s, x) => s + x.length, 0) < 8192) chunks.push(c); });
          response.on("end", () => {
            let data = {};
            try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
            reject(classifyStatus(status, data, key));
          });
          return;
        }
        const declared = Number(response.headers["content-length"]);
        const contentRange = String(response.headers["content-range"] || "");
        const totalFromRange = contentRange.includes("/") ? Number(contentRange.split("/").pop()) : NaN;
        if (status === 200 && Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          requestHandle.destroy();
          resolve({ ok: false, reason: "log_too_large_without_range_support", total_size: declared, status });
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            // Reading was cut off mid-file: what we hold is a HEAD fragment,
            // not a tail — refuse rather than misrepresent it.
            requestHandle.destroy();
            resolve({ ok: false, reason: "log_too_large_without_range_support", total_size: Number.isFinite(declared) ? declared : null, status });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const tail = status === 206 ? buffer : buffer.subarray(Math.max(0, buffer.length - bounded));
          resolve({
            ok: true,
            method: status === 206 ? "range" : "full_read_tail",
            text: tail.toString("utf8"),
            total_size: status === 206
              ? (Number.isFinite(totalFromRange) ? totalFromRange : null)
              : buffer.length,
            status,
          });
        });
      });
      requestHandle.on("error", fail);
      requestHandle.on("timeout", () =>
        requestHandle.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
      );
      if (signal) {
        const abort = () =>
          requestHandle.destroy(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
      requestHandle.end();
    });
  }

  return {
    get: (path, query) => request("GET", path, query, null),
    post: (path, body) => request("POST", path, null, body),
    del: (path) => request("DELETE", path, null, null),
    getTail,
    origin: origin.origin,
  };
}

module.exports = { createClient, scrub, MAX_RESPONSE_BYTES };
