"use strict";

// Network fetch tool family: web_fetch.
//
// Extracted from src/tools-legacy.js. Uses only Node's http/https — no
// tools-legacy.js dependency. `web_fetch` is `medium` risk (it performs
// outbound HTTP from the host); the classification is preserved from
// src/tools/metadata.js and gated by the dispatcher.

const { z } = require("zod");

async function sidekick_web_fetch({ url: targetUrl, method, headers, body }) {
  const https = require("https");
  const http = require("http");
  return new Promise((resolve) => {
    const urlObj = new URL(targetUrl);
    const lib = urlObj.protocol === "https:" ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method || "GET",
      headers: { "User-Agent": "Sidekick-MCP/1.0" },
      timeout: 30000
    };
    if (headers) {
      try { Object.assign(options.headers, JSON.parse(headers)); } catch (e) {}
    }
    if (body) {
      options.headers["Content-Type"] = options.headers["Content-Type"] || "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        resolve({ content: [{ type: "text", text: "Status: " + res.statusCode + "\n\n" + data }] });
      });
    });
    req.on("error", (err) => resolve({ content: [{ type: "text", text: "Error: " + err.message }], isError: true }));
    req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Request timed out" }], isError: true }); });
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
