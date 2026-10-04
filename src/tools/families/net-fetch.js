"use strict";

// Network fetch tool family: web_fetch.
//
// Extracted from src/tools-legacy.js. Uses only Node's http/https — no
// tools-legacy.js dependency. `web_fetch` is `medium` risk (it performs
// outbound HTTP from the host); the classification is preserved from
// src/tools/metadata.js and gated by the dispatcher.

const { z } = require("zod");
const { resolveOutboundUrl, filterRequestHeaders } = require("../../security/outbound-url");

const DEFAULT_TIMEOUT_MS = 30000;
// Responses are accumulated in memory and returned as tool output, so an
// unbounded body is a memory-exhaustion vector as well as a context flood.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function errorText(text, code = "network_request_failed", guidance = null) {
  const payload = { ok: false, code, error: text, ...(guidance ? { guidance } : {}) };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true, code, status: "failed", result_status: "failed" };
}

function connectionFailure(error) {
  const code = String(error?.code || "");
  if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return { code: "service_unreachable", guidance: "Verify the target service is running and reachable from Sidekick; this result does not establish that a firewall is responsible." };
  }
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) {
    return { code: "dns_resolution_failed", guidance: "Verify the hostname and DNS resolution from the Sidekick host." };
  }
  return { code: "network_unreachable", guidance: "Check the target endpoint and network path from the Sidekick host." };
}

async function sidekick_web_fetch({ url: targetUrl, method, headers, body, network_scope, network_scope_revision }, runtime = {}) {
  const https = require("https");
  const http = require("http");

  // Destination policy first: this tool makes requests with the server's own
  // network identity, so an unvalidated target reaches anything the host can.
  const destination = await resolveOutboundUrl(targetUrl, "url", network_scope ? { networkScope: network_scope, networkScopeRevision: network_scope_revision } : {});
  if (destination.refusal) {
    const code = destination.code || "outbound_target_denied";
    const guidance = code === "network_scope_required"
      ? "Private destinations require an existing operator-created named network scope; user consent or a tool approval does not create that scope."
      : code === "network_scope_unavailable"
        ? "Verify the configured scope name and immutable revision with the operator; scope changes must use the authorized scope-management path."
        : code === "network_scope_denied"
          ? "Ask the scope owner to review the current policy; this request did not broaden or change it."
          : code === "dns_resolution_failed"
            ? "Verify the hostname and DNS resolution from the Sidekick host."
            : "Choose a permitted destination and preserve the outbound-target policy.";
    return errorText(destination.refusal, code, guidance);
  }

  // The dispatcher's deadline governs the socket too, not just the wrapper
  // promise — otherwise a cancelled call leaves the request running.
  const timeoutMs = Number(runtime?.context?.timeoutMs) > 0
    ? Math.min(Number(runtime.context.timeoutMs), DEFAULT_TIMEOUT_MS * 10)
    : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const urlObj = destination.url;
    const lib = urlObj.protocol === "https:" ? https : http;
    const options = {
      hostname: destination.address,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method || "GET",
      headers: { "User-Agent": "Sidekick-MCP/1.0" },
      timeout: timeoutMs
    };
    options.headers.Host = urlObj.host;
    if (urlObj.protocol === "https:") options.servername = urlObj.hostname.replace(/^\[|\]$/g, "");
    if (headers) {
      let parsed = null;
      try { parsed = JSON.parse(headers); } catch {
        return resolve(errorText("Error: headers must be a JSON object"));
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return resolve(errorText("Error: headers must be a JSON object"));
      }
      // Refuse rather than silently drop: a caller that believes it set
      // Authorization should not think the request carried it.
      const { accepted, rejected } = filterRequestHeaders(parsed);
      if (rejected.length) {
        return resolve(errorText("Error: these headers may not be set by the caller: " + rejected.join(", ")));
      }
      Object.assign(options.headers, accepted);
    }
    if (body) {
      options.headers["Content-Type"] = options.headers["Content-Type"] || "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = lib.request(options, (res) => {
      let data = "";
      let bytes = 0;
      let truncated = false;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          truncated = true;
          res.destroy();
          return;
        }
        data += chunk;
      });
      res.on("close", () => {
        if (!truncated) return;
        finish({ content: [{ type: "text", text: "Status: " + res.statusCode + "\n\n" + data +
          "\n\n[truncated: response exceeded " + MAX_RESPONSE_BYTES + " bytes]" }] });
      });
      res.on("end", () => {
        finish({ content: [{ type: "text", text: "Status: " + res.statusCode + "\n\n" + data }] });
      });
    });
    req.on("error", err => {
      const failure = connectionFailure(err);
      finish(errorText("The outbound request could not reach the target service", failure.code, failure.guidance));
    });
    req.on("timeout", () => {
      req.destroy();
      finish(errorText(`Request timed out after ${timeoutMs}ms`, "network_timeout", "The target did not respond before the configured timeout; this does not establish whether the service or network path is at fault."));
    });
    if (body) req.write(body);
    req.end();
  });
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "web_fetch",
    description: "Fetch a URL from the remote machine",
    schema: z.object({
      url: z.string().describe("URL to fetch"),
      method: z.enum(["GET", "POST"]).optional().default("GET").describe("HTTP method"),
      headers: z.string().optional().describe("JSON object of extra headers"),
      body: z.string().optional().describe("Request body (for POST)"),
      network_scope: z.string().max(80).optional().describe("Exact operator-created named outbound network scope"),
      network_scope_revision: z.number().int().positive().optional().describe("Immutable named scope revision"),
    }),
    args: { url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)", network_scope: "string (optional; required for private destinations)", network_scope_revision: "number (optional; immutable revision)" },
    risk: "medium",
    category: "Core",
    source: "builtin",
    family: "net-fetch",
    handler: sidekick_web_fetch,
  }),
]);

module.exports = { descriptors, sidekick_web_fetch, connectionFailure, errorText };
