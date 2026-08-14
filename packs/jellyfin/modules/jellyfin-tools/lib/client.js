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

function createClient(profile, key, signal) {
  const origin = profile.endpoint;
  const basePath =
    origin.pathname === "/" ? "" : origin.pathname.replace(/\/$/, "");

  function request(method, requestPath, query, body) {
    const url = new URL(basePath + requestPath, origin);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null)
        url.searchParams.set(name, String(value));
    }

    const transport = url.protocol === "https:" ? https : http;
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
      },
    };

    if (url.protocol === "https:") {
      options.rejectUnauthorized = true;
      if (profile.ca_pem) options.ca = profile.ca_pem;
      if (!net.isIP(url.hostname)) options.servername = url.hostname;
    }

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

          if (response.statusCode === 401 || response.statusCode === 403) {
            reject(
              new JellyfinError(
                "authentication_failed",
                "Jellyfin rejected the configured API credential",
              ),
            );
          } else if (response.statusCode === 404) {
            reject(
              new JellyfinError(
                "not_found",
                "Jellyfin endpoint or object was not found",
              ),
            );
          } else if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new JellyfinError(
                "server_error",
                scrub(
                  data?.Message ||
                    data?.message ||
                    `Jellyfin returned HTTP ${response.statusCode}`,
                  key,
                ),
                { status: response.statusCode },
              ),
            );
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

  return {
    get: (path, query) => request("GET", path, query, null),
    post: (path, body) => request("POST", path, null, body),
    del: (path) => request("DELETE", path, null, null),
    origin: origin.origin,
  };
}

module.exports = { createClient, scrub, MAX_RESPONSE_BYTES };
