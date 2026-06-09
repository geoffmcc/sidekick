const express = require("express");
const cors = require("cors");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { WebStandardStreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const { z } = require("zod");
const { TOOLS, TOOL_DEFS, DATA_DIR, setSource, logToolCall } = require("./tools");

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

// --- Factory: create fresh McpServer + register tools ---

function createMcpServer() {
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
      const start = Date.now();
      try {
        const result = await TOOLS[def.name](args);
        logToolCall(def.name, args, Date.now() - start, true,
          result.content?.[0]?.text?.substring(0, 80) || "(ok)"
        );
        return result;
      } catch (e) {
        logToolCall(def.name, args, Date.now() - start, false, e.message);
        throw e;
      }
    });
  }

  return server;
}

// --- Session management: one McpServer + Transport pair per session ---

const sessions = new Map();

function generateSessionId() {
  return "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function getTransportForRequest(sessionId) {
  // Return existing transport if session exists
  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId);
    entry.lastAccess = Date.now();
    return { transport: entry.transport, isNew: false };
  }

  // Create fresh McpServer + Transport pair
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => generateSessionId(),
    enableJsonResponse: true
  });

  // Connect server to transport (one-time per server instance)
  await server.connect(transport);

  return { transport, isNew: true };
}

function registerSession(sessionId, transport) {
  sessions.set(sessionId, {
    transport,
    createdAt: Date.now(),
    lastAccess: Date.now()
  });
}

// Cleanup sessions inactive for more than 1 hour, every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, entry] of sessions) {
    if (entry.lastAccess < cutoff) {
      sessions.delete(id);
    }
  }
}, 600000);

// --- Express app ---

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

// --- Diagnostic logging ---

function logSession(method, headers, body) {
  const sessionId = headers["mcp-session-id"] || headers["Mcp-Session-Id"] || "none";
  const methodType = body ? (typeof body === "object" ? body.method : "unknown") : "unknown";
  console.log(`[MCP ${method}] session=${sessionId} method=${methodType}`);
}

// --- MCP routes ---

app.post("/mcp", async (req, res) => {
  try {
    const body = typeof req.body === "object" ? JSON.stringify(req.body) : req.body || "";
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("POST", wh, req.body);

    const { transport, isNew } = await getTransportForRequest(sessionId);

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "POST",
      headers: wh,
      body: body
    });

    const webRes = await transport.handleRequest(webReq, { parsedBody: req.body });

    // Capture session ID from response headers for new sessions
    if (isNew) {
      const newSessionId = webRes.headers.get("mcp-session-id");
      if (newSessionId) {
        registerSession(newSessionId, transport);
      }
    }

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
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("GET", wh, null);

    const { transport, isNew } = await getTransportForRequest(sessionId);

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "GET",
      headers: wh
    });

    const webRes = await transport.handleRequest(webReq);

    if (isNew) {
      const newSessionId = webRes.headers.get("mcp-session-id");
      if (newSessionId) {
        registerSession(newSessionId, transport);
      }
    }

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
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("DELETE", wh, null);

    const { transport, isNew } = await getTransportForRequest(sessionId);

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "DELETE",
      headers: wh
    });

    const webRes = await transport.handleRequest(webReq);

    if (isNew) {
      const newSessionId = webRes.headers.get("mcp-session-id");
      if (newSessionId) {
        registerSession(newSessionId, transport);
      }
    }

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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Sidekick MCP server listening on port " + PORT);
  console.log("MCP endpoint: http://0.0.0.0:" + PORT + "/mcp");
  console.log("Data dir: " + DATA_DIR);
});
