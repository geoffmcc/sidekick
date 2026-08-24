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
        if (res.statusCode === 429 && rateLimitError) return reject(new Error(rateLimitError));
        if (res.statusCode >= 400) {
          let detail = data.substring(0, 200);
          try {
            const parsed = JSON.parse(data);
            detail = parsed.error?.message || parsed.error || parsed.message || detail;
          } catch {}
          return reject(new Error(`${errorPrefix} ${res.statusCode}: ${detail}`));
        }
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
