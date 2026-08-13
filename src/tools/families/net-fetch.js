"use strict";

// Network fetch tool family: web_fetch.
//
// Extracted from src/tools-legacy.js. Uses only Node's http/https — no
// tools-legacy.js dependency. `web_fetch` is `medium` risk (it performs
// outbound HTTP from the host); the classification is preserved from
// src/tools/metadata.js and gated by the dispatcher.

const { z } = require("zod");
const { validateOutboundUrl, filterRequestHeaders } = require("../../security/outbound-url");

const DEFAULT_TIMEOUT_MS = 30000;
// Responses are accumulated in memory and returned as tool output, so an
// unbounded body is a memory-exhaustion vector as well as a context flood.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function errorText(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function sidekick_web_fetch({ url: targetUrl, method, headers, body }, runtime = {}) {
  const https = require("https");
  const http = require("http");

  // Destination policy first: this tool makes requests with the server's own
  // network identity, so an unvalidated target reaches anything the host can.
  const refusal = validateOutboundUrl(targetUrl);
  if (refusal) return errorText("Error: " + refusal);

  // The dispatcher's deadline governs the socket too, not just the wrapper
  // promise — otherwise a cancelled call leaves the request running.
  const timeoutMs = Number(runtime?.context?.timeoutMs) > 0
    ? Math.min(Number(runtime.context.timeoutMs), DEFAULT_TIMEOUT_MS * 10)
    : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const urlObj = new URL(targetUrl);
    const lib = urlObj.protocol === "https:" ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method || "GET",
      headers: { "User-Agent": "Sidekick-MCP/1.0" },
      timeout: timeoutMs
    };
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
    req.on("error", (err) => finish(errorText("Error: " + err.message)));
    req.on("timeout", () => { req.destroy(); finish(errorText("Request timed out after " + timeoutMs + "ms")); });
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
    }),
    args: { url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" },
    risk: "medium",
    category: "Core",
    source: "builtin",
    family: "net-fetch",
    handler: sidekick_web_fetch,
  }),
]);

module.exports = { descriptors, sidekick_web_fetch };
