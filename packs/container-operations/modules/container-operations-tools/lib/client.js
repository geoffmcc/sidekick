"use strict";

const http = require("http");
const https = require("https");
const { ContainerError } = require("./errors");

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRYABLE = new Set(["ECONNRESET", "EPIPE"]);

function scrub(value) {
  return String(value || "").replace(/(password|token|authorization|secret)[^,;\s]*/gi, "$1=[REDACTED]");
}

function createClient(profile, signal) {
  const tls = require("./profiles").resolveTls(profile.tls);
  function request(method, path, body, retry = true) {
    return new Promise((resolve, reject) => {
      const parsed = profile.endpoint ? new URL(profile.endpoint) : null;
      const options = {
        method,
        path,
        timeout: profile.request_timeout_ms,
        ...(profile.socket ? { socketPath: profile.socket } : { hostname: parsed.hostname, port: parsed.port || 443, protocol: "https:", servername: tls.servername || parsed.hostname, ca: tls.ca, cert: tls.cert, key: tls.key, rejectUnauthorized: true }),
        headers: { Accept: "application/json" },
      };
      const transport = profile.socket ? http : https;
      const req = transport.request(options, response => {
        const chunks = []; let bytes = 0;
        response.on("data", chunk => { bytes += chunk.length; if (bytes > MAX_RESPONSE_BYTES) req.destroy(new ContainerError("response_too_large", "Engine response exceeded the bounded response limit")); else chunks.push(chunk); });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try { data = text ? JSON.parse(text) : {}; } catch { return reject(new ContainerError("provider_failure", "Engine returned invalid JSON", { status: response.statusCode })); }
          if (response.statusCode < 200 || response.statusCode >= 300) return reject(new ContainerError(response.statusCode === 401 ? "authentication_failed" : response.statusCode === 403 ? "permission_denied" : response.statusCode === 404 ? "resource_missing" : "provider_failure", `Engine request failed with HTTP ${response.statusCode}`, { status: response.statusCode, provider_error: scrub(data?.message || data?.error || "") }));
          resolve(data);
        });
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("engine request timed out"), { code: "ETIMEDOUT" })));
      req.on("error", error => {
        if (retry && method === "GET" && RETRYABLE.has(error.code)) return request(method, path, body, false).then(resolve, reject);
        if (error instanceof ContainerError) return reject(error);
        reject(new ContainerError(error.code === "ETIMEDOUT" ? "operation_timeout" : error.code === "ABORT_ERR" ? "operation_cancelled" : "engine_unreachable", `Engine request failed: ${error.code || "transport error"}`, { cause: error.code }));
      });
      if (signal) {
        if (signal.aborted) req.destroy(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
        else signal.addEventListener("abort", () => req.destroy(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })), { once: true });
      }
      if (body !== undefined) { const text = JSON.stringify(body); req.setHeader("Content-Type", "application/json"); req.setHeader("Content-Length", Buffer.byteLength(text)); req.write(text); }
      req.end();
    });
  }
  async function textRequest(method, path) {
    // Logs are intentionally handled separately: the engine returns a byte
    // stream, not JSON. The same timeout and response bound still apply.
    return new Promise((resolve, reject) => {
      const parsed = profile.endpoint ? new URL(profile.endpoint) : null;
      const options = { method, path, timeout: profile.request_timeout_ms, ...(profile.socket ? { socketPath: profile.socket } : { hostname: parsed.hostname, port: parsed.port || 443, servername: tls.servername || parsed.hostname, ca: tls.ca, cert: tls.cert, key: tls.key, rejectUnauthorized: true }), headers: { Accept: "text/plain" } };
      const transport = profile.socket ? http : https;
      const req = transport.request(options, response => { const chunks = []; let bytes = 0; response.on("data", c => { bytes += c.length; if (bytes <= MAX_RESPONSE_BYTES) chunks.push(c); }); response.on("end", () => { if (response.statusCode < 200 || response.statusCode >= 300) return reject(new ContainerError(response.statusCode === 404 ? "resource_missing" : "provider_failure", `Engine logs request failed with HTTP ${response.statusCode}`)); resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated: bytes > MAX_RESPONSE_BYTES }); }); });
      req.on("timeout", () => req.destroy(Object.assign(new Error("engine request timed out"), { code: "ETIMEDOUT" })));
      req.on("error", error => reject(error instanceof ContainerError ? error : new ContainerError(error.code === "ETIMEDOUT" ? "operation_timeout" : "engine_unreachable", `Engine logs request failed: ${error.code || "transport error"}`)));
      if (signal) signal.addEventListener("abort", () => req.destroy(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })), { once: true });
      req.end();
    });
  }
  return Object.freeze({ get: path => request("GET", path), post: (path, body) => request("POST", path, body), delete: path => request("DELETE", path), getText: path => textRequest("GET", path), postText: path => textRequest("POST", path) });
}

module.exports = { createClient, MAX_RESPONSE_BYTES };
