const express = require("express");
const cors = require("cors");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { WebStandardStreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const { z } = require("zod");
const { TOOLS, TOOL_DEFS, DATA_DIR, setSource, logToolCall, loadProcedures } = require("./tools");

const API_KEY = process.env.SIDEKICK_API_KEY || "sk-sidekick-local-dev";
const PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const ALLOWED_IPS = (process.env.SIDEKICK_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);

function logDebug(context, data) {
  const ts = new Date().toISOString();
  const prefix = `[MCP-DEBUG ${ts}]`;
  if (typeof data === 'string') {
    console.log(`${prefix} ${context}: ${data}`);
  } else {
    console.log(`${prefix} ${context}:`, JSON.stringify(data, null, 2));
  }
}

const TOOL_SCHEMAS = {
  sidekick_bash: z.object({ command: z.string().describe("Shell command to execute") }),
  sidekick_read: z.object({ path: z.string().describe("Absolute path to the file to read") }),
  sidekick_write: z.object({ path: z.string().describe("Absolute path to write to"), content: z.string().describe("File content to write") }),
  sidekick_store: z.object({ 
    key: z.string().describe("Storage key"), 
    value: z.string().describe("Value to store"),
    project: z.string().optional().describe("Project name (lowercase, underscores only)")
  }),
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
  sidekick_list_projects: z.object({}),
  sidekick_get_by_project: z.object({ project: z.string().describe("Project name to filter by") }),
  sidekick_search: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("Directory to search in (defaults to current directory)"),
    include: z.string().optional().describe("File pattern to include (e.g. '*.js', '*.ts')")
  }),
  sidekick_git: z.object({
    action: z.enum(["status", "diff", "log", "add", "commit", "push", "pull", "branch", "checkout", "stash"]).describe("Git action to perform"),
    path: z.string().optional().describe("Repository path (defaults to current directory)"),
    args: z.string().optional().describe("Additional arguments for the git command")
  }),
  sidekick_notify: z.object({
    channel: z.enum(["discord", "slack", "email"]).describe("Notification channel"),
    webhook_url: z.string().optional().describe("Webhook URL (required for discord/slack)"),
    recipient: z.string().optional().describe("Email recipient (required for email)"),
    message: z.string().describe("Message content to send"),
    title: z.string().optional().describe("Optional title/subject")
  }),
  sidekick_process: z.object({
    action: z.enum(["list", "top", "kill", "tree"]).describe("Process action to perform"),
    filter: z.string().optional().describe("Filter processes by name (for list action)"),
    pid: z.number().optional().describe("Process ID to kill"),
    name: z.string().optional().describe("Process name to kill (alternative to pid)"),
    signal: z.string().optional().describe("Signal to send when killing (default: TERM)")
  }),
  sidekick_service: z.object({
    action: z.enum(["start", "stop", "restart", "status", "enable", "disable", "logs"]).describe("Service action to perform"),
    service: z.string().describe("Systemd service name"),
    lines: z.number().optional().describe("Number of log lines to show (default: 50)")
  }),
  sidekick_archive: z.object({
    action: z.enum(["create", "extract", "list"]).describe("Archive action to perform"),
    path: z.string().describe("Source path (file/directory for create, archive for extract/list)"),
    output: z.string().optional().describe("Output path (required for create)"),
    format: z.string().optional().describe("Archive format: tar.gz, tgz, or zip (default: tar.gz)")
  }),
  sidekick_cron: z.object({
    action: z.enum(["add", "list", "remove", "run"]).describe("Cron action to perform"),
    name: z.string().optional().describe("Job name (required for add, optional for remove/run)"),
    schedule: z.string().optional().describe("Cron schedule expression (e.g. '0 * * * *' for hourly)"),
    command: z.string().optional().describe("Command to execute (required for add)"),
    id: z.string().optional().describe("Job ID (for remove/run)")
  }),
  sidekick_github: z.object({
    action: z.enum(["pr_list", "pr_create", "pr_get", "pr_merge", "issue_list", "issue_create", "issue_close", "commit_status", "release_create", "repo_info"]).describe("GitHub action to perform"),
    repo: z.string().describe("Repository in format 'owner/repo'"),
    args: z.string().optional().describe("Additional arguments (JSON string or value depending on action)")
  }),
  sidekick_webhook: z.object({
    action: z.enum(["list", "get", "clear"]).describe("Webhook action to perform"),
    id: z.string().optional().describe("Webhook ID (required for get)"),
    limit: z.number().optional().describe("Number of webhooks to list (default: 20)")
  }),
  sidekick_context: z.object({
    action: z.enum(["track_project", "track_decision", "track_problem", "track_pattern", "recall", "suggest", "summarize", "list"]).describe("Context action to perform"),
    project: z.string().optional().describe("Project name (for tracking and filtering)"),
    context: z.string().optional().describe("Context description (for decisions/patterns)"),
    decision: z.string().optional().describe("Decision made (for track_decision)"),
    reasoning: z.string().optional().describe("Reasoning behind decision (for track_decision)"),
    problem: z.string().optional().describe("Problem description (for track_problem)"),
    solution: z.string().optional().describe("Solution to problem (for track_problem)"),
    pattern: z.string().optional().describe("Pattern description (for track_pattern)"),
    query: z.string().optional().describe("Search query (for recall/suggest)"),
    type: z.string().optional().describe("Context type: decisions, problems, patterns, projects, or all (default: all)"),
    limit: z.number().optional().describe("Maximum results to return (default: 10)")
  }),
  sidekick_teach: z.object({
    action: z.enum(["teach_procedure", "generate_tool", "learn_from_example", "execute", "list", "remove"]).describe("Teach action to perform"),
    name: z.string().optional().describe("Procedure name (required for teach/generate/execute/remove)"),
    description: z.string().optional().describe("Procedure description (required for teach/generate)"),
    steps: z.array(z.object({ tool: z.string(), args: z.record(z.any()) })).optional().describe("Array of steps (required for teach_procedure)"),
    parameters: z.record(z.object({ type: z.enum(["string", "number", "boolean"]), description: z.string().optional(), required: z.boolean().optional() })).optional().describe("Parameter definitions for the procedure"),
    args: z.record(z.any()).optional().describe("Arguments to pass when executing a procedure"),
    example: z.string().optional().describe("Example to learn from (required for learn_from_example)"),
    trigger_phrases: z.array(z.string()).optional().describe("Trigger phrases for the procedure"),
    implementation: z.string().optional().describe("Implementation details (for generate_tool)")
  }),
};

// --- Factory: create fresh McpServer + register tools ---

function buildProcedureSchema(parameters) {
  const shape = {};
  for (const [key, def] of Object.entries(parameters || {})) {
    let field;
    if (def.type === "number") {
      field = z.number().describe(def.description || key);
    } else if (def.type === "boolean") {
      field = z.boolean().describe(def.description || key);
    } else {
      field = z.string().describe(def.description || key);
    }
    if (!def.required) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return z.object(shape);
}

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

  const procedures = loadProcedures();
  for (const [procName, proc] of Object.entries(procedures)) {
    const toolName = "sidekick_" + procName;
    if (TOOL_SCHEMAS[toolName]) continue;
    const paramSchema = buildProcedureSchema(proc.parameters);
    const paramNames = Object.keys(proc.parameters || {});
    const paramDesc = paramNames.length > 0 ? ` Parameters: ${paramNames.join(", ")}.` : "";
    server.registerTool(toolName, {
      description: `[procedure] ${proc.description}${paramDesc}`,
      inputSchema: paramSchema
    }, async (args, extra) => {
      setSource("mcp");
      const start = Date.now();
      try {
        const result = await TOOLS.sidekick_teach({ action: "execute", name: procName, args });
        logToolCall(toolName, args, Date.now() - start, !result.isError,
          result.content?.[0]?.text?.substring(0, 80) || "(ok)"
        );
        return result;
      } catch (e) {
        logToolCall(toolName, args, Date.now() - start, false, e.message);
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
  logDebug("getTransportForRequest", { requestedSessionId: sessionId, sessionCount: sessions.size });
  
  // Return existing transport if session exists
  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId);
    const age = Date.now() - entry.createdAt;
    const idle = Date.now() - entry.lastAccess;
    entry.lastAccess = Date.now();
    logDebug("REUSE_SESSION", { sessionId, age_ms: age, idle_ms: idle });
    return { transport: entry.transport, isNew: false };
  }

  if (sessionId && !sessions.has(sessionId)) {
    logDebug("SESSION_NOT_FOUND", { sessionId, availableSessions: Array.from(sessions.keys()) });
  }

  // Create fresh McpServer + Transport pair
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => generateSessionId(),
    enableJsonResponse: true
  });

  // Connect server to transport (one-time per server instance)
  await server.connect(transport);

  logDebug("CREATED_NEW_TRANSPORT", { requestedSessionId: sessionId });
  return { transport, isNew: true };
}

function registerSession(sessionId, transport) {
  logDebug("REGISTER_SESSION", { sessionId, sessionCount: sessions.size + 1 });
  sessions.set(sessionId, {
    transport,
    createdAt: Date.now(),
    lastAccess: Date.now()
  });
}

// Cleanup sessions inactive for more than 1 hour, every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  const evicted = [];
  for (const [id, entry] of sessions) {
    if (entry.lastAccess < cutoff) {
      evicted.push({ sessionId: id, age_ms: Date.now() - entry.createdAt, idle_ms: Date.now() - entry.lastAccess });
      sessions.delete(id);
    }
  }
  if (evicted.length > 0) {
    logDebug("SESSION_CLEANUP", { evicted, remaining: sessions.size });
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
        logDebug("CAPTURED_SESSION_ID_FROM_RESPONSE", { newSessionId, requestedSessionId: sessionId });
        registerSession(newSessionId, transport);
      } else {
        logDebug("NO_SESSION_ID_IN_RESPONSE", { requestedSessionId: sessionId, responseHeaders: Object.fromEntries(webRes.headers.entries()) });
      }
    }

    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    const text = await webRes.text();
    if (text) res.send(text);
    else res.end();
  } catch (e) {
    console.error("MCP error:", e.message);
    logDebug("MCP_POST_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
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
        logDebug("CAPTURED_SESSION_ID_FROM_GET_RESPONSE", { newSessionId, requestedSessionId: sessionId });
        registerSession(newSessionId, transport);
      } else {
        logDebug("NO_SESSION_ID_IN_GET_RESPONSE", { requestedSessionId: sessionId });
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
    logDebug("MCP_GET_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
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
        logDebug("CAPTURED_SESSION_ID_FROM_DELETE_RESPONSE", { newSessionId, requestedSessionId: sessionId });
        registerSession(newSessionId, transport);
      } else {
        logDebug("NO_SESSION_ID_IN_DELETE_RESPONSE", { requestedSessionId: sessionId });
      }
    }

    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    const text = await webRes.text();
    if (text) res.send(text);
    else res.end();
  } catch (e) {
    console.error("MCP DELETE error:", e.message);
    logDebug("MCP_DELETE_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Sidekick MCP server listening on port " + PORT);
  console.log("MCP endpoint: http://0.0.0.0:" + PORT + "/mcp");
  console.log("Data dir: " + DATA_DIR);
});
