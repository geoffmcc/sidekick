"use strict";

const http = require("http");
const https = require("https");
const { resolveOutboundUrl } = require("../security/outbound-url");
const { validateEndpoint } = require("./endpoint-guard");

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Make a provider request against a DNS-pinned destination. Provider
 * endpoints are administrator-configured provider destinations. Private
 * addresses are allowed for local providers, while metadata and link-local
 * destinations remain forbidden. Redirects are not followed.
 */
async function requestJson({ endpoint, path, method = "POST", headers = {}, body = null, timeout = 60000, label = "provider endpoint", errorPrefix = "Provider", rateLimitError = null }) {
  const endpointError = validateEndpoint(endpoint);
  if (endpointError) throw new Error(endpointError);

  const target = new URL(path, endpoint);
  const resolved = await resolveOutboundUrl(target.href, label, { allowPrivate: true });
  if (resolved.refusal) throw new Error(resolved.refusal);

  const bodyStr = body === null || body === undefined ? null : JSON.stringify(body);
  const requestHeaders = { ...headers };
  if (bodyStr) requestHeaders["Content-Length"] = Buffer.byteLength(bodyStr);
  requestHeaders.Host = target.host;

  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request({
      hostname: resolved.address,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: requestHeaders,
      ...(isHttps ? { servername: target.hostname } : {}),
    }, (res) => {
      if (res.statusCode >= 400) {
        const status = Number.isInteger(res.statusCode) ? res.statusCode : 500;
        const message = status === 429 && rateLimitError
          ? rateLimitError
          : `${errorPrefix} request failed (HTTP ${status})`;
        const error = Object.assign(new Error(message), { code: `HTTP_${status}` });
        // Provider response bodies are untrusted and can echo credentials or
        // include arbitrary diagnostics. Drain without retaining or exposing
        // the body, and keep only the protocol status in the error.
        res.resume();
        reject(error);
        return;
      }
      let data = "";
      let bytes = 0;
      res.on("data", chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`${errorPrefix} response too large`));
          return;
        }
        data += chunk;
      });
      res.on("end", () => {
        if (bytes > MAX_RESPONSE_BYTES) return;
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`${errorPrefix} parse error`)); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(new Error(`${errorPrefix} timeout`)); });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = { requestJson, MAX_RESPONSE_BYTES };
