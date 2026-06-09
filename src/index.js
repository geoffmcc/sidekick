const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const API_KEY = process.env.SIDEKICK_API_KEY || "sk-sidekick-local-dev";
const PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const ALLOWED_IPS = (process.env.SIDEKICK_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);

fs.mkdirSync(DATA_DIR, { recursive: true });

const KV_FILE = path.join(DATA_DIR, "kvstore.json");
const LOG_FILE = path.join(DATA_DIR, "log.jsonl");
const MAX_LOG = 1000;

let kvStore = {};
if (fs.existsSync(KV_FILE)) {
  try { kvStore = JSON.parse(fs.readFileSync(KV_FILE, "utf-8")); } catch (e) {}
}

function saveKV() {
  fs.writeFileSync(KV_FILE, JSON.stringify(kvStore, null, 2));
}

function logToolCall(name, args, duration, success, summary) {
  try {
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      n: name,
      a: typeof args === "object" ? Object.keys(args).join(",") : "",
      d: Math.round(duration),
      ok: success,
      s: String(summary).substring(0, 120)
    }) + "\n";
    fs.appendFileSync(LOG_FILE, entry, "utf-8");
    const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    if (lines.length > MAX_LOG) {
      fs.writeFileSync(LOG_FILE, lines.slice(lines.length - MAX_LOG).join("\n") + "\n", "utf-8");
    }
  } catch (e) {}
}

function register(name, desc, schema, handler) {
  server.registerTool(name, { description: desc, inputSchema: schema }, async (args, extra) => {
    const start = Date.now();
    try {
      const result = await handler(args, extra);
      logToolCall(name, args, Date.now() - start, true,
        result.content?.[0]?.text?.substring(0, 80) || "(ok)"
      );
      return result;
    } catch (e) {
      logToolCall(name, args, Date.now() - start, false, e.message);
      throw e;
    }
  });
}

const server = new McpServer({
  name: "sidekick-mcp-server",
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//, /\s+>\s*\/dev\/(sd|nvme|vd|sda|xvda)/,
  /mkfs/, /fdisk/, /parted/, /dd\s+if=/,
  /:\(\s*\{/,
  /(curl|wget)\s+.*\|\s*(bash|sh)\b/,
  /chmod\s+-R\s+777\s+\//,
];

function isDangerous(cmd) {
  return DANGEROUS_PATTERNS.some(p => p.test(cmd));
}

register("sidekick_bash",
  "Execute a shell command on the VPS.",
  z.object({
    command: z.string().describe("Shell command to execute")
  }),
  async ({ command }) => {
    if (isDangerous(command)) {
      return { content: [{ type: "text", text: "Blocked: command matches a dangerous pattern" }], isError: true };
    }
    try {
      const stdout = execSync(command, { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      return { content: [{ type: "text", text: stdout || "(empty output)" }] };
    } catch (e) {
      return { content: [{ type: "text", text: "Exit code: " + e.status + "\nstdout: " + (e.stdout || "") + "\nstderr: " + (e.stderr || "") }] };
    }
  }
);

register("sidekick_read",
  "Read a file from the VPS filesystem.",
  z.object({
    path: z.string().describe("Absolute path to the file to read")
  }),
  async ({ path: filePath }) => {
    if (!fs.existsSync(filePath)) {
      return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  }
);

register("sidekick_write",
  "Write content to a file on the VPS filesystem.",
  z.object({
    path: z.string().describe("Absolute path to write to"),
    content: z.string().describe("File content to write")
  }),
  async ({ path: filePath, content }) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    const stat = fs.statSync(filePath);
    return { content: [{ type: "text", text: "Written " + stat.size + " bytes to " + filePath }] };
  }
);

register("sidekick_store",
  "Store a value persistently on the VPS.",
  z.object({
    key: z.string().describe("Storage key"),
    value: z.string().describe("Value to store")
  }),
  async ({ key, value }) => {
    kvStore[key] = value;
    saveKV();
    return { content: [{ type: "text", text: "Stored key \"" + key + "\" (" + value.length + " chars)" }] };
  }
);

register("sidekick_get",
  "Retrieve a stored value from VPS persistent storage.",
  z.object({
    key: z.string().describe("Storage key to retrieve")
  }),
  async ({ key }) => {
    if (!(key in kvStore)) {
      return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
    }
    return { content: [{ type: "text", text: kvStore[key] }] };
  }
);

register("sidekick_web_fetch",
  "Fetch a URL from the VPS.",
  z.object({
    url: z.string().describe("URL to fetch"),
    method: z.enum(["GET", "POST"]).optional().default("GET").describe("HTTP method"),
    headers: z.string().optional().describe("JSON object of extra headers"),
    body: z.string().optional().describe("Request body (for POST)")
  }),
  async ({ url: targetUrl, method, headers, body }) => {
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
);

register("sidekick_list",
  "List files and directories on the VPS.",
  z.object({
    path: z.string().optional().default("/home/sidekick").describe("Directory path to list")
  }),
  async ({ path: dirPath }) => {
    if (!fs.existsSync(dirPath)) {
      return { content: [{ type: "text", text: "Path not found: " + dirPath }], isError: true };
    }
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const lines = items.map(i => {
      const type = i.isDirectory() ? "DIR" : i.isFile() ? "FILE" : "OTHER";
      let stat = null;
      try { stat = fs.statSync(path.join(dirPath, i.name)); } catch (e) {}
      const size = stat ? stat.size : 0;
      const date = stat ? stat.mtime.toISOString().slice(0, 19).replace("T", " ") : "";
      return type.padEnd(5) + " " + String(size).padStart(10) + " " + date + " " + i.name;
    });
    return { content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }] };
  }
);

register("sidekick_llm",
  "Ask the local Phi-3-mini LLM on the VPS.",
  z.object({
    prompt: z.string().describe("The prompt to send to the LLM"),
    system: z.string().optional().describe("System prompt override"),
    temperature: z.number().optional().default(0.7).describe("Sampling temperature (0-2)")
  }),
  async ({ prompt, system, temperature }) => {
    const http = require("http");
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: "phi3:mini",
        prompt: prompt,
        system: system || "You are a helpful assistant running on a VPS.",
        options: { temperature: temperature || 0.7 },
        stream: false
      });
      const req = http.request({
        hostname: "127.0.0.1", port: 11434,
        path: "/api/generate",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ content: [{ type: "text", text: parsed.response || JSON.stringify(parsed) }] });
          } catch (e) {
            resolve({ content: [{ type: "text", text: "Error parsing response: " + data.substring(0, 200) }], isError: true });
          }
        });
      });
      req.on("error", (err) => resolve({ content: [{ type: "text", text: "LLM error: " + err.message }], isError: true }));
      req.write(body);
      req.end();
    });
  }
);

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

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true
});

app.post("/mcp", async (req, res) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error:", e.message, e.stack?.split("\n").slice(0, 3).join("\n"));
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

server.connect(transport);

app.listen(PORT, "0.0.0.0", () => {
  console.log("Sidekick MCP server listening on port " + PORT);
  console.log("MCP endpoint: http://0.0.0.0:" + PORT + "/mcp");
  console.log("Data dir: " + DATA_DIR);
});
