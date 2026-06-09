const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

fs.mkdirSync(DATA_DIR, { recursive: true });

const KV_FILE = path.join(DATA_DIR, "kvstore.json");
const LOG_FILE = path.join(DATA_DIR, "log.jsonl");
const MAX_LOG = 1000;

let kvStore = {};
if (fs.existsSync(KV_FILE)) {
  try { kvStore = JSON.parse(fs.readFileSync(KV_FILE, "utf-8")); } catch (e) {}
}

let currentSource = "unknown";

function setSource(source) {
  currentSource = source;
}

function saveKV() {
  fs.writeFileSync(KV_FILE, JSON.stringify(kvStore, null, 2));
}

function formatArgs(args) {
  if (typeof args !== "object" || args === null) return "";
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    const str = String(value);
    const truncated = str.length > 100 ? str.substring(0, 100) + "..." : str;
    parts.push(key + "=" + truncated);
  }
  return parts.join(", ");
}

function logToolCall(name, args, duration, success, summary) {
  try {
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      n: name,
      a: formatArgs(args),
      d: Math.round(duration),
      ok: success,
      s: String(summary).substring(0, 200),
      src: currentSource
    }) + "\n";
    fs.appendFileSync(LOG_FILE, entry, "utf-8");
    const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    if (lines.length > MAX_LOG) {
      fs.writeFileSync(LOG_FILE, lines.slice(lines.length - MAX_LOG).join("\n") + "\n", "utf-8");
    }
  } catch (e) {}
}

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

async function sidekick_bash({ command }) {
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

async function sidekick_read({ path: filePath }) {
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return { content: [{ type: "text", text: content }] };
}

async function sidekick_write({ path: filePath, content }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  const stat = fs.statSync(filePath);
  return { content: [{ type: "text", text: "Written " + stat.size + " bytes to " + filePath }] };
}

async function sidekick_store({ key, value }) {
  kvStore[key] = value;
  saveKV();
  return { content: [{ type: "text", text: "Stored key \"" + key + "\" (" + value.length + " chars)" }] };
}

async function sidekick_get({ key }) {
  if (!(key in kvStore)) {
    return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
  }
  return { content: [{ type: "text", text: kvStore[key] }] };
}

async function sidekick_list({ path: dirPath }) {
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

async function sidekick_llm({ prompt, system, temperature }) {
  if (GROQ_API_KEY) {
    return callGroqLLM(prompt, system, temperature);
  }
  return callOllamaLLM(prompt, system, temperature);
}

function callOllamaLLM(prompt, system, temperature) {
  const http = require("http");
  return new Promise((resolve) => {
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

function callGroqLLM(prompt, system, temperature) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: system || "You are a helpful assistant running on a VPS." },
        { role: "user", content: prompt }
      ],
      temperature: temperature || 0.7
    });
    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || JSON.stringify(parsed);
          resolve({ content: [{ type: "text", text: content }] });
        } catch (e) {
          resolve({ content: [{ type: "text", text: "Error parsing response: " + data.substring(0, 200) }], isError: true });
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); resolve({ content: [{ type: "text", text: "LLM timeout" }], isError: true }); });
    req.on("error", (err) => resolve({ content: [{ type: "text", text: "LLM error: " + err.message }], isError: true }));
    req.write(body);
    req.end();
  });
}

const TOOLS = {
  sidekick_bash,
  sidekick_read,
  sidekick_write,
  sidekick_store,
  sidekick_get,
  sidekick_list,
  sidekick_web_fetch,
  sidekick_llm,
};

const TOOL_DEFS = [
  { name: "sidekick_bash", description: "Execute a shell command on the VPS", args: { command: "string" } },
  { name: "sidekick_read", description: "Read a file from the VPS filesystem", args: { path: "string" } },
  { name: "sidekick_write", description: "Write content to a file on the VPS", args: { path: "string", content: "string" } },
  { name: "sidekick_list", description: "List files and directories on the VPS", args: { path: "string" } },
  { name: "sidekick_store", description: "Store a value persistently in KV storage", args: { key: "string", value: "string" } },
  { name: "sidekick_get", description: "Retrieve a stored value from KV storage", args: { key: "string" } },
  { name: "sidekick_web_fetch", description: "Fetch a URL from the VPS", args: { url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" } },
  { name: "sidekick_llm", description: "Ask the LLM (Groq cloud or local Phi-3-mini)", args: { prompt: "string", system: "string (optional)", temperature: "number (optional)" } },
];

async function callTool(name, args) {
  const handler = TOOLS[name];
  if (!handler) {
    return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  }
  const start = Date.now();
  try {
    const result = await handler(args);
    logToolCall(name, args, Date.now() - start, true,
      result.content?.[0]?.text?.substring(0, 80) || "(ok)"
    );
    return result;
  } catch (e) {
    logToolCall(name, args, Date.now() - start, false, e.message);
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

module.exports = { TOOLS, TOOL_DEFS, callTool, logToolCall, setSource, DATA_DIR, OLLAMA_URL, GROQ_API_KEY, GROQ_MODEL };
