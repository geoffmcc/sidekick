const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EventEmitter = require("events");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const PORT = parseInt(process.env.SIDEKICK_AGENT_PORT || "4099", 10);
const API_KEY = process.env.SIDEKICK_API_KEY || "sk-sidekick-local-dev";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const CONV_DIR = path.join(DATA_DIR, "conversations");
fs.mkdirSync(CONV_DIR, { recursive: true });

// Clean up conversation files older than 24 hours
try {
  const cutoff = Date.now() - 86400000;
  fs.readdirSync(CONV_DIR).filter(f => f.endsWith(".json")).forEach(f => {
    const p = path.join(CONV_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  });
} catch (e) {}

process.on("uncaughtException", (e) => {
  console.error("Uncaught:", e.message);
});

// Pre-warm Ollama model on startup (only used when no Groq key)
if (!GROQ_API_KEY) {
  setTimeout(() => {
    const http = require("http");
    const body = JSON.stringify({ model: "phi3:mini", prompt: "hello", stream: false });
    const req = http.request({
      hostname: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    });
    req.write(body); req.end();
    req.on("error", () => {});
    req.setTimeout(300000, () => req.destroy());
  }, 1000);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const taskEmitters = {};

const TOOL_DEFS = [
  { name: "sidekick_bash", description: "Execute a shell command on the VPS", args: { command: "string" } },
  { name: "sidekick_read", description: "Read a file from the VPS filesystem", args: { path: "string" } },
  { name: "sidekick_write", description: "Write content to a file on the VPS", args: { path: "string", content: "string" } },
  { name: "sidekick_list", description: "List files and directories on the VPS", args: { path: "string" } },
  { name: "sidekick_store", description: "Store a value persistently in KV storage", args: { key: "string", value: "string" } },
  { name: "sidekick_get", description: "Retrieve a stored value from KV storage", args: { key: "string" } },
  { name: "sidekick_web_fetch", description: "Fetch a URL from the VPS", args: { url: "string" } },
  { name: "sidekick_llm", description: "Ask the LLM (Groq cloud or local Phi-3-mini)", args: { prompt: "string", system: "string (optional)", temperature: "number (optional)" } },
];

let mcpSessionId = "";

function httpRequest(path, bodyData, sessionId) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const headers = {
      "Authorization": "Bearer " + API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(bodyData)
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const req = http.request({
      hostname: "127.0.0.1", port: 4097, path: path, method: "POST", headers
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve({ data: res.headers["mcp-session-id"] || "", status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(bodyData);
    req.end();
  });
}

function parseBody(raw) {
  if (raw.startsWith("event:")) {
    const dl = raw.split("\n").find(l => l.startsWith("data: "));
    if (dl) return JSON.parse(dl.replace("data: ", ""));
    throw new Error("SSE: no data line");
  }
  return JSON.parse(raw);
}

function initMCP() {
  const initBody = JSON.stringify({
    jsonrpc: "2.0", id: "init", method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sidekick-agent", version: "1.0.0" } }
  });
  const notifBody = JSON.stringify({
    jsonrpc: "2.0", method: "notifications/initialized"
  });
  return httpRequest("/mcp", initBody).then(r1 => {
    parseBody(r1.body);
    if (!r1.data) throw new Error("MCP init: no session ID");
    mcpSessionId = r1.data;
    return httpRequest("/mcp", notifBody, mcpSessionId);
  }).then(r2 => {
    parseBody(r2.body);
  });
}

function callMCP(tool, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: "1", method: "tools/call",
    params: { name: tool, arguments: args }
  });
  return httpRequest("/mcp", body, mcpSessionId).then(res => parseBody(res.body));
}

function buildSystemPrompt() {
  const toolDescs = TOOL_DEFS.map(t =>
    "- " + t.name + "(" + Object.keys(t.args).join(", ") + "): " + t.description
  ).join("\n");
  return "You are an autonomous agent running on a VPS. You have these tools:\n" + toolDescs +
    "\n\nUse exactly ONE of these keys in your JSON response. Never use multiple keys:\n" +
    '- {"tool": "tool_name", "arguments": {"key": "value"}}  (set tool to a valid name)\n' +
    '- {"think": "your reasoning"}  (explain what you plan to do)\n' +
    '- {"done": true, "result": "summary"}  (task is complete)\n' +
    "Set unused keys to null. Never ask for confirmation.";
}

function callLLM(messages) {
  if (GROQ_API_KEY) return callGroqLLM(messages);
  return callOllamaLLM(messages);
}

function callGroqLLM(messages, attempt = 1) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ],
      temperature: 0.3
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
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 429 && attempt < 5) {
            const wait = Math.min(10000, 1000 * Math.pow(2, attempt));
            return setTimeout(() => resolve(callGroqLLM(messages, attempt + 1)), wait);
          }
          if (res.statusCode >= 400) {
            return reject(new Error("Groq: " + (parsed.error?.message || data.substring(0, 200))));
          }
          const content = parsed.choices?.[0]?.message?.content || "";
          resolve({ response: content });
        } catch (e) {
          reject(new Error("Groq parse: " + data.substring(0, 200)));
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("LLM timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function callOllamaLLM(messages) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const body = JSON.stringify({
      model: "phi3:mini",
      prompt: messages.map(m => (m.role === "system" ? "System: " : "User: ") + m.content).join("\n\n"),
      system: buildSystemPrompt(),
      options: { temperature: 0.3 },
      stream: false
    });
    const req = http.request({
      hostname: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("LLM parse fail: " + data.substring(0, 200))); }
      });
    });
    req.setTimeout(300000, () => { req.destroy(); reject(new Error("LLM timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function emit(taskId, data) {
  const ee = taskEmitters[taskId];
  if (ee) ee.emit("data", data);
}

async function runAgent(goal, taskId) {
  const steps = [];
  const history = [{ role: "user", content: goal }];

  emit(taskId, { type: "step", text: "Analyzing task: " + goal });
  if (!mcpSessionId) {
    try {
      await initMCP();
      emit(taskId, { type: "step", text: "MCP session initialized" });
    } catch (e) {
      emit(taskId, { type: "error", text: "MCP init failed: " + e.message });
    }
  }

  for (let i = 0; i < 20; i++) {
    let response;
    try {
      response = await callLLM(history);
    } catch (e) {
      emit(taskId, { type: "error", text: "LLM error: " + e.message });
      steps.push({ type: "error", text: e.message });
      break;
    }

    const text = (response.response || "").trim();

    // Try to find the first valid JSON object in the response
    let decision;
    for (const line of text.split("\n")) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed && typeof parsed === "object") { decision = parsed; break; }
      } catch {}
    }
    if (!decision) decision = { think: text };

    if (decision.think) {
      emit(taskId, { type: "step", text: decision.think });
      steps.push({ type: "thought", text: decision.think });
      history.push({ role: "assistant", content: "Thought: " + decision.think });
      continue;
    }

    if (decision.done) {
      const result = decision.result || "Task completed";
      emit(taskId, { type: "done", text: result });
      steps.push({ type: "done", text: result });
      break;
    }

    if (decision.tool) {
      emit(taskId, { type: "tool", tool: decision.tool, summary: JSON.stringify(decision.arguments) });
      steps.push({ type: "tool", tool: decision.tool, args: decision.arguments });

      let result;
      try {
        const mcpRes = await callMCP(decision.tool, decision.arguments || {});
        if (mcpRes.error) {
          result = "Error: " + mcpRes.error.message;
        } else {
          result = mcpRes.result?.content?.[0]?.text || "(empty result)";
        }
      } catch (e) {
        result = "Call failed: " + e.message;
      }

      const summary = result.substring(0, 500);
      emit(taskId, { type: "tool", tool: decision.tool, summary: summary.substring(0, 120) });
      steps[steps.length - 1].result = summary;
      history.push({ role: "assistant", content: "Called " + decision.tool + " → " + summary.substring(0, 200) });
      history.push({ role: "user", content: "Continue. Use another tool or call done." });
    }
  }

  const transcript = JSON.stringify({ goal, steps, status: "completed", t: new Date().toISOString() });
  fs.writeFileSync(path.join(CONV_DIR, taskId + ".json"), transcript, "utf-8");
  emit(taskId, { type: "done", text: "Transcript saved" });
}

// --- API ---

app.post("/api/agent/run", (req, res) => {
  const { goal } = req.body;
  if (!goal) return res.status(400).json({ error: "goal required" });
  const taskId = crypto.randomUUID().slice(0, 8);
  taskEmitters[taskId] = new EventEmitter();
  res.json({ taskId });
  runAgent(goal, taskId).finally(() => {
    setTimeout(() => delete taskEmitters[taskId], 60000);
  });
});

app.get("/api/agent/stream/:taskId", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.write(":\n\n");

  const ee = taskEmitters[req.params.taskId];
  if (!ee) {
    res.write("data: " + JSON.stringify({ type: "done", text: "Task not found" }) + "\n\n");
    res.end();
    return;
  }

  const handler = (data) => {
    res.write("data: " + JSON.stringify(data) + "\n\n");
    if (data.type === "done" || data.type === "error") {
      ee.off("data", handler);
      res.end();
    }
  };
  ee.on("data", handler);
  req.on("close", () => ee.off("data", handler));
});

app.get("/api/agent/history", (req, res) => {
  const files = fs.readdirSync(CONV_DIR).filter(f => f.endsWith(".json")).sort().reverse().slice(0, 20);
  const runs = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), "utf-8"));
      return { id: f.replace(".json", ""), goal: data.goal, status: data.status, t: data.t };
    } catch { return null; }
  }).filter(Boolean);
  res.json({ runs });
});

app.get("/api/agent/run/:id", (req, res) => {
  const file = path.join(CONV_DIR, req.params.id + ".json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  try { res.json(JSON.parse(fs.readFileSync(file, "utf-8"))); }
  catch { res.status(500).json({ error: "parse error" }); }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, "127.0.0.1", () => {
  console.log("Sidekick agent bridge listening on http://127.0.0.1:" + PORT);
});
