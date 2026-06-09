const express = require("express");
const cors = require("cors");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { WebStandardStreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const { z } = require("zod");
const { TOOLS, TOOL_DEFS, DATA_DIR, setSource } = require("./tools");

const API_KEY = process.env.SIDEKICK_API_KEY || "sk-sidekick-local-dev";
const PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const ALLOWED_IPS = (process.env.SIDEKICK_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);

const TOOL_SCHEMAS = {
  sidekick_bash: z.object({ command: z.string().describe("Shell command to execute") }),
  sidekick_read: z.object({ path: z.string().describe("Absolute path to the file to read") }),
  sidekick_write: z.object({ path: z.string().describe("Absolute path to write to"), content: z.string().describe("File content to write") }),
  sidekick_store: z.object({ key: z.string().describe("Storage key"), value: z.string().describe("Value to store") }),
  sidekick_get: z.object({ key: z.string().describe("Storage key to retrieve") }),
  sidekick_list: z.object({ path: z.string().optional().default("/home/sidekick").describe("Directory path to list") }),
  sidekick_web_fetch: z.object({
    url: z.string().describe("URL to fetch"),
    method: z.enum(["GET", "POST"]).optional().default("GET").describe("HTTP method"),
    headers: z.string().optional().describe("JSON object of extra headers"),
    body: z.string().optional().describe("Request body (for POST)")
  }),
  sidekick_llm: z.object({
    prompt: z.string().describe("The prompt to send to the LLM"),
    system: z.string().optional().describe("System prompt override"),
    temperature: z.number().optional().default(0.7).describe("Sampling temperature (0-2)")
  }),
};

const server = new McpServer({
  name: "sidekick-mcp-server",
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});

for (const def of TOOL_DEFS) {
  server.registerTool(def.name, {
    description: def.description,
    inputSchema: TOOL_SCHEMAS[def.name]
  }, async (args, extra) => {
    setSource("mcp");
    return TOOLS[def.name](args);
  });
}

const app = express();

if (ALLOWED_IPS.length) {
  app.use((req, res, next) => {
    const ip = req.ip === "::ffff:127.0.0.1" ? "127.0.0.1" : req.ip;
    if (ip === "127.0.0.1" || ip === "::1" || ALLOWED_IPS.includes(ip)) {
      return next();
    }
    return res.status(403).json({ error: "Forbidden" });
  });
}

app.use((req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader ? authHeader.replace("Bearer ", "") : req.query.api_key;
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.use(express.json({ limit: "1mb" }));

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
  enableJsonResponse: true
});

// Diagnostic logging for session investigation
function logSession(method, headers, body) {
  const sessionId = headers["mcp-session-id"] || headers["Mcp-Session-Id"] || "none";
  const methodType = body ? (typeof body === "object" ? body.method : "unknown") : "unknown";
  console.log(`[MCP ${method}] session=${sessionId} method=${methodType}`);
}

app.post("/mcp", async (req, res) => {
  try {
    const body = typeof req.body === "object" ? JSON.stringify(req.body) : req.body || "";
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    logSession("POST", wh, req.body);
    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "POST",
      headers: wh,
      body: body
    });
    const webRes = await transport.handleRequest(webReq, { parsedBody: req.body });
    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    const text = await webRes.text();
    if (text) res.send(text);
    else res.end();
  } catch (e) {
    console.error("MCP error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get("/mcp", async (req, res) => {
  try {
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "GET",
      headers: wh
    });
    const webRes = await transport.handleRequest(webReq);
    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    if (webRes.body) {
      const reader = webRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(Buffer.from(value));
        }
      };
      await pump();
    } else {
      res.end();
    }
  } catch (e) {
    console.error("MCP GET error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.delete("/mcp", async (req, res) => {
  try {
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "DELETE",
      headers: wh
    });
    const webRes = await transport.handleRequest(webReq);
    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    const text = await webRes.text();
    if (text) res.send(text);
    else res.end();
  } catch (e) {
    console.error("MCP DELETE error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

server.connect(transport);

app.listen(PORT, "0.0.0.0", () => {
  console.log("Sidekick MCP server listening on port " + PORT);
  console.log("MCP endpoint: http://0.0.0.0:" + PORT + "/mcp");
  console.log("Data dir: " + DATA_DIR);
});
