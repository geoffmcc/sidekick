"use strict";

const http = require("node:http");
const https = require("node:https");
const { Readable } = require("node:stream");
const { resolveOutboundUrl } = require("./outbound-url");

/** Make one HTTP request to a DNS-validated, pinned destination. Redirects are never followed. */
async function requestPinnedHttp(value, options = {}, {
  label = "outbound endpoint",
  allowPrivate = false,
  timeoutMs = 30000,
} = {}) {
  const target = new URL(value);
  const destination = await resolveOutboundUrl(target.href, label, { allowPrivate });
  if (destination.refusal) throw new Error(destination.refusal);

  const signal = options.signal || AbortSignal.timeout(timeoutMs);
  if (signal.aborted) throw signal.reason || new Error(`${label} request aborted`);
  const transport = target.protocol === "https:" ? https : http;
  const requestOptions = {
    hostname: destination.address,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: options.method || "GET",
    headers: {
      "Accept-Encoding": "identity",
      ...(options.headers || {}),
      Host: target.host,
    },
    ...(target.protocol === "https:" ? { servername: target.hostname.replace(/^\[|\]$/g, "") } : {}),
  };

  return new Promise((resolve, reject) => {
    const request = transport.request(requestOptions, response => {
      const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response);
      resolve(new Response(body, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: response.headers,
      }));
    });
    const onAbort = () => request.destroy(signal.reason || new Error(`${label} request aborted`));
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("close", () => signal.removeEventListener("abort", onAbort));
    request.on("error", reject);
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

module.exports = { requestPinnedHttp };
