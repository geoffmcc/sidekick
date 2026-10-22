"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const { resolveOutboundUrl } = require("./outbound-url");

const REQUEST_TIMEOUT_MS = 5000;
const MAX_HEADER_BYTES = 16 * 1024;

function createPinnedLookup(destination) {
  const address = String(destination.address || "");
  const family = Number(destination.family) || net.isIP(address);
  if (!family) throw new Error("Endpoint DNS resolution did not produce a pinned address");

  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function createEndpointProbe({ resolve = resolveOutboundUrl, request = requestEndpointStatus } = {}) {
  async function checkEndpoint(target, networkScope = null, networkScopeRevision = null) {
    const destination = await resolve(
      target,
      "endpoint",
      networkScope ? { networkScope, networkScopeRevision } : {},
    );
    if (destination?.refusal) {
      if (destination.code === "dns_resolution_failed") return { status: 0, ok: false, error: "dns_resolution_failed" };
      const error = new Error(destination.refusal);
      error.code = destination.code || "outbound_target_denied";
      error.policyDenied = true;
      throw error;
    }

    return request(destination.url, destination);
  }

  return { checkEndpoint };
}

function requestEndpointStatus(url, destination) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const request = transport.request(url, {
      method: "GET",
      agent: false,
      maxHeaderSize: MAX_HEADER_BYTES,
      lookup: createPinnedLookup(destination),
    }, response => {
      const status = Number(response.statusCode) || 0;
      // Health checks need only the status line. Destroy the response without
      // downloading an untrusted or unbounded body, and never follow redirects.
      response.destroy();
      finish({ status, ok: status >= 200 && status < 300 });
    });

    request.on("error", () => finish({ status: 0, ok: false }));
    timer = setTimeout(() => {
      request.destroy(new Error("endpoint probe timed out"));
      finish({ status: 0, ok: false });
    }, REQUEST_TIMEOUT_MS);
    request.end();
  });
}

const { checkEndpoint } = createEndpointProbe();

module.exports = {
  MAX_HEADER_BYTES,
  REQUEST_TIMEOUT_MS,
  createEndpointProbe,
  createPinnedLookup,
  checkEndpoint,
  requestEndpointStatus,
};
