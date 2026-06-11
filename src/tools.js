const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { redactSensitive } = require("./redact");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

fs.mkdirSync(DATA_DIR, { recursive: true });

const KV_FILE = path.join(DATA_DIR, "kvstore.json");
const LOG_FILE = path.join(DATA_DIR, "log.jsonl");
const CRON_FILE = path.join(DATA_DIR, "cron.json");
const WEBHOOK_FILE = path.join(DATA_DIR, "webhooks.json");
const CONTEXT_FILE = path.join(DATA_DIR, "context.json");
const MAX_LOG = 1000;

const PROJECT_RE = /^[a-z][a-z0-9_]*$/;

function migrateKV(data) {
  const now = new Date().toISOString();
  const migrated = {};
  
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'string') {
      let project = null;
      if (key.startsWith('server:') || key.startsWith('network:') || 
          key.startsWith('services:') || key.startsWith('security:') ||
          key.startsWith('software:') || key.startsWith('deploy:') ||
          key.startsWith('config:')) {
        project = 'system';
      } else if (key.startsWith('proxmox_backup_') || key === 'env_var_deployment_status') {
        project = 'proxmox_backup';
      }
      
      migrated[key] = {
        value: val,
        project: project,
        source: 'unknown',
        created: now,
        updated: now
      };
    } else if (typeof val === 'object' && val !== null && 'value' in val) {
      migrated[key] = val;
    } else {
      migrated[key] = val;
    }
  }
  
  return migrated;
}

let kvStore = {};
if (fs.existsSync(KV_FILE)) {
  try { 
    const rawData = JSON.parse(fs.readFileSync(KV_FILE, "utf-8"));
    kvStore = migrateKV(rawData);
    fs.writeFileSync(KV_FILE, JSON.stringify(kvStore, null, 2));
  } catch (e) {}
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
    parts.push(key + "=" + redactSensitive(truncated));
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
      s: redactSensitive(String(summary).substring(0, 200)),
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
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Exit code: " + e.status + "\nstdout: " + (e.stdout || "") + "\nstderr: " + (e.stderr || "")) }], isError: true };
  }
}

async function sidekick_read({ path: filePath }) {
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return { content: [{ type: "text", text: redactSensitive(content) }] };
}

async function sidekick_write({ path: filePath, content }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  const stat = fs.statSync(filePath);
  return { content: [{ type: "text", text: "Written " + stat.size + " bytes to " + filePath }] };
}

async function sidekick_store({ key, value, project }) {
  if (project !== undefined && project !== null && !PROJECT_RE.test(project)) {
    return { content: [{ type: "text", text: "Invalid project name. Must match /^[a-z][a-z0-9_]*$/" }], isError: true };
  }
  
  const now = new Date().toISOString();
  const existing = kvStore[key];
  
  if (existing && typeof existing === 'object' && 'value' in existing) {
    kvStore[key] = {
      value: value,
      project: project !== undefined ? project : existing.project,
      source: currentSource,
      created: existing.created,
      updated: now
    };
  } else {
    kvStore[key] = {
      value: value,
      project: project || null,
      source: currentSource,
      created: now,
      updated: now
    };
  }
  
  saveKV();
  return { content: [{ type: "text", text: "Stored key \"" + key + "\" (" + value.length + " chars)" }] };
}

async function sidekick_get({ key }) {
  if (!(key in kvStore)) {
    return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
  }
  const entry = kvStore[key];
  const value = (typeof entry === 'object' && entry !== null && 'value' in entry) ? entry.value : entry;
  return { content: [{ type: "text", text: redactSensitive(value) }] };
}

async function sidekick_list_projects() {
  const projects = new Set();
  for (const entry of Object.values(kvStore)) {
    if (typeof entry === 'object' && entry !== null && 'project' in entry) {
      projects.add(entry.project);
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(Array.from(projects)) }] };
}

async function sidekick_get_by_project({ project }) {
  const results = [];
  for (const [key, entry] of Object.entries(kvStore)) {
    if (typeof entry === 'object' && entry !== null && 'project' in entry) {
      if (entry.project === project) {
        results.push({ key, value: entry.value });
      }
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results) }] };
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
  return { content: [{ type: "text", text: redactSensitive(lines.join("\n") || "(empty directory)") }] };
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

async function sidekick_search({ pattern, path: searchPath, include }) {
  const targetPath = searchPath || ".";
  if (!fs.existsSync(targetPath)) {
    return { content: [{ type: "text", text: "Path not found: " + targetPath }], isError: true };
  }
  
  let cmd;
  try {
    execSync("which rg", { stdio: "ignore" });
    cmd = ["rg", "--json", "--max-count", "100"];
    if (include) cmd.push("-g", include);
    cmd.push(pattern, targetPath);
  } catch (e) {
    cmd = ["grep", "-rn", "--max-count=100"];
    if (include) cmd.push("--include=" + include);
    cmd.push(pattern, targetPath);
  }
  
  try {
    const stdout = execSync(cmd.join(" "), { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "(no matches)") }] };
  } catch (e) {
    if (e.status === 1) {
      return { content: [{ type: "text", text: "No matches found" }] };
    }
    return { content: [{ type: "text", text: "Search error: " + (e.stderr || e.message) }], isError: true };
  }
}

async function sidekick_git({ action, path: repoPath, args: extraArgs }) {
  const repo = repoPath || ".";
  if (!fs.existsSync(repo)) {
    return { content: [{ type: "text", text: "Repository path not found: " + repo }], isError: true };
  }
  
  const allowedActions = ["status", "diff", "log", "add", "commit", "push", "pull", "branch", "checkout", "stash"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }
  
  const baseCmd = ["git", "-C", repo, action];
  if (extraArgs) {
    const parsed = extraArgs.split(/\s+/).filter(Boolean);
    baseCmd.push(...parsed);
  }
  
  try {
    const stdout = execSync(baseCmd.join(" "), { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Exit code: " + e.status + "\n" + (e.stderr || e.stdout || "")) }], isError: true };
  }
}

async function sidekick_notify({ channel, webhook_url, recipient, message, title }) {
  const https = require("https");
  const http = require("http");
  
  if (channel === "discord" || channel === "slack") {
    if (!webhook_url) {
      return { content: [{ type: "text", text: "webhook_url required for " + channel }], isError: true };
    }
    
    const payload = channel === "discord" 
      ? JSON.stringify({ content: title ? `**${title}**\n${message}` : message })
      : JSON.stringify({ text: title ? `*${title}*\n${message}` : message });
    
    return new Promise((resolve) => {
      const urlObj = new URL(webhook_url);
      const lib = urlObj.protocol === "https:" ? https : http;
      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 10000
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ content: [{ type: "text", text: "Sent to " + channel }] });
          } else {
            resolve({ content: [{ type: "text", text: "Failed: " + res.statusCode + " " + data }], isError: true });
          }
        });
      });
      req.on("error", (err) => resolve({ content: [{ type: "text", text: "Error: " + err.message }], isError: true }));
      req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Timeout" }], isError: true }); });
      req.write(payload);
      req.end();
    });
  }
  
  if (channel === "email") {
    if (!recipient) {
      return { content: [{ type: "text", text: "recipient required for email" }], isError: true };
    }
    
    const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
    const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
    const smtpUser = process.env.SMTP_USER || "";
    const smtpPass = process.env.SMTP_PASS || "";
    
    if (!smtpUser || !smtpPass) {
      return { content: [{ type: "text", text: "SMTP_USER and SMTP_PASS env vars required" }], isError: true };
    }
    
    const subject = title || "Sidekick Notification";
    const emailContent = `From: ${smtpUser}\nTo: ${recipient}\nSubject: ${subject}\n\n${message}`;
    
    return new Promise((resolve) => {
      const req = https.request({
        hostname: smtpHost,
        port: smtpPort,
        path: "/",
        method: "POST",
        auth: `${smtpUser}:${smtpPass}`,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(emailContent)
        },
        timeout: 30000
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          resolve({ content: [{ type: "text", text: "Email sent to " + recipient }] });
        });
      });
      req.on("error", (err) => resolve({ content: [{ type: "text", text: "Email error: " + err.message }], isError: true }));
      req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Email timeout" }], isError: true }); });
      req.write(emailContent);
      req.end();
    });
  }
  
  return { content: [{ type: "text", text: "Invalid channel. Use: discord, slack, or email" }], isError: true };
}

async function sidekick_process({ action, filter, pid, name, signal }) {
  const allowedActions = ["list", "top", "kill", "tree"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }
  
  let cmd;
  if (action === "list") {
    cmd = ["ps", "aux"];
    if (filter) cmd = ["ps", "aux", "|", "grep", "-i", filter];
  } else if (action === "top") {
    cmd = ["ps", "aux", "--sort=-%cpu", "|", "head", "-20"];
  } else if (action === "kill") {
    if (!pid && !name) {
      return { content: [{ type: "text", text: "pid or name required for kill" }], isError: true };
    }
    const sig = signal || "TERM";
    if (pid) {
      cmd = ["kill", "-" + sig, String(pid)];
    } else {
      cmd = ["pkill", "-" + sig, name];
    }
  } else if (action === "tree") {
    cmd = ["pstree", "-p"];
  }
  
  try {
    const stdout = execSync(cmd.join(" "), { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    if (action === "kill" && e.status === 0) {
      return { content: [{ type: "text", text: "Process killed" }] };
    }
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
  }
}

async function sidekick_service({ action, service, lines }) {
  const allowedActions = ["start", "stop", "restart", "status", "enable", "disable", "logs"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }
  
  let cmd;
  if (action === "logs") {
    if (!service) {
      return { content: [{ type: "text", text: "service required for logs" }], isError: true };
    }
    const n = lines || 50;
    cmd = ["journalctl", "-u", service, "-n", String(n), "--no-pager"];
  } else {
    if (!service) {
      return { content: [{ type: "text", text: "service required for " + action }], isError: true };
    }
    cmd = ["sudo", "systemctl", action, service];
  }
  
  try {
    const stdout = execSync(cmd.join(" "), { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "OK") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
  }
}

async function sidekick_archive({ action, path: sourcePath, output, format }) {
  const allowedActions = ["create", "extract", "list"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }
  
  if (!sourcePath) {
    return { content: [{ type: "text", text: "path required" }], isError: true };
  }
  
  if (!fs.existsSync(sourcePath)) {
    return { content: [{ type: "text", text: "Path not found: " + sourcePath }], isError: true };
  }
  
  const fmt = format || "tar.gz";
  let cmd;
  
  if (action === "create") {
    if (!output) {
      return { content: [{ type: "text", text: "output required for create" }], isError: true };
    }
    if (fmt === "tar.gz" || fmt === "tgz") {
      cmd = ["tar", "-czf", output, "-C", path.dirname(sourcePath), path.basename(sourcePath)];
    } else if (fmt === "zip") {
      cmd = ["zip", "-r", output, sourcePath];
    } else {
      return { content: [{ type: "text", text: "Invalid format. Use: tar.gz, tgz, or zip" }], isError: true };
    }
  } else if (action === "extract") {
    if (sourcePath.endsWith(".tar.gz") || sourcePath.endsWith(".tgz")) {
      cmd = ["tar", "-xzf", sourcePath];
    } else if (sourcePath.endsWith(".zip")) {
      cmd = ["unzip", sourcePath];
    } else {
      return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
    }
  } else if (action === "list") {
    if (sourcePath.endsWith(".tar.gz") || sourcePath.endsWith(".tgz")) {
      cmd = ["tar", "-tzf", sourcePath];
    } else if (sourcePath.endsWith(".zip")) {
      cmd = ["unzip", "-l", sourcePath];
    } else {
      return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
    }
  }
  
  try {
    const stdout = execSync(cmd.join(" "), { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "OK") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
  }
}

// --- Cron Tool ---

function loadCronJobs() {
  if (!fs.existsSync(CRON_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CRON_FILE, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveCronJobs(jobs) {
  fs.writeFileSync(CRON_FILE, JSON.stringify(jobs, null, 2));
}

async function sidekick_cron({ action, name, schedule, command, id }) {
  const allowedActions = ["add", "list", "remove", "run"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const jobs = loadCronJobs();

  if (action === "add") {
    if (!name || !schedule || !command) {
      return { content: [{ type: "text", text: "name, schedule, and command required" }], isError: true };
    }
    const newJob = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      schedule,
      command,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastResult: null
    };
    jobs.push(newJob);
    saveCronJobs(jobs);
    syncCrontab(jobs);
    return { content: [{ type: "text", text: "Added cron job: " + name + " (id: " + newJob.id + ")" }] };
  }

  if (action === "list") {
    if (jobs.length === 0) {
      return { content: [{ type: "text", text: "No cron jobs scheduled" }] };
    }
    const summary = jobs.map(j => 
      j.id + " | " + j.name + " | " + j.schedule + " | " + (j.enabled ? "enabled" : "disabled") + " | last: " + (j.lastRun || "never")
    ).join("\n");
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "remove") {
    if (!id && !name) {
      return { content: [{ type: "text", text: "id or name required" }], isError: true };
    }
    const idx = jobs.findIndex(j => j.id === id || j.name === name);
    if (idx === -1) {
      return { content: [{ type: "text", text: "Job not found" }], isError: true };
    }
    const removed = jobs.splice(idx, 1)[0];
    saveCronJobs(jobs);
    syncCrontab(jobs);
    return { content: [{ type: "text", text: "Removed job: " + removed.name }] };
  }

  if (action === "run") {
    if (!id && !name) {
      return { content: [{ type: "text", text: "id or name required" }], isError: true };
    }
    const job = jobs.find(j => j.id === id || j.name === name);
    if (!job) {
      return { content: [{ type: "text", text: "Job not found" }], isError: true };
    }
    try {
      const stdout = execSync(job.command, { timeout: 300000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      job.lastRun = new Date().toISOString();
      job.lastResult = "success";
      saveCronJobs(jobs);
      return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
    } catch (e) {
      job.lastRun = new Date().toISOString();
      job.lastResult = "error";
      saveCronJobs(jobs);
      return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
    }
  }
}

function syncCrontab(jobs) {
  try {
    const enabledJobs = jobs.filter(j => j.enabled);
    if (enabledJobs.length === 0) {
      execSync('crontab -r 2>/dev/null || true', { encoding: "utf-8" });
      return;
    }
    const lines = enabledJobs.map(j => {
      const script = `cd /home/sidekick/mcp-sidekick && ${j.command} >> ${DATA_DIR}/cron-${j.id}.log 2>&1`;
      return `${j.schedule} ${script} # sidekick:${j.id}`;
    });
    const crontabContent = lines.join("\n") + "\n";
    execSync(`echo ${JSON.stringify(crontabContent)} | crontab -`, { encoding: "utf-8" });
  } catch (e) {
    // Silently fail if crontab not available
  }
}

// --- GitHub Tool ---

async function sidekick_github({ action, repo, args: extraArgs }) {
  const tokenEntry = kvStore["github_token"];
  const token = tokenEntry?.value || tokenEntry;
  if (!token) {
    return { content: [{ type: "text", text: "github_token not found in KV store" }], isError: true };
  }

  const https = require("https");
  const apiBase = "https://api.github.com";

  function ghRequest(method, endpoint, body) {
    return new Promise((resolve) => {
      const url = new URL(apiBase + endpoint);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          "Authorization": "token " + token,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Sidekick-MCP/1.0"
        }
      };
      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Type"] = "application/json";
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, data: data });
          }
        });
      });
      req.on("error", (err) => resolve({ status: 0, data: err.message }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: "timeout" }); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  const actions = {
    pr_list: async () => {
      const res = await ghRequest("GET", `/repos/${repo}/pulls?state=open`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const prs = res.data.map(pr => `#${pr.number} ${pr.title} (${pr.user.login}) - ${pr.html_url}`);
      return { content: [{ type: "text", text: prs.join("\n") || "No open PRs" }] };
    },
    pr_create: async () => {
      const { title, head, base, body } = JSON.parse(extraArgs || "{}");
      if (!title || !head) return { content: [{ type: "text", text: "title and head required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/pulls`, { title, head, base: base || "main", body: body || "" });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created PR #${res.data.number}: ${res.data.html_url}` }] };
    },
    pr_get: async () => {
      const num = extraArgs;
      if (!num) return { content: [{ type: "text", text: "PR number required" }], isError: true };
      const res = await ghRequest("GET", `/repos/${repo}/pulls/${num}`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const pr = res.data;
      return { content: [{ type: "text", text: `#${pr.number} ${pr.title}\nState: ${pr.state}\nAuthor: ${pr.user.login}\nURL: ${pr.html_url}\n${pr.body || ""}` }] };
    },
    pr_merge: async () => {
      const num = extraArgs;
      if (!num) return { content: [{ type: "text", text: "PR number required" }], isError: true };
      const res = await ghRequest("PUT", `/repos/${repo}/pulls/${num}/merge`, { merge_method: "squash" });
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Merged PR #${num}` }] };
    },
    issue_list: async () => {
      const res = await ghRequest("GET", `/repos/${repo}/issues?state=open`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const issues = res.data.filter(i => !i.pull_request).map(i => `#${i.number} ${i.title} (${i.user.login}) - ${i.html_url}`);
      return { content: [{ type: "text", text: issues.join("\n") || "No open issues" }] };
    },
    issue_create: async () => {
      const { title, body } = JSON.parse(extraArgs || "{}");
      if (!title) return { content: [{ type: "text", text: "title required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/issues`, { title, body: body || "" });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created issue #${res.data.number}: ${res.data.html_url}` }] };
    },
    issue_close: async () => {
      const num = extraArgs;
      if (!num) return { content: [{ type: "text", text: "issue number required" }], isError: true };
      const res = await ghRequest("PATCH", `/repos/${repo}/issues/${num}`, { state: "closed" });
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Closed issue #${num}` }] };
    },
    commit_status: async () => {
      const sha = extraArgs;
      if (!sha) return { content: [{ type: "text", text: "commit SHA required" }], isError: true };
      const res = await ghRequest("GET", `/repos/${repo}/commits/${sha}/status`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const statuses = res.data.statuses.map(s => `${s.context}: ${s.state} - ${s.description || ""}`);
      return { content: [{ type: "text", text: `Overall: ${res.data.state}\n${statuses.join("\n") || "No statuses"}` }] };
    },
    release_create: async () => {
      const { tag_name, name, body, draft, prerelease } = JSON.parse(extraArgs || "{}");
      if (!tag_name) return { content: [{ type: "text", text: "tag_name required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/releases`, { tag_name, name: name || tag_name, body: body || "", draft: draft || false, prerelease: prerelease || false });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created release ${res.data.name}: ${res.data.html_url}` }] };
    },
    repo_info: async () => {
      const res = await ghRequest("GET", `/repos/${repo}`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const r = res.data;
      return { content: [{ type: "text", text: `${r.full_name}\nStars: ${r.stargazers_count} | Forks: ${r.forks_count} | Issues: ${r.open_issues_count}\nDefault branch: ${r.default_branch}\n${r.description || ""}` }] };
    }
  };

  if (!actions[action]) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + Object.keys(actions).join(", ") }], isError: true };
  }

  return actions[action]();
}

// --- Webhook Tool ---

function loadWebhooks() {
  if (!fs.existsSync(WEBHOOK_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WEBHOOK_FILE, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveWebhooks(webhooks) {
  fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(webhooks, null, 2));
}

async function sidekick_webhook({ action, id, limit }) {
  const allowedActions = ["list", "get", "clear"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const webhooks = loadWebhooks();

  if (action === "list") {
    if (webhooks.length === 0) {
      return { content: [{ type: "text", text: "No webhooks received" }] };
    }
    const n = limit || 20;
    const recent = webhooks.slice(-n);
    const summary = recent.map(w => 
      w.id + " | " + w.source + " | " + w.timestamp + " | " + JSON.stringify(w.payload).substring(0, 50) + "..."
    ).join("\n");
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "get") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    const webhook = webhooks.find(w => w.id === id);
    if (!webhook) {
      return { content: [{ type: "text", text: "Webhook not found" }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(webhook, null, 2) }] };
  }

  if (action === "clear") {
    saveWebhooks([]);
    return { content: [{ type: "text", text: "Cleared all webhooks" }] };
  }
}

// --- Context Tool ---

function loadContext() {
  if (!fs.existsSync(CONTEXT_FILE)) {
    return {
      projects: {},
      decisions: [],
      problems: [],
      patterns: [],
      sessions: []
    };
  }
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf-8"));
  } catch (e) {
    return {
      projects: {},
      decisions: [],
      problems: [],
      patterns: [],
      sessions: []
    };
  }
}

function saveContext(ctx) {
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
}

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function simpleSimilarity(text1, text2) {
  const words1 = text1.toLowerCase().split(/\s+/);
  const words2 = text2.toLowerCase().split(/\s+/);
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

function searchContext(ctx, query, type, limit = 10) {
  const results = [];
  
  if (type === "all" || type === "decisions") {
    for (const dec of ctx.decisions) {
      const text = `${dec.context} ${dec.decision} ${dec.reasoning}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "decision", item: dec, score });
      }
    }
  }
  
  if (type === "all" || type === "problems") {
    for (const prob of ctx.problems) {
      const text = `${prob.description} ${prob.solution || ""}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "problem", item: prob, score });
      }
    }
  }
  
  if (type === "all" || type === "patterns") {
    for (const pat of ctx.patterns) {
      const text = `${pat.description} ${pat.example || ""}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "pattern", item: pat, score });
      }
    }
  }
  
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

async function sidekick_context({ action, project, context, decision, reasoning, problem, solution, pattern, query, type, limit }) {
  const allowedActions = ["track_project", "track_decision", "track_problem", "track_pattern", "recall", "suggest", "summarize", "list"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const ctx = loadContext();
  const now = new Date().toISOString();

  if (action === "track_project") {
    if (!project) {
      return { content: [{ type: "text", text: "project required" }], isError: true };
    }
    if (!ctx.projects[project]) {
      ctx.projects[project] = {
        name: project,
        created: now,
        lastWorked: now,
        sessions: 0,
        active: true
      };
    } else {
      ctx.projects[project].lastWorked = now;
      ctx.projects[project].sessions++;
    }
    saveContext(ctx);
    return { content: [{ type: "text", text: `Tracked project: ${project}` }] };
  }

  if (action === "track_decision") {
    if (!context || !decision) {
      return { content: [{ type: "text", text: "context and decision required" }], isError: true };
    }
    const dec = {
      id: generateId("dec"),
      date: now,
      project: project || null,
      context,
      decision,
      reasoning: reasoning || null,
      outcome: null
    };
    ctx.decisions.push(dec);
    if (project && ctx.projects[project]) {
      ctx.projects[project].lastWorked = now;
    }
    saveContext(ctx);
    return { content: [{ type: "text", text: `Tracked decision: ${decision} (id: ${dec.id})` }] };
  }

  if (action === "track_problem") {
    if (!problem) {
      return { content: [{ type: "text", text: "problem required" }], isError: true };
    }
    const prob = {
      id: generateId("prob"),
      date: now,
      project: project || null,
      description: problem,
      solution: solution || null,
      resolved: !!solution
    };
    ctx.problems.push(prob);
    if (project && ctx.projects[project]) {
      ctx.projects[project].lastWorked = now;
    }
    saveContext(ctx);
    return { content: [{ type: "text", text: `Tracked problem: ${problem} (id: ${prob.id})` }] };
  }

  if (action === "track_pattern") {
    if (!pattern) {
      return { content: [{ type: "text", text: "pattern required" }], isError: true };
    }
    const pat = {
      id: generateId("pat"),
      date: now,
      project: project || null,
      description: pattern,
      example: context || null
    };
    ctx.patterns.push(pat);
    saveContext(ctx);
    return { content: [{ type: "text", text: `Tracked pattern: ${pattern} (id: ${pat.id})` }] };
  }

  if (action === "recall") {
    if (!query) {
      return { content: [{ type: "text", text: "query required" }], isError: true };
    }
    const results = searchContext(ctx, query, type || "all", limit || 10);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No relevant context found" }] };
    }
    const summary = results.map(r => {
      const item = r.item;
      if (r.type === "decision") {
        return `[Decision ${item.id}] ${item.date}\nContext: ${item.context}\nDecision: ${item.decision}\nReasoning: ${item.reasoning || "N/A"}`;
      } else if (r.type === "problem") {
        return `[Problem ${item.id}] ${item.date}\nDescription: ${item.description}\nSolution: ${item.solution || "Unresolved"}`;
      } else if (r.type === "pattern") {
        return `[Pattern ${item.id}] ${item.date}\nDescription: ${item.description}\nExample: ${item.example || "N/A"}`;
      }
    }).join("\n\n");
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "suggest") {
    if (!query) {
      return { content: [{ type: "text", text: "query required" }], isError: true };
    }
    const results = searchContext(ctx, query, "all", 5);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No suggestions based on past context" }] };
    }
    const suggestions = results.map(r => {
      const item = r.item;
      if (r.type === "decision") {
        return `• You previously decided: "${item.decision}" because "${item.reasoning || "no reason recorded"}" (on ${item.date})`;
      } else if (r.type === "problem") {
        return `• You encountered a similar problem: "${item.description}" - ${item.solution ? `solved with: "${item.solution}"` : "unresolved"}`;
      } else if (r.type === "pattern") {
        return `• You have a pattern: "${item.description}"`;
      }
    }).join("\n");
    return { content: [{ type: "text", text: `Based on your past context:\n\n${suggestions}` }] };
  }

  if (action === "summarize") {
    const projectName = project || "all";
    let summary = `# Context Summary`;
    
    if (projectName !== "all") {
      const proj = ctx.projects[projectName];
      if (!proj) {
        return { content: [{ type: "text", text: `Project not found: ${projectName}` }], isError: true };
      }
      summary += `\n\n## Project: ${projectName}\n`;
      summary += `- Created: ${proj.created}\n`;
      summary += `- Last worked: ${proj.lastWorked}\n`;
      summary += `- Sessions: ${proj.sessions}\n`;
      
      const projDecisions = ctx.decisions.filter(d => d.project === projectName);
      const projProblems = ctx.problems.filter(p => p.project === projectName);
      const projPatterns = ctx.patterns.filter(p => p.project === projectName);
      
      if (projDecisions.length > 0) {
        summary += `\n### Decisions (${projDecisions.length}):\n`;
        projDecisions.slice(-5).forEach(d => {
          summary += `- ${d.date}: ${d.decision}\n`;
        });
      }
      
      if (projProblems.length > 0) {
        summary += `\n### Problems (${projProblems.length}):\n`;
        projProblems.slice(-5).forEach(p => {
          summary += `- ${p.date}: ${p.description} ${p.resolved ? "(resolved)" : "(unresolved)"}\n`;
        });
      }
      
      if (projPatterns.length > 0) {
        summary += `\n### Patterns (${projPatterns.length}):\n`;
        projPatterns.slice(-5).forEach(p => {
          summary += `- ${p.description}\n`;
        });
      }
    } else {
      summary += `\n\n## Overview\n`;
      summary += `- Total projects: ${Object.keys(ctx.projects).length}\n`;
      summary += `- Total decisions: ${ctx.decisions.length}\n`;
      summary += `- Total problems: ${ctx.problems.length}\n`;
      summary += `- Total patterns: ${ctx.patterns.length}\n`;
      
      const activeProjects = Object.values(ctx.projects).filter(p => p.active);
      if (activeProjects.length > 0) {
        summary += `\n### Active Projects:\n`;
        activeProjects.forEach(p => {
          summary += `- ${p.name} (last worked: ${p.lastWorked})\n`;
        });
      }
    }
    
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "list") {
    const items = [];
    if (!type || type === "all" || type === "decisions") {
      items.push(`Decisions: ${ctx.decisions.length}`);
    }
    if (!type || type === "all" || type === "problems") {
      items.push(`Problems: ${ctx.problems.length}`);
    }
    if (!type || type === "all" || type === "patterns") {
      items.push(`Patterns: ${ctx.patterns.length}`);
    }
    if (!type || type === "all" || type === "projects") {
      items.push(`Projects: ${Object.keys(ctx.projects).length}`);
    }
    return { content: [{ type: "text", text: items.join("\n") }] };
  }
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
  sidekick_list_projects,
  sidekick_get_by_project,
  sidekick_search,
  sidekick_git,
  sidekick_notify,
  sidekick_process,
  sidekick_service,
  sidekick_archive,
  sidekick_cron,
  sidekick_github,
  sidekick_webhook,
  sidekick_context,
};

const TOOL_DEFS = [
  { name: "sidekick_bash", description: "Execute a shell command on the VPS", args: { command: "string" } },
  { name: "sidekick_read", description: "Read a file from the VPS filesystem", args: { path: "string" } },
  { name: "sidekick_write", description: "Write content to a file on the VPS", args: { path: "string", content: "string" } },
  { name: "sidekick_list", description: "List files and directories on the VPS", args: { path: "string" } },
  { name: "sidekick_store", description: "Store a value persistently in KV storage", args: { key: "string", value: "string", project: "string (optional)" } },
  { name: "sidekick_get", description: "Retrieve a stored value from KV storage", args: { key: "string" } },
  { name: "sidekick_web_fetch", description: "Fetch a URL from the VPS", args: { url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" } },
  { name: "sidekick_llm", description: "Ask the LLM (Groq cloud or local Phi-3-mini)", args: { prompt: "string", system: "string (optional)", temperature: "number (optional)" } },
  { name: "sidekick_list_projects", description: "List all unique project names in KV storage", args: {} },
  { name: "sidekick_get_by_project", description: "Get all keys and values for a specific project", args: { project: "string" } },
  { name: "sidekick_search", description: "Search file contents using ripgrep or grep", args: { pattern: "string", path: "string (optional)", include: "string (optional)" } },
  { name: "sidekick_git", description: "Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash)", args: { action: "string", path: "string (optional)", args: "string (optional)" } },
  { name: "sidekick_notify", description: "Send notifications to Discord, Slack, or email", args: { channel: "string", webhook_url: "string (optional)", recipient: "string (optional)", message: "string", title: "string (optional)" } },
  { name: "sidekick_process", description: "Manage processes (list, top CPU/memory, kill, tree)", args: { action: "string", filter: "string (optional)", pid: "number (optional)", name: "string (optional)", signal: "string (optional)" } },
  { name: "sidekick_service", description: "Manage systemd services (start, stop, restart, status, enable, disable, logs)", args: { action: "string", service: "string", lines: "number (optional)" } },
  { name: "sidekick_archive", description: "Create, extract, or list archives (tar.gz, zip)", args: { action: "string", path: "string", output: "string (optional)", format: "string (optional)" } },
  { name: "sidekick_cron", description: "Schedule recurring tasks (add, list, remove, run jobs)", args: { action: "string", name: "string (optional)", schedule: "string (optional)", command: "string (optional)", id: "string (optional)" } },
  { name: "sidekick_github", description: "GitHub API integration (PRs, issues, commits, releases)", args: { action: "string", repo: "string", args: "string (optional)" } },
  { name: "sidekick_webhook", description: "Manage received webhooks (list, get, clear)", args: { action: "string", id: "string (optional)", limit: "number (optional)" } },
  { name: "sidekick_context", description: "Persistent intelligent context management (track projects, decisions, problems, patterns; recall and suggest based on past context)", args: { action: "string", project: "string (optional)", context: "string (optional)", decision: "string (optional)", reasoning: "string (optional)", problem: "string (optional)", solution: "string (optional)", pattern: "string (optional)", query: "string (optional)", type: "string (optional)", limit: "number (optional)" } },
];

async function callTool(name, args) {
  const handler = TOOLS[name];
  if (!handler) {
    return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  }
  const start = Date.now();
  try {
    const result = await handler(args);
    const success = !result.isError;
    logToolCall(name, args, Date.now() - start, success,
      result.content?.[0]?.text?.substring(0, 80) || "(ok)"
    );
    return result;
  } catch (e) {
    logToolCall(name, args, Date.now() - start, false, e.message);
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

module.exports = { TOOLS, TOOL_DEFS, callTool, logToolCall, setSource, DATA_DIR, OLLAMA_URL, GROQ_API_KEY, GROQ_MODEL, migrateKV };
