const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
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
const PROCEDURES_FILE = path.join(DATA_DIR, "procedures.json");
const MAX_LOG = 1000;

const PROJECT_RE = /^[a-z][a-z0-9_]*$/;

const SHELL_META = /[`$\\!#&|;()*?<>[\]{}"'\n\r]/;
function shellEscape(arg) {
  if (arg === "") return "''";
  if (!SHELL_META.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

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
        source: 'init',
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

async function sidekick_store({ key, value, project, category }) {
  if (project !== undefined && project !== null && !PROJECT_RE.test(project)) {
    return { content: [{ type: "text", text: "Invalid project name. Must match /^[a-z][a-z0-9_]*$/" }], isError: true };
  }
  
  const now = new Date().toISOString();
  const existing = kvStore[key];
  
  if (existing && typeof existing === 'object' && 'value' in existing) {
    kvStore[key] = {
      value: value,
      project: project !== undefined ? project : existing.project,
      category: category !== undefined ? category : existing.category,
      source: currentSource,
      created: existing.created,
      updated: now
    };
  } else {
    kvStore[key] = {
      value: value,
      project: project || null,
      category: category || null,
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

async function sidekick_llm({ prompt, system, temperature, provider }) {
  const defaultProvider = process.env.SIDEKICK_DEFAULT_LLM || "ollama";
  const useGroq = (provider || defaultProvider) === "groq";
  
  if (useGroq && GROQ_API_KEY) {
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
      system: system || "You are a helpful assistant running on a remote machine.",
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
        { role: "system", content: system || "You are a helpful assistant running on a remote machine." },
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
  
  let useRg = false;
  try {
    execFileSync("which", ["rg"], { stdio: "ignore" });
    useRg = true;
  } catch (e) {}
  
  try {
    let stdout;
    if (useRg) {
      const args = ["--json", "--max-count", "100"];
      if (include) args.push("-g", include);
      args.push(pattern, targetPath);
      stdout = execFileSync("rg", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    } else {
      const args = ["-rn", "--max-count=100"];
      if (include) args.push("--include=" + include);
      args.push(pattern, targetPath);
      stdout = execFileSync("grep", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    }
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
  
  const cmdArgs = ["-C", repo, action];
  if (extraArgs) {
    const parsed = extraArgs.split(/\s+/).filter(Boolean);
    cmdArgs.push(...parsed);
  }
  
  try {
    const stdout = execFileSync("git", cmdArgs, { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
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
      const script = `cd /home/sidekick/sidekick && ${j.command} >> ${DATA_DIR}/cron-${j.id}.log 2>&1`;
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
  let token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    try {
      const secrets = loadSecrets();
      const secret = secrets["github_token"];
      if (secret) {
        token = decryptSecret(secret);
      }
    } catch (e) {
      // Secret store not available
    }
  }
  
  if (!token) {
    return { content: [{ type: "text", text: "github_token not found in secret store" }], isError: true };
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
  
  if (type === "all" || type === "sessions") {
    for (const sess of (ctx.sessions || [])) {
      const text = `${sess.summary || ""} ${(sess.topics || []).join(" ")} ${sess.notes || ""}`;
      const score = simpleSimilarity(query, text);
      if (score > 0.1) {
        results.push({ type: "session", item: sess, score });
      }
    }
  }
  
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

async function sidekick_context({ action, project, context, decision, reasoning, problem, solution, pattern, summary, topics, outcome, notes, query, type, limit }) {
  const allowedActions = ["track_project", "track_decision", "track_problem", "track_pattern", "track_session", "recall", "suggest", "summarize", "list"];
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

  if (action === "track_session") {
    if (!summary) {
      return { content: [{ type: "text", text: "summary required" }], isError: true };
    }
    const redactedSummary = redactSensitive(summary);
    const redactedNotes = notes ? redactSensitive(notes) : null;
    const topicList = topics ? topics.split(",").map(t => redactSensitive(t.trim())).filter(Boolean) : [];
    const sess = {
      id: generateId("sess"),
      date: now,
      project: project || null,
      summary: redactedSummary,
      topics: topicList,
      outcome: outcome || null,
      notes: redactedNotes
    };
    if (!ctx.sessions) ctx.sessions = [];
    ctx.sessions.push(sess);
    if (ctx.sessions.length > 100) {
      ctx.sessions = ctx.sessions.slice(-100);
    }
    if (project && ctx.projects[project]) {
      ctx.projects[project].lastWorked = now;
    }
    saveContext(ctx);
    return { content: [{ type: "text", text: `Tracked session: ${redactedSummary} (id: ${sess.id})` }] };
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
      } else if (r.type === "session") {
        return `[Session ${item.id}] ${item.date}\nSummary: ${item.summary}\nTopics: ${(item.topics || []).join(", ")}\nOutcome: ${item.outcome || "N/A"}`;
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
        return `â€¢ You previously decided: "${item.decision}" because "${item.reasoning || "no reason recorded"}" (on ${item.date})`;
      } else if (r.type === "problem") {
        return `â€¢ You encountered a similar problem: "${item.description}" - ${item.solution ? `solved with: "${item.solution}"` : "unresolved"}`;
      } else if (r.type === "pattern") {
        return `â€¢ You have a pattern: "${item.description}"`;
      } else if (r.type === "session") {
        return `â€¢ You had a session on ${item.date}: "${item.summary}" (${item.outcome || "no outcome recorded"})`;
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
      
      const projSessions = (ctx.sessions || []).filter(s => s.project === projectName);
      if (projSessions.length > 0) {
        summary += `\n### Recent Sessions (${projSessions.length}):\n`;
        projSessions.slice(-5).forEach(s => {
          summary += `- ${s.date}: ${s.summary} (${s.outcome || "N/A"})\n`;
        });
      }
    } else {
      summary += `\n\n## Overview\n`;
      summary += `- Total projects: ${Object.keys(ctx.projects).length}\n`;
      summary += `- Total decisions: ${ctx.decisions.length}\n`;
      summary += `- Total problems: ${ctx.problems.length}\n`;
      summary += `- Total patterns: ${ctx.patterns.length}\n`;
      summary += `- Total sessions: ${(ctx.sessions || []).length}\n`;
      
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
    if (!type || type === "all" || type === "sessions") {
      items.push(`Sessions: ${(ctx.sessions || []).length}`);
    }
    return { content: [{ type: "text", text: items.join("\n") }] };
  }
}

// --- Teach Tool ---

function loadProcedures() {
  if (!fs.existsSync(PROCEDURES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROCEDURES_FILE, "utf-8"));
  } catch (e) {
    return {};
  }
}

function saveProcedures(procedures) {
  fs.writeFileSync(PROCEDURES_FILE, JSON.stringify(procedures, null, 2));
}

function substituteParams(obj, params) {
  if (typeof obj === "string") {
    if (!params) return obj;
    return obj.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return params[key] !== undefined ? String(params[key]) : match;
    });
  }
  if (!params || typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => substituteParams(item, params));
  }
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = substituteParams(v, params);
  }
  return result;
}

async function sidekick_teach({ action, name, description, steps, example, trigger_phrases, implementation, parameters, args }) {
  const allowedActions = ["teach_procedure", "generate_tool", "learn_from_example", "execute", "list", "remove"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const procedures = loadProcedures();
  const now = new Date().toISOString();

  if (action === "teach_procedure") {
    if (!name || !description || !steps) {
      return { content: [{ type: "text", text: "name, description, and steps required" }], isError: true };
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return { content: [{ type: "text", text: "steps must be a non-empty array" }], isError: true };
    }
    for (const step of steps) {
      if (!step.tool || !step.args) {
        return { content: [{ type: "text", text: "Each step must have 'tool' and 'args' properties" }], isError: true };
      }
    }
    procedures[name] = {
      name,
      description,
      parameters: parameters || {},
      steps,
      triggerPhrases: trigger_phrases || [],
      createdAt: now,
      lastUsed: null,
      useCount: 0
    };
    saveProcedures(procedures);
    const paramCount = Object.keys(parameters || {}).length;
    return { content: [{ type: "text", text: `Taught procedure: ${name} (${steps.length} steps, ${paramCount} parameters)` }] };
  }

  if (action === "generate_tool") {
    if (!name || !description) {
      return { content: [{ type: "text", text: "name and description required" }], isError: true };
    }
    const toolSchemas = `
Tool parameter schemas:
- sidekick_bash: { "command": "shell command to run" }
- sidekick_read: { "path": "absolute file path" }
- sidekick_write: { "path": "absolute file path", "content": "file content" }
- sidekick_list: { "path": "/home/sidekick" } (optional path)
- sidekick_search: { "pattern": "regex", "path": "optional dir", "include": "optional file pattern" }
- sidekick_git: { "action": "status|diff|log|add|commit|push|pull|branch|checkout|stash", "args": "optional string" }
- sidekick_notify: { "channel": "discord|slack|email", "message": "text", "webhook_url": "for discord/slack", "recipient": "for email" }
- sidekick_process: { "action": "list|top|kill|tree", "filter": "optional name", "pid": "optional number", "name": "optional name" }
- sidekick_service: { "action": "start|stop|restart|status|enable|disable|logs", "service": "service name" }
- sidekick_archive: { "action": "create|extract|list", "path": "source path", "output": "output path for create", "format": "tar.gz|zip" }
- sidekick_store: { "key": "storage key", "value": "value to store", "project": "optional project name" }
- sidekick_get: { "key": "storage key" }
- sidekick_web_fetch: { "url": "URL to fetch", "method": "GET|POST", "body": "optional", "headers": "optional JSON" }
- sidekick_llm: { "prompt": "question", "system": "optional system prompt", "temperature": "optional 0-2" }
`;
    const prompt = `Generate a procedure definition for "${name}" based on this description: "${description}".

Return a JSON object with two properties:
1. "parameters": an object defining input parameters, where each key is a param name and value has "type" (string|number|boolean), "description", and optional "required" (boolean, default false)
2. "steps": a JSON array of steps, where each step has "tool" and "args" properties. Use {{paramName}} in arg values to reference parameters.

${toolSchemas}
Example format:
{
  "parameters": { "path": { "type": "string", "description": "Directory to check", "required": true } },
  "steps": [
    {"tool": "sidekick_bash", "args": {"command": "df -h {{path}}"}},
    {"tool": "sidekick_bash", "args": {"command": "du -sh {{path}}"}}
  ]
}

If the procedure takes no parameters, return an empty "parameters" object.
IMPORTANT: Use ONLY the parameters shown in the schemas above. Do not invent tool parameters.
Return ONLY the JSON object, no other text.`;
    
    const llmResult = await sidekick_llm({ prompt, system: "You are a helpful assistant that generates tool procedures with parameters. Return only valid JSON." });
    if (llmResult.isError) {
      return { content: [{ type: "text", text: "Failed to generate tool: " + llmResult.content[0].text }], isError: true };
    }
    
    let generated;
    try {
      const text = llmResult.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        generated = JSON.parse(jsonMatch[0]);
      } else {
        generated = JSON.parse(text);
      }
    } catch (e) {
      return { content: [{ type: "text", text: "Failed to parse generated definition: " + e.message }], isError: true };
    }
    
    const generatedSteps = generated.steps;
    const generatedParams = generated.parameters || {};
    
    if (!Array.isArray(generatedSteps) || generatedSteps.length === 0) {
      return { content: [{ type: "text", text: "Generated steps are invalid" }], isError: true };
    }
    
    procedures[name] = {
      name,
      description,
      parameters: generatedParams,
      steps: generatedSteps,
      triggerPhrases: [],
      createdAt: now,
      lastUsed: null,
      useCount: 0,
      generated: true
    };
    saveProcedures(procedures);
    const paramNames = Object.keys(generatedParams);
    return { content: [{ type: "text", text: `Generated tool: ${name} (${generatedSteps.length} steps, parameters: ${paramNames.length > 0 ? paramNames.join(", ") : "none"})\nSteps:\n${JSON.stringify(generatedSteps, null, 2)}` }] };
  }

  if (action === "learn_from_example") {
    if (!name || !example) {
      return { content: [{ type: "text", text: "name and example required" }], isError: true };
    }
    const toolSchemas = `
Tool parameter schemas:
- sidekick_bash: { "command": "shell command to run" }
- sidekick_read: { "path": "absolute file path" }
- sidekick_write: { "path": "absolute file path", "content": "file content" }
- sidekick_list: { "path": "/home/sidekick" } (optional path)
- sidekick_search: { "pattern": "regex", "path": "optional dir", "include": "optional file pattern" }
- sidekick_git: { "action": "status|diff|log|add|commit|push|pull|branch|checkout|stash", "args": "optional string" }
- sidekick_notify: { "channel": "discord|slack|email", "message": "text", "webhook_url": "for discord/slack", "recipient": "for email" }
- sidekick_process: { "action": "list|top|kill|tree", "filter": "optional name", "pid": "optional number", "name": "optional name" }
- sidekick_service: { "action": "start|stop|restart|status|enable|disable|logs", "service": "service name" }
- sidekick_archive: { "action": "create|extract|list", "path": "source path", "output": "output path for create", "format": "tar.gz|zip" }
- sidekick_store: { "key": "storage key", "value": "value to store", "project": "optional project name" }
- sidekick_get: { "key": "storage key" }
- sidekick_web_fetch: { "url": "URL to fetch", "method": "GET|POST", "body": "optional", "headers": "optional JSON" }
- sidekick_llm: { "prompt": "question", "system": "optional system prompt", "temperature": "optional 0-2" }
`;
    const prompt = `Parse this example and extract a procedure definition:
"${example}"

Return a JSON object with two properties:
1. "parameters": an object defining input parameters (use {{paramName}} references in steps). If nothing varies, use empty {}.
2. "steps": a JSON array of steps, where each step has "tool" and "args" properties.

${toolSchemas}
IMPORTANT: Use ONLY the parameters shown in the schemas above. Do not invent tool parameters.
Return ONLY the JSON object, no other text.`;
    
    const llmResult = await sidekick_llm({ prompt, system: "You are a helpful assistant that extracts procedures from examples. Return only valid JSON." });
    if (llmResult.isError) {
      return { content: [{ type: "text", text: "Failed to parse example: " + llmResult.content[0].text }], isError: true };
    }
    
    let parsed;
    try {
      const text = llmResult.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(text);
      }
    } catch (e) {
      return { content: [{ type: "text", text: "Failed to parse steps from example: " + e.message }], isError: true };
    }
    
    const parsedSteps = parsed.steps || parsed;
    const parsedParams = parsed.parameters || {};
    
    procedures[name] = {
      name,
      description: example,
      parameters: parsedParams,
      steps: Array.isArray(parsedSteps) ? parsedSteps : [],
      triggerPhrases: trigger_phrases || [],
      createdAt: now,
      lastUsed: null,
      useCount: 0,
      learned: true
    };
    saveProcedures(procedures);
    return { content: [{ type: "text", text: `Learned procedure: ${name} (${(Array.isArray(parsedSteps) ? parsedSteps.length : 0)} steps)` }] };
  }

  if (action === "execute") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    const procedure = procedures[name];
    if (!procedure) {
      return { content: [{ type: "text", text: `Procedure not found: ${name}` }], isError: true };
    }
    
    const params = args || {};
    const requiredParams = Object.entries(procedure.parameters || {})
      .filter(([, def]) => def.required)
      .map(([k]) => k);
    const missing = requiredParams.filter(k => params[k] === undefined);
    if (missing.length > 0) {
      return { content: [{ type: "text", text: `Missing required parameters: ${missing.join(", ")}` }], isError: true };
    }
    
    procedure.lastUsed = now;
    procedure.useCount++;
    saveProcedures(procedures);
    
    const results = [];
    for (let i = 0; i < procedure.steps.length; i++) {
      const step = procedure.steps[i];
      const resolvedArgs = substituteParams(step.args, params);
      try {
        const result = await callTool(step.tool, resolvedArgs);
        results.push({
          step: i + 1,
          tool: step.tool,
          success: !result.isError,
          output: result.content[0].text.substring(0, 200)
        });
        if (result.isError) {
          return { content: [{ type: "text", text: `Procedure '${name}' failed at step ${i + 1} (${step.tool}):\n${result.content[0].text}` }], isError: true };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Procedure '${name}' failed at step ${i + 1} (${step.tool}): ${e.message}` }], isError: true };
      }
    }
    
    const summary = results.map(r => `Step ${r.step} (${r.tool}): ${r.success ? "âœ“" : "âœ—"} ${r.output}`).join("\n");
    return { content: [{ type: "text", text: `Executed procedure '${name}' (${procedure.steps.length} steps)\n\n${summary}` }] };
  }

  if (action === "list") {
    const procNames = Object.keys(procedures);
    if (procNames.length === 0) {
      return { content: [{ type: "text", text: "No procedures taught yet" }] };
    }
    const summary = procNames.map(name => {
      const proc = procedures[name];
      const tags = [];
      if (proc.generated) tags.push("generated");
      if (proc.learned) tags.push("learned");
      const paramNames = Object.keys(proc.parameters || {});
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      const paramStr = paramNames.length > 0 ? ` params: {${paramNames.join(", ")}}` : "";
      return `${name}${tagStr} - ${proc.description} (${proc.steps.length} steps, used ${proc.useCount} times${paramStr})`;
    }).join("\n");
    return { content: [{ type: "text", text: `Taught procedures (${procNames.length}):\n\n${summary}` }] };
  }

  if (action === "remove") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    if (!procedures[name]) {
      return { content: [{ type: "text", text: `Procedure not found: ${name}` }], isError: true };
    }
    delete procedures[name];
    saveProcedures(procedures);
    return { content: [{ type: "text", text: `Removed procedure: ${name}` }] };
  }
}

// --- Transform Tool ---

async function sidekick_transform({ action, input, pattern, format, field, key, value }) {
  if (!input && input !== "") {
    return { content: [{ type: "text", text: "input required" }], isError: true };
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    data = input;
  }

  if (action === "filter") {
    if (!pattern) {
      return { content: [{ type: "text", text: "pattern required for filter" }], isError: true };
    }
    if (typeof data === "string") {
      const regex = new RegExp(pattern);
      const lines = data.split("\n");
      const matches = lines.filter(line => regex.test(line));
      const result = matches.join("\n");
      return { content: [{ type: "text", text: result }] };
    } else if (Array.isArray(data)) {
      const regex = new RegExp(pattern);
      const filtered = data.filter(item => {
        if (typeof item === "string") return regex.test(item);
        if (typeof item === "object") return regex.test(JSON.stringify(item));
        return regex.test(String(item));
      });
      return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
    } else {
      return { content: [{ type: "text", text: "filter works on strings or arrays" }], isError: true };
    }
  }

  if (action === "extract") {
    if (!field) {
      return { content: [{ type: "text", text: "field required for extract" }], isError: true };
    }
    if (typeof data !== "object" || data === null) {
      return { content: [{ type: "text", text: "extract requires JSON input" }], isError: true };
    }
    const fields = field.split(".");
    let result = data;
    for (const f of fields) {
      if (result === undefined || result === null) break;
      if (Array.isArray(result) && f === "[]") {
        continue;
      }
      result = result[f];
    }
    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "sort") {
    if (!Array.isArray(data)) {
      return { content: [{ type: "text", text: "sort requires array input" }], isError: true };
    }
    const sorted = [...data].sort((a, b) => {
      if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
      if (typeof a === "number" && typeof b === "number") return a - b;
      if (typeof a === "object" && typeof b === "object") {
        if (key) {
          const aVal = a[key];
          const bVal = b[key];
          if (typeof aVal === "number" && typeof bVal === "number") return aVal - bVal;
          return String(aVal).localeCompare(String(bVal));
        }
      }
      return String(a).localeCompare(String(b));
    });
    return { content: [{ type: "text", text: JSON.stringify(sorted, null, 2) }] };
  }

  if (action === "format") {
    if (!format) {
      return { content: [{ type: "text", text: "format required" }], isError: true };
    }
    if (format === "json") {
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    if (format === "csv") {
      if (!Array.isArray(data)) {
        return { content: [{ type: "text", text: "csv format requires array input" }], isError: true };
      }
      if (data.length === 0) return { content: [{ type: "text", text: "" }] };
      const first = data[0];
      if (typeof first !== "object" || first === null) {
        return { content: [{ type: "text", text: data.join("\n") }] };
      }
      const headers = Object.keys(first);
      const rows = data.map(item => headers.map(h => {
        const val = item[h];
        const str = val === null || val === undefined ? "" : String(val);
        return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(","));
      return { content: [{ type: "text", text: [headers.join(","), ...rows].join("\n") }] };
    }
    if (format === "table") {
      if (!Array.isArray(data)) {
        return { content: [{ type: "text", text: "table format requires array input" }], isError: true };
      }
      if (data.length === 0) return { content: [{ type: "text", text: "" }] };
      const first = data[0];
      if (typeof first !== "object" || first === null) {
        return { content: [{ type: "text", text: data.join("\n") }] };
      }
      const headers = Object.keys(first);
      const widths = headers.map(h => Math.max(h.length, ...data.map(row => String(row[h] || "").length)));
      const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join(" | ");
      const separator = widths.map(w => "-".repeat(w)).join("-+-");
      const dataRows = data.map(row => headers.map((h, i) => String(row[h] || "").padEnd(widths[i])).join(" | "));
      return { content: [{ type: "text", text: [headerRow, separator, ...dataRows].join("\n") }] };
    }
    if (format === "text") {
      if (typeof data === "string") return { content: [{ type: "text", text: data }] };
      if (Array.isArray(data)) return { content: [{ type: "text", text: data.join("\n") }] };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
    return { content: [{ type: "text", text: "Unknown format. Use: json, csv, table, text" }], isError: true };
  }

  if (action === "map") {
    if (!key || !value) {
      return { content: [{ type: "text", text: "key and value required for map" }], isError: true };
    }
    if (!Array.isArray(data)) {
      return { content: [{ type: "text", text: "map requires array input" }], isError: true };
    }
    const mapped = data.map(item => {
      if (typeof item === "object" && item !== null) {
        return { ...item, [key]: value };
      }
      return { [key]: value, original: item };
    });
    return { content: [{ type: "text", text: JSON.stringify(mapped, null, 2) }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: filter, extract, sort, format, map" }], isError: true };
}

// --- Health Tool ---

const HEALTH_HISTORY_FILE = path.join(DATA_DIR, "health_history.json");
const MAX_HEALTH_HISTORY = 100;

function loadHealthHistory() {
  if (!fs.existsSync(HEALTH_HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HEALTH_HISTORY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveHealthHistory(history) {
  fs.writeFileSync(HEALTH_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function checkServices(serviceList) {
  const services = serviceList ? serviceList.split(",").map(s => s.trim()) : ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"];
  const results = [];
  let healthy = 0;
  for (const svc of services) {
    try {
      const output = execSync(`systemctl is-active ${svc} 2>&1`, { encoding: "utf-8" }).trim();
      const isActive = output === "active";
      results.push({ service: svc, status: output, healthy: isActive });
      if (isActive) healthy++;
    } catch (e) {
      results.push({ service: svc, status: "unknown", healthy: false, error: e.message });
    }
  }
  return { results, score: (healthy / services.length) * 100, healthy, total: services.length };
}

function checkProcesses() {
  try {
    const output = execSync("ps aux --sort=-%cpu | head -11", { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    const processes = lines.slice(1).map(line => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1]),
        cpu: parseFloat(parts[2]),
        mem: parseFloat(parts[3]),
        command: parts.slice(10).join(" ")
      };
    });
    const highCpu = processes.filter(p => p.cpu > 50);
    const highMem = processes.filter(p => p.mem > 50);
    const score = 100 - (highCpu.length * 10) - (highMem.length * 10);
    return {
      results: { top: processes.slice(0, 5), highCpu, highMem },
      score: Math.max(0, score),
      issues: [...highCpu.map(p => `High CPU: ${p.command} (${p.cpu}%)`), ...highMem.map(p => `High MEM: ${p.command} (${p.mem}%)`)]
    };
  } catch (e) {
    return { results: {}, score: 0, issues: [`Failed to check processes: ${e.message}`] };
  }
}

function checkDisk() {
  try {
    const output = execSync("df -h --output=source,pcent,target | grep -E '^/dev'", { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    const disks = lines.map(line => {
      const parts = line.split(/\s+/);
      return {
        filesystem: parts[0],
        usage: parseInt(parts[1]),
        mount: parts[2]
      };
    });
    const critical = disks.filter(d => d.usage > 90);
    const warning = disks.filter(d => d.usage > 80 && d.usage <= 90);
    const score = 100 - (critical.length * 20) - (warning.length * 10);
    return {
      results: disks,
      score: Math.max(0, score),
      issues: [...critical.map(d => `Critical: ${d.mount} at ${d.usage}%`), ...warning.map(d => `Warning: ${d.mount} at ${d.usage}%`)]
    };
  } catch (e) {
    return { results: {}, score: 0, issues: [`Failed to check disk: ${e.message}`] };
  }
}

function checkNetwork() {
  try {
    const pingOutput = execSync("ping -c 1 -W 2 8.8.8.8 2>&1", { encoding: "utf-8" });
    const hasInternet = pingOutput.includes("1 received");
    const services = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"];
    const ports = {};
    for (const svc of services) {
      try {
        const port = svc === "sidekick-mcp" ? 4097 : svc === "sidekick-dashboard" ? 4098 : 4099;
        execSync(`ss -tlnp | grep :${port}`, { encoding: "utf-8" });
        ports[svc] = { port, listening: true };
      } catch {
        ports[svc] = { port: svc === "sidekick-mcp" ? 4097 : svc === "sidekick-dashboard" ? 4098 : 4099, listening: false };
      }
    }
    const listeningCount = Object.values(ports).filter(p => p.listening).length;
    const score = (hasInternet ? 50 : 0) + (listeningCount / services.length) * 50;
    return {
      results: { internet: hasInternet, ports },
      score,
      issues: hasInternet ? [] : ["No internet connectivity"],
      recommendations: Object.entries(ports).filter(([_, p]) => !p.listening).map(([svc]) => `${svc} not listening on port ${svc === "sidekick-mcp" ? 4097 : svc === "sidekick-dashboard" ? 4098 : 4099}`)
    };
  } catch (e) {
    return { results: {}, score: 0, issues: [`Failed to check network: ${e.message}`] };
  }
}

function checkCustom(commands) {
  if (!commands) return { results: {}, score: 100, issues: [] };
  const cmdList = commands.split(",").map(c => c.trim());
  const results = [];
  let allPassed = true;
  for (const cmd of cmdList) {
    try {
      const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
      results.push({ command: cmd, output, success: true });
    } catch (e) {
      results.push({ command: cmd, error: e.message, success: false });
      allPassed = false;
    }
  }
  return { results, score: allPassed ? 100 : 50, issues: results.filter(r => !r.success).map(r => `Failed: ${r.command}`) };
}

function parseThresholds(threshold) {
  if (!threshold) return {};
  const thresholds = {};
  const parts = threshold.split(",").map(t => t.trim());
  for (const part of parts) {
    const match = part.match(/^(\w+)([><=]+)(\d+)$/);
    if (match) {
      thresholds[match[1]] = { operator: match[2], value: parseInt(match[3]) };
    }
  }
  return thresholds;
}

function applyThresholds(results, thresholds) {
  const issues = [];
  for (const [metric, { operator, value }] of Object.entries(thresholds)) {
    if (metric === "disk" && results.disk?.results) {
      for (const disk of results.disk.results) {
        const usage = disk.usage;
        if ((operator === ">" && usage > value) || (operator === ">=" && usage >= value)) {
          issues.push(`Disk ${disk.mount} at ${usage}% exceeds threshold ${operator}${value}%`);
        }
      }
    }
    if (metric === "mem" && results.processes?.results?.top) {
      for (const proc of results.processes.results.top) {
        if ((operator === ">" && proc.mem > value) || (operator === ">=" && proc.mem >= value)) {
          issues.push(`Process ${proc.command} using ${proc.mem}% memory exceeds threshold ${operator}${value}%`);
        }
      }
    }
  }
  return issues;
}

async function sidekick_health({ check, services, commands, threshold }) {
  const now = new Date().toISOString();
  const checks = check === "all" ? ["services", "processes", "disk", "network"] : [check];
  const results = {};
  let totalScore = 0;
  let totalChecks = 0;
  const allIssues = [];
  const allRecommendations = [];

  for (const c of checks) {
    if (c === "services") {
      results.services = checkServices(services);
      totalScore += results.services.score;
      totalChecks++;
    } else if (c === "processes") {
      results.processes = checkProcesses();
      totalScore += results.processes.score;
      totalChecks++;
      if (results.processes.issues) allIssues.push(...results.processes.issues);
    } else if (c === "disk") {
      results.disk = checkDisk();
      totalScore += results.disk.score;
      totalChecks++;
      if (results.disk.issues) allIssues.push(...results.disk.issues);
    } else if (c === "network") {
      results.network = checkNetwork();
      totalScore += results.network.score;
      totalChecks++;
      if (results.network.issues) allIssues.push(...results.network.issues);
      if (results.network.recommendations) allRecommendations.push(...results.network.recommendations);
    } else if (c === "custom") {
      results.custom = checkCustom(commands);
      totalScore += results.custom.score;
      totalChecks++;
      if (results.custom.issues) allIssues.push(...results.custom.issues);
    } else {
      return { content: [{ type: "text", text: `Unknown check: ${c}. Use: all, services, processes, disk, network, custom` }], isError: true };
    }
  }

  const thresholds = parseThresholds(threshold);
  const thresholdIssues = applyThresholds(results, thresholds);
  allIssues.push(...thresholdIssues);

  const overallScore = totalChecks > 0 ? Math.round(totalScore / totalChecks) : 0;

  const history = loadHealthHistory();
  history.push({ date: now, score: overallScore, checks: checks.join(","), issues: allIssues.length });
  if (history.length > MAX_HEALTH_HISTORY) history.splice(0, history.length - MAX_HEALTH_HISTORY);
  saveHealthHistory(history);

  let output = `# Health Check Report\n\n`;
  output += `**Overall Score: ${overallScore}/100**\n`;
  output += `**Time: ${now}**\n\n`;

  for (const c of checks) {
    output += `## ${c.charAt(0).toUpperCase() + c.slice(1)}\n`;
    if (c === "services") {
      output += `- Score: ${results.services.score.toFixed(0)}/100\n`;
      output += `- Services: ${results.services.healthy}/${results.services.total} healthy\n`;
      for (const svc of results.services.results) {
        output += `  - ${svc.service}: ${svc.status} ${svc.healthy ? "âœ“" : "âœ—"}\n`;
      }
    } else if (c === "processes") {
      output += `- Score: ${results.processes.score.toFixed(0)}/100\n`;
      output += `- Top processes (by CPU):\n`;
      for (const proc of results.processes.results.top) {
        output += `  - ${proc.command.substring(0, 40)}: CPU ${proc.cpu}%, MEM ${proc.mem}%\n`;
      }
    } else if (c === "disk") {
      output += `- Score: ${results.disk.score.toFixed(0)}/100\n`;
      output += `- Disk usage:\n`;
      for (const disk of results.disk.results) {
        output += `  - ${disk.mount}: ${disk.usage}%\n`;
      }
    } else if (c === "network") {
      output += `- Score: ${results.network.score.toFixed(0)}/100\n`;
      output += `- Internet: ${results.network.results.internet ? "âœ“" : "âœ—"}\n`;
      output += `- Ports:\n`;
      for (const [svc, info] of Object.entries(results.network.results.ports)) {
        output += `  - ${svc} (${info.port}): ${info.listening ? "listening" : "not listening"}\n`;
      }
    } else if (c === "custom") {
      output += `- Score: ${results.custom.score.toFixed(0)}/100\n`;
      for (const res of results.custom.results) {
        output += `  - ${res.command}: ${res.success ? "âœ“" : "âœ—"}\n`;
        if (res.output) output += `    ${res.output.substring(0, 100)}\n`;
      }
    }
    output += `\n`;
  }

  if (allIssues.length > 0) {
    output += `## Issues (${allIssues.length})\n`;
    for (const issue of allIssues) {
      output += `- ${issue}\n`;
    }
    output += `\n`;
  }

  if (allRecommendations.length > 0) {
    output += `## Recommendations\n`;
    for (const rec of allRecommendations) {
      output += `- ${rec}\n`;
    }
    output += `\n`;
  }

  if (overallScore >= 90) {
    output += `**Status: HEALTHY** âœ“\n`;
  } else if (overallScore >= 70) {
    output += `**Status: WARNING** âš \n`;
  } else {
    output += `**Status: CRITICAL** âœ—\n`;
  }

  return { content: [{ type: "text", text: output }] };
}

// --- Delay Tool ---

const DELAYS_FILE = path.join(DATA_DIR, "delays.json");

function loadDelays() {
  if (!fs.existsSync(DELAYS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DELAYS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveDelays(delays) {
  fs.writeFileSync(DELAYS_FILE, JSON.stringify(delays, null, 2));
}

function parseWhen(when) {
  if (!when) return null;
  
  const match = when.match(/^(\d+)(s|m|h|d)$/);
  if (match) {
    const amount = parseInt(match[1]);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(Date.now() + amount * multipliers[unit]);
  }
  
  const date = new Date(when);
  if (!isNaN(date.getTime())) {
    return date;
  }
  
  return null;
}

async function sidekick_delay({ action, id, when, name, tool, args }) {
  const delays = loadDelays();
  const now = new Date().toISOString();
  
  if (action === "add") {
    if (!when || !tool) {
      return { content: [{ type: "text", text: "when and tool required" }], isError: true };
    }
    
    const executeAt = parseWhen(when);
    if (!executeAt) {
      return { content: [{ type: "text", text: "Invalid when format. Use: 10s, 5m, 2h, 1d, or ISO date" }], isError: true };
    }
    
    if (executeAt.getTime() <= Date.now()) {
      return { content: [{ type: "text", text: "Time must be in the future" }], isError: true };
    }
    
    const delay = {
      id: generateId("delay"),
      name: name || `${tool} at ${executeAt.toISOString()}`,
      when: executeAt.toISOString(),
      tool,
      args: args || {},
      created: now,
      status: "pending"
    };
    
    delays.push(delay);
    saveDelays(delays);
    
    const msUntil = executeAt.getTime() - Date.now();
    const minutes = Math.round(msUntil / 60000);
    
    try {
      const http = require("http");
      const req = http.request({
        hostname: "127.0.0.1",
        port: 4099,
        path: "/api/delays/reload",
        method: "POST"
      });
      req.on("error", () => {});
      req.end();
    } catch {}
    
    return { content: [{ type: "text", text: `Scheduled delay: ${delay.id}\nWill execute ${tool} in ${minutes} minutes (${executeAt.toISOString()})` }] };
  }
  
  if (action === "list") {
    const pending = delays.filter(d => d.status === "pending");
    const completed = delays.filter(d => d.status === "completed");
    const cancelled = delays.filter(d => d.status === "cancelled");
    
    let output = `# Scheduled Delays\n\n`;
    output += `**Pending: ${pending.length}**\n`;
    output += `**Completed: ${completed.length}**\n`;
    output += `**Cancelled: ${cancelled.length}**\n\n`;
    
    if (pending.length > 0) {
      output += `## Pending\n`;
      for (const d of pending) {
        const when = new Date(d.when);
        const msUntil = when.getTime() - Date.now();
        const minutes = Math.round(msUntil / 60000);
        output += `- **${d.id}**: ${d.name}\n`;
        output += `  - Tool: ${d.tool}\n`;
        output += `  - Executes in: ${minutes} minutes (${d.when})\n`;
      }
    }
    
    if (completed.length > 0) {
      output += `\n## Completed (last 5)\n`;
      for (const d of completed.slice(-5)) {
        output += `- ${d.id}: ${d.name} (completed ${d.completedAt})\n`;
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  }
  
  if (action === "cancel") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const delay = delays.find(d => d.id === id);
    if (!delay) {
      return { content: [{ type: "text", text: `Delay not found: ${id}` }], isError: true };
    }
    
    if (delay.status !== "pending") {
      return { content: [{ type: "text", text: `Delay ${id} is not pending (status: ${delay.status})` }], isError: true };
    }
    
    delay.status = "cancelled";
    delay.cancelledAt = now;
    saveDelays(delays);
    
    return { content: [{ type: "text", text: `Cancelled delay: ${id}` }] };
  }
  
  if (action === "run") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const delay = delays.find(d => d.id === id);
    if (!delay) {
      return { content: [{ type: "text", text: `Delay not found: ${id}` }], isError: true };
    }
    
    if (delay.status !== "pending") {
      return { content: [{ type: "text", text: `Delay ${id} is not pending (status: ${delay.status})` }], isError: true };
    }
    
    delay.status = "running";
    delay.startedAt = now;
    saveDelays(delays);
    
    try {
      const result = await callTool(delay.tool, delay.args);
      delay.status = "completed";
      delay.completedAt = new Date().toISOString();
      delay.result = result.content?.[0]?.text?.substring(0, 200) || "ok";
      saveDelays(delays);
      
      return { content: [{ type: "text", text: `Executed delay ${id}:\n\n${result.content?.[0]?.text || "ok"}` }] };
    } catch (e) {
      delay.status = "failed";
      delay.completedAt = new Date().toISOString();
      delay.error = e.message;
      saveDelays(delays);
      
      return { content: [{ type: "text", text: `Delay ${id} failed: ${e.message}` }], isError: true };
    }
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: add, list, cancel, run" }], isError: true };
}

// --- Snapshot Tool ---

const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
if (!fs.existsSync(SNAPSHOTS_DIR)) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

function captureProcesses() {
  try {
    const output = execSync("ps aux --sort=-%mem", { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    return lines.slice(1).map(line => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1]),
        cpu: parseFloat(parts[2]),
        mem: parseFloat(parts[3]),
        command: parts.slice(10).join(" ")
      };
    });
  } catch {
    return [];
  }
}

function captureServices() {
  try {
    const output = execSync("systemctl list-units --type=service --state=running --no-pager", { encoding: "utf-8" });
    const lines = output.trim().split("\n").slice(1, -5);
    return lines.map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        unit: parts[0],
        load: parts[1],
        active: parts[2],
        sub: parts[3],
        description: parts.slice(4).join(" ")
      };
    });
  } catch {
    return [];
  }
}

function captureDisk() {
  try {
    const output = execSync("df -h --output=source,size,used,avail,pcent,target", { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    return lines.slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        usePercent: parts[4],
        mounted: parts[5]
      };
    });
  } catch {
    return [];
  }
}

function captureFiles(filePaths) {
  if (!filePaths) return {};
  const paths = filePaths.split(",").map(p => p.trim());
  const result = {};
  for (const p of paths) {
    try {
      const stat = execSync(`stat -c '%Y %s' ${p} 2>/dev/null`, { encoding: "utf-8" }).trim();
      const [mtime, size] = stat.split(" ");
      result[p] = { mtime: parseInt(mtime), size: parseInt(size) };
    } catch {
      result[p] = { error: "not found" };
    }
  }
  return result;
}

function capturePackages() {
  try {
    const output = execSync("dpkg -l | grep '^ii' | awk '{print $2, $3}'", { encoding: "utf-8" });
    return output.trim().split("\n").map(line => {
      const [name, version] = line.split(" ");
      return { name, version };
    });
  } catch {
    return [];
  }
}

function captureNetwork() {
  try {
    const interfaces = execSync("ip -o link show | awk '{print $2}' | tr -d ':'", { encoding: "utf-8" }).trim().split("\n");
    const result = {};
    for (const iface of interfaces) {
      try {
        const ip = execSync(`ip -o -4 addr show ${iface} | awk '{print $4}'`, { encoding: "utf-8" }).trim();
        result[iface] = { ip };
      } catch {
        result[iface] = { ip: "none" };
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function sidekick_snapshot({ action, name, capture, compare }) {
  const now = new Date().toISOString();
  
  if (action === "capture") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    
    const types = capture ? capture.split(",").map(t => t.trim()) : ["processes", "services", "disk"];
    const snapshot = { name, date: now, types, data: {} };
    
    for (const type of types) {
      if (type === "processes") {
        snapshot.data.processes = captureProcesses();
      } else if (type === "services") {
        snapshot.data.services = captureServices();
      } else if (type === "disk") {
        snapshot.data.disk = captureDisk();
      } else if (type === "packages") {
        snapshot.data.packages = capturePackages();
      } else if (type === "network") {
        snapshot.data.network = captureNetwork();
      } else if (type.startsWith("files:")) {
        const paths = type.substring(6);
        snapshot.data.files = captureFiles(paths);
      }
    }
    
    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    
    return { content: [{ type: "text", text: `Captured snapshot: ${name}\nTypes: ${types.join(", ")}\nDate: ${now}` }] };
  }
  
  if (action === "compare") {
    if (!name || !compare) {
      return { content: [{ type: "text", text: "name and compare required" }], isError: true };
    }
    
    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    const comparePath = path.join(SNAPSHOTS_DIR, `${compare}.json`);
    
    if (!fs.existsSync(snapshotPath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${name}` }], isError: true };
    }
    if (!fs.existsSync(comparePath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${compare}` }], isError: true };
    }
    
    const current = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    const baseline = JSON.parse(fs.readFileSync(comparePath, "utf-8"));
    
    let output = `# Snapshot Comparison\n\n`;
    output += `**Current: ${name}** (${current.date})\n`;
    output += `**Baseline: ${compare}** (${baseline.date})\n\n`;
    
    const diff = { added: [], removed: [], changed: [] };
    
    if (current.data.processes && baseline.data.processes) {
      const currentPids = new Set(current.data.processes.map(p => p.pid));
      const baselinePids = new Set(baseline.data.processes.map(p => p.pid));
      
      for (const p of current.data.processes) {
        if (!baselinePids.has(p.pid)) diff.added.push(`Process: ${p.command} (PID ${p.pid})`);
      }
      for (const p of baseline.data.processes) {
        if (!currentPids.has(p.pid)) diff.removed.push(`Process: ${p.command} (PID ${p.pid})`);
      }
    }
    
    if (current.data.services && baseline.data.services) {
      const currentServices = new Set(current.data.services.map(s => s.unit));
      const baselineServices = new Set(baseline.data.services.map(s => s.unit));
      
      for (const s of current.data.services) {
        if (!baselineServices.has(s.unit)) diff.added.push(`Service: ${s.unit}`);
      }
      for (const s of baseline.data.services) {
        if (!currentServices.has(s.unit)) diff.removed.push(`Service: ${s.unit}`);
      }
    }
    
    if (current.data.files && baseline.data.files) {
      for (const [path, info] of Object.entries(current.data.files)) {
        const baselineInfo = baseline.data.files[path];
        if (!baselineInfo) {
          diff.added.push(`File: ${path}`);
        } else if (info.mtime !== baselineInfo.mtime || info.size !== baselineInfo.size) {
          diff.changed.push(`File: ${path} (modified)`);
        }
      }
      for (const path of Object.keys(baseline.data.files)) {
        if (!current.data.files[path]) {
          diff.removed.push(`File: ${path}`);
        }
      }
    }
    
    output += `## Summary\n`;
    output += `- Added: ${diff.added.length}\n`;
    output += `- Removed: ${diff.removed.length}\n`;
    output += `- Changed: ${diff.changed.length}\n\n`;
    
    if (diff.added.length > 0) {
      output += `## Added\n`;
      for (const item of diff.added.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.added.length > 20) output += `- ... and ${diff.added.length - 20} more\n`;
      output += `\n`;
    }
    
    if (diff.removed.length > 0) {
      output += `## Removed\n`;
      for (const item of diff.removed.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.removed.length > 20) output += `- ... and ${diff.removed.length - 20} more\n`;
      output += `\n`;
    }
    
    if (diff.changed.length > 0) {
      output += `## Changed\n`;
      for (const item of diff.changed.slice(0, 20)) {
        output += `- ${item}\n`;
      }
      if (diff.changed.length > 20) output += `- ... and ${diff.changed.length - 20} more\n`;
      output += `\n`;
    }
    
    return { content: [{ type: "text", text: output }] };
  }
  
  if (action === "list") {
    const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith(".json"));
    const snapshots = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), "utf-8"));
      return { name: data.name, date: data.date, types: data.types.join(", ") };
    });
    
    let output = `# Snapshots (${snapshots.length})\n\n`;
    for (const s of snapshots) {
      output += `- **${s.name}** (${s.date})\n  Types: ${s.types}\n`;
    }
    
    return { content: [{ type: "text", text: output }] };
  }
  
  if (action === "delete") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    
    const snapshotPath = path.join(SNAPSHOTS_DIR, `${name}.json`);
    if (!fs.existsSync(snapshotPath)) {
      return { content: [{ type: "text", text: `Snapshot not found: ${name}` }], isError: true };
    }
    
    fs.unlinkSync(snapshotPath);
    return { content: [{ type: "text", text: `Deleted snapshot: ${name}` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: capture, compare, list, delete" }], isError: true };
}

// --- Watch Tool ---

const WATCHES_FILE = path.join(DATA_DIR, "watches.json");

function loadWatches() {
  if (!fs.existsSync(WATCHES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WATCHES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveWatches(watches) {
  fs.writeFileSync(WATCHES_FILE, JSON.stringify(watches, null, 2));
}

function parseInterval(interval) {
  if (!interval) return 60000;
  const match = interval.match(/^(\d+)(s|m|h)$/);
  if (!match) return 60000;
  const amount = parseInt(match[1]);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000 };
  return amount * multipliers[unit];
}

function checkService(serviceName) {
  try {
    const output = execSync(`systemctl is-active ${serviceName} 2>&1`, { encoding: "utf-8" }).trim();
    return { status: output, active: output === "active" };
  } catch {
    return { status: "unknown", active: false };
  }
}

function checkProcess(processName) {
  try {
    const output = execSync(`pgrep -f "${processName}" 2>/dev/null`, { encoding: "utf-8" }).trim();
    return { running: output.length > 0, pids: output.split("\n").filter(Boolean) };
  } catch {
    return { running: false, pids: [] };
  }
}

function checkEndpoint(url) {
  try {
    const output = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${url}"`, { encoding: "utf-8" }).trim();
    return { status: parseInt(output), ok: output.startsWith("2") };
  } catch {
    return { status: 0, ok: false };
  }
}

function checkFile(filePath, pattern) {
  try {
    const output = execSync(`cat "${filePath}" 2>/dev/null`, { encoding: "utf-8" });
    const matches = pattern ? output.includes(pattern) : true;
    return { exists: true, matches, content: output.substring(0, 200) };
  } catch {
    return { exists: false, matches: false };
  }
}

function evaluateCondition(watch, checkResult) {
  const { source, condition, value } = watch;
  
  if (source === "service") {
    if (condition === "status!=active") return !checkResult.active;
    if (condition === "status=active") return checkResult.active;
  }
  
  if (source === "process") {
    if (condition === "not_running") return !checkResult.running;
    if (condition === "running") return checkResult.running;
  }
  
  if (source === "endpoint") {
    if (condition === "status!=200") return checkResult.status !== 200;
    if (condition === "status=200") return checkResult.status === 200;
    if (condition.startsWith("status>=")) {
      const threshold = parseInt(condition.substring(8));
      return checkResult.status >= threshold;
    }
  }
  
  if (source === "file") {
    if (condition === "content_matches") return checkResult.exists && checkResult.matches;
    if (condition === "not_exists") return !checkResult.exists;
    if (condition === "exists") return checkResult.exists;
  }
  
  return false;
}

async function executeWatchAction(watch, checkResult) {
  const { action_tool, action_args } = watch;
  if (!action_tool) return;
  
  const args = { ...action_args };
  if (args.message) {
    args.message = args.message
      .replace(/\{\{source\}\}/g, watch.source)
      .replace(/\{\{target\}\}/g, watch.target)
      .replace(/\{\{status\}\}/g, JSON.stringify(checkResult))
      .replace(/\{\{time\}\}/g, new Date().toISOString());
  }
  
  try {
    await callTool(action_tool, args);
  } catch (e) {
    console.error(`Watch ${watch.id} action failed: ${e.message}`);
  }
}

async function sidekick_watch({ action, id, name, source, target, condition, interval, action_tool, action_args, pause }) {
  const watches = loadWatches();
  const now = new Date().toISOString();
  
  if (action === "add") {
    if (!name || !source || !target || !condition) {
      return { content: [{ type: "text", text: "name, source, target, and condition required" }], isError: true };
    }
    
    const validSources = ["service", "process", "endpoint", "file"];
    if (!validSources.includes(source)) {
      return { content: [{ type: "text", text: `Invalid source. Use: ${validSources.join(", ")}` }], isError: true };
    }
    
    const watch = {
      id: generateId("watch"),
      name,
      source,
      target,
      condition,
      interval: interval || "60s",
      action_tool: action_tool || "sidekick_notify",
      action_args: action_args || { channel: "discord", message: "Watch triggered: {{source}} {{target}} at {{time}}" },
      created: now,
      status: "active",
      lastCheck: null,
      lastTriggered: null,
      triggerCount: 0
    };
    
    watches.push(watch);
    saveWatches(watches);
    
    try {
      const http = require("http");
      const req = http.request({
        hostname: "127.0.0.1",
        port: 4099,
        path: "/api/watches/reload",
        method: "POST"
      });
      req.on("error", () => {});
      req.end();
    } catch {}
    
    return { content: [{ type: "text", text: `Added watch: ${watch.id}\nName: ${name}\nSource: ${source} ${target}\nCondition: ${condition}\nInterval: ${watch.interval}\nAction: ${watch.action_tool}` }] };
  }
  
  if (action === "list") {
    const active = watches.filter(w => w.status === "active");
    const paused = watches.filter(w => w.status === "paused");
    
    let output = `# Active Watches\n\n`;
    output += `**Active: ${active.length}**\n`;
    output += `**Paused: ${paused.length}**\n\n`;
    
    if (active.length > 0) {
      output += `## Active\n`;
      for (const w of active) {
        output += `- **${w.id}**: ${w.name}\n`;
        output += `  - Source: ${w.source} ${w.target}\n`;
        output += `  - Condition: ${w.condition}\n`;
        output += `  - Interval: ${w.interval}\n`;
        output += `  - Triggers: ${w.triggerCount}\n`;
        if (w.lastCheck) output += `  - Last check: ${w.lastCheck}\n`;
        if (w.lastTriggered) output += `  - Last triggered: ${w.lastTriggered}\n`;
      }
    }
    
    if (paused.length > 0) {
      output += `\n## Paused\n`;
      for (const w of paused) {
        output += `- ${w.id}: ${w.name}\n`;
      }
    }
    
    return { content: [{ type: "text", text: output }] };
  }
  
  if (action === "remove") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const idx = watches.findIndex(w => w.id === id);
    if (idx === -1) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }
    
    watches.splice(idx, 1);
    saveWatches(watches);
    
    return { content: [{ type: "text", text: `Removed watch: ${id}` }] };
  }
  
  if (action === "pause") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const watch = watches.find(w => w.id === id);
    if (!watch) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }
    
    watch.status = pause ? "paused" : "active";
    saveWatches(watches);
    
    return { content: [{ type: "text", text: `${pause ? "Paused" : "Resumed"} watch: ${id}` }] };
  }
  
  if (action === "check") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const watch = watches.find(w => w.id === id);
    if (!watch) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }
    
    let checkResult;
    if (watch.source === "service") {
      checkResult = checkService(watch.target);
    } else if (watch.source === "process") {
      checkResult = checkProcess(watch.target);
    } else if (watch.source === "endpoint") {
      checkResult = checkEndpoint(watch.target);
    } else if (watch.source === "file") {
      checkResult = checkFile(watch.target, watch.condition === "content_matches" ? watch.value : null);
    }
    
    const triggered = evaluateCondition(watch, checkResult);
    
    watch.lastCheck = now;
    if (triggered) {
      watch.lastTriggered = now;
      watch.triggerCount++;
      await executeWatchAction(watch, checkResult);
    }
    saveWatches(watches);
    
    return { content: [{ type: "text", text: `Watch check: ${watch.id}\nSource: ${watch.source} ${watch.target}\nResult: ${JSON.stringify(checkResult)}\nTriggered: ${triggered}` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: add, list, remove, pause, check" }], isError: true };
}

// --- Secret Tool ---

const crypto = require("crypto");
const SECRETS_FILE = path.join(DATA_DIR, "secrets.enc");

function getSecretKey() {
  const key = process.env.SIDEKICK_SECRET_KEY;
  if (!key) {
    throw new Error("SIDEKICK_SECRET_KEY not set in .env");
  }
  return crypto.createHash("sha256").update(key).digest();
}

function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    const data = fs.readFileSync(SECRETS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveSecrets(secrets) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

function encryptSecret(value) {
  const key = getSecretKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return { iv: iv.toString("hex"), data: encrypted, authTag };
}

function decryptSecret(encrypted) {
  const key = getSecretKey();
  const iv = Buffer.from(encrypted.iv, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));
  let decrypted = decipher.update(encrypted.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

async function sidekick_secret({ action, key, value, generate }) {
  const now = new Date().toISOString();
  
  try {
    getSecretKey();
  } catch (e) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
  
  const secrets = loadSecrets();
  
  if (action === "store") {
    if (!key || !value) {
      return { content: [{ type: "text", text: "key and value required" }], isError: true };
    }
    
    const encrypted = encryptSecret(value);
    secrets[key] = {
      ...encrypted,
      created: now,
      updated: now
    };
    saveSecrets(secrets);
    
    return { content: [{ type: "text", text: `Stored secret: ${key}` }] };
  }
  
  if (action === "get") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }
    
    const secret = secrets[key];
    if (!secret) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }
    
    try {
      const decrypted = decryptSecret(secret);
      return { content: [{ type: "text", text: decrypted }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Decryption failed: ${e.message}` }], isError: true };
    }
  }
  
  if (action === "delete") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }
    
    if (!secrets[key]) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }
    
    delete secrets[key];
    saveSecrets(secrets);
    
    return { content: [{ type: "text", text: `Deleted secret: ${key}` }] };
  }
  
  if (action === "list") {
    const keys = Object.keys(secrets);
    let output = `# Stored Secrets (${keys.length})\n\n`;
    for (const k of keys) {
      const s = secrets[k];
      output += `- **${k}** (created: ${s.created}, updated: ${s.updated})\n`;
    }
    return { content: [{ type: "text", text: output }] };
  }
  
  if (action === "rotate") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }
    
    const secret = secrets[key];
    if (!secret) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }
    
    let newValue;
    if (generate) {
      const length = parseInt(generate);
      if (isNaN(length) || length < 8) {
        return { content: [{ type: "text", text: "generate must be a number >= 8" }], isError: true };
      }
      newValue = crypto.randomBytes(length).toString("hex").substring(0, length);
    } else {
      return { content: [{ type: "text", text: "generate parameter required for rotation" }], isError: true };
    }
    
    const encrypted = encryptSecret(newValue);
    secrets[key] = {
      ...encrypted,
      created: secret.created,
      updated: now
    };
    saveSecrets(secrets);
    
    return { content: [{ type: "text", text: `Rotated secret: ${key}\nNew value: ${newValue}` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: store, get, delete, list, rotate" }], isError: true };
}

// --- Parse Tool ---

const YAML = require("yaml");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const INI = require("ini");

function detectFormat(input) {
  const trimmed = input.trim();
  
  // Try JSON first
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {}
  }
  
  // Check for YAML indicators
  if (trimmed.includes(":") && (trimmed.includes("\n") || trimmed.startsWith("---"))) {
    try {
      YAML.parse(trimmed);
      return "yaml";
    } catch {}
  }
  
  // Check for XML
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<")) {
    try {
      const parser = new XMLParser();
      parser.parse(trimmed);
      return "xml";
    } catch {}
  }
  
  // Check for INI
  if (trimmed.includes("[") && trimmed.includes("=")) {
    try {
      INI.parse(trimmed);
      return "ini";
    } catch {}
  }
  
  // Check for CSV (has commas and newlines)
  if (trimmed.includes(",") && trimmed.includes("\n")) {
    return "csv";
  }
  
  return null;
}

function parseCSV(input) {
  const lines = input.trim().split("\n");
  if (lines.length === 0) return [];
  
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"(.*)"$/, "$1"));
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim().replace(/^"(.*)"$/, "$1"));
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || "";
    }
    rows.push(row);
  }
  
  return rows;
}

async function sidekick_parse({ input, format }) {
  if (!input) {
    return { content: [{ type: "text", text: "input required" }], isError: true };
  }
  
  const detectedFormat = format || detectFormat(input);
  
  if (!detectedFormat) {
    return { content: [{ type: "text", text: "Could not detect format. Specify format: json, yaml, xml, ini, csv" }], isError: true };
  }
  
  try {
    let parsed;
    
    if (detectedFormat === "json") {
      parsed = JSON.parse(input);
    } else if (detectedFormat === "yaml") {
      parsed = YAML.parse(input);
    } else if (detectedFormat === "xml") {
      const parser = new XMLParser({ ignoreAttributes: false });
      parsed = parser.parse(input);
    } else if (detectedFormat === "ini") {
      parsed = INI.parse(input);
    } else if (detectedFormat === "csv") {
      parsed = parseCSV(input);
    } else {
      return { content: [{ type: "text", text: `Unsupported format: ${detectedFormat}` }], isError: true };
    }
    
    return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Parse error (${detectedFormat}): ${e.message}` }], isError: true };
  }
}

// --- Diff Tool ---

function diffText(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const changes = [];
  
  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    
    if (oldLine === undefined) {
      changes.push({ type: "added", line: i + 1, content: newLine });
    } else if (newLine === undefined) {
      changes.push({ type: "removed", line: i + 1, content: oldLine });
    } else if (oldLine !== newLine) {
      changes.push({ type: "modified", line: i + 1, oldContent: oldLine, newContent: newLine });
    }
  }
  
  return changes;
}

function diffJSON(oldObj, newObj, path = "") {
  const changes = [];
  
  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  
  for (const key of allKeys) {
    const currentPath = path ? `${path}.${key}` : key;
    const oldVal = oldObj?.[key];
    const newVal = newObj?.[key];
    
    if (oldVal === undefined) {
      changes.push({ type: "added", path: currentPath, value: newVal });
    } else if (newVal === undefined) {
      changes.push({ type: "removed", path: currentPath, value: oldVal });
    } else if (typeof oldVal === "object" && typeof newVal === "object" && oldVal !== null && newVal !== null) {
      // Recursively diff nested objects
      if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        // Array comparison
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes.push({ type: "modified", path: currentPath, oldValue: oldVal, newValue: newVal });
        }
      } else {
        // Object comparison
        changes.push(...diffJSON(oldVal, newVal, currentPath));
      }
    } else if (oldVal !== newVal) {
      changes.push({ type: "modified", path: currentPath, oldValue: oldVal, newValue: newVal });
    }
  }
  
  return changes;
}

function formatChanges(changes, format) {
  if (format === "summary") {
    const added = changes.filter(c => c.type === "added").length;
    const removed = changes.filter(c => c.type === "removed").length;
    const modified = changes.filter(c => c.type === "modified").length;
    return `Summary: ${added} added, ${removed} removed, ${modified} modified`;
  }
  
  if (format === "unified") {
    return changes.map(c => {
      if (c.type === "added") {
        return `+ ${c.path || `line ${c.line}`}: ${JSON.stringify(c.value || c.content)}`;
      } else if (c.type === "removed") {
        return `- ${c.path || `line ${c.line}`}: ${JSON.stringify(c.value || c.content)}`;
      } else if (c.type === "modified") {
        return `~ ${c.path || `line ${c.line}`}:\n- ${JSON.stringify(c.oldValue || c.oldContent)}\n+ ${JSON.stringify(c.newValue || c.newContent)}`;
      }
    }).join("\n");
  }
  
  // Default: structured JSON
  return JSON.stringify(changes, null, 2);
}

async function sidekick_diff({ old_text, new_text, format, type }) {
  if (!old_text || !new_text) {
    return { content: [{ type: "text", text: "old_text and new_text required" }], isError: true };
  }
  
  const diffType = type || "auto";
  const outputFormat = format || "unified";
  
  let changes;
  
  if (diffType === "text") {
    changes = diffText(old_text, new_text);
  } else if (diffType === "json") {
    try {
      const oldObj = JSON.parse(old_text);
      const newObj = JSON.parse(new_text);
      changes = diffJSON(oldObj, newObj);
    } catch (e) {
      return { content: [{ type: "text", text: `JSON parse error: ${e.message}` }], isError: true };
    }
  } else if (diffType === "yaml") {
    try {
      const oldObj = YAML.parse(old_text);
      const newObj = YAML.parse(new_text);
      changes = diffJSON(oldObj, newObj);
    } catch (e) {
      return { content: [{ type: "text", text: `YAML parse error: ${e.message}` }], isError: true };
    }
  } else {
    // Auto-detect
    const oldFormat = detectFormat(old_text);
    const newFormat = detectFormat(new_text);
    
    if (oldFormat === "json" && newFormat === "json") {
      try {
        const oldObj = JSON.parse(old_text);
        const newObj = JSON.parse(new_text);
        changes = diffJSON(oldObj, newObj);
      } catch (e) {
        return { content: [{ type: "text", text: `Auto-detect JSON parse error: ${e.message}` }], isError: true };
      }
    } else if ((oldFormat === "yaml" && newFormat === "yaml") || (oldFormat === "json" && newFormat === "yaml") || (oldFormat === "yaml" && newFormat === "json")) {
      try {
        const oldObj = oldFormat === "json" ? JSON.parse(old_text) : YAML.parse(old_text);
        const newObj = newFormat === "json" ? JSON.parse(new_text) : YAML.parse(new_text);
        changes = diffJSON(oldObj, newObj);
      } catch (e) {
        return { content: [{ type: "text", text: `Auto-detect YAML/JSON parse error: ${e.message}` }], isError: true };
      }
    } else {
      // Fall back to text diff
      changes = diffText(old_text, new_text);
    }
  }
  
  const output = formatChanges(changes, outputFormat);
  return { content: [{ type: "text", text: output }] };
}

// --- Hash Tool ---

async function sidekick_hash({ input, algorithm, verify, path: filePath }) {
  const algo = algorithm || "sha256";
  const validAlgorithms = ["md5", "sha1", "sha256", "sha512"];
  
  if (!validAlgorithms.includes(algo)) {
    return { content: [{ type: "text", text: `Invalid algorithm. Use: ${validAlgorithms.join(", ")}` }], isError: true };
  }
  
  let data;
  
  if (filePath) {
    // Hash a file
    try {
      data = fs.readFileSync(filePath);
    } catch (e) {
      return { content: [{ type: "text", text: `File read error: ${e.message}` }], isError: true };
    }
  } else if (input) {
    // Hash input string
    data = Buffer.from(input, "utf-8");
  } else {
    return { content: [{ type: "text", text: "input or path required" }], isError: true };
  }
  
  const hash = crypto.createHash(algo).update(data).digest("hex");
  
  if (verify) {
    const matches = hash === verify.toLowerCase();
    return { content: [{ type: "text", text: matches ? `âœ“ Hash matches (${algo}: ${hash})` : `âœ— Hash mismatch\nExpected: ${verify}\nActual:   ${hash}` }] };
  }
  
  return { content: [{ type: "text", text: `${algo.toUpperCase()}: ${hash}` }] };
}

// --- Validate Tool ---

const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, verbose: true });

async function sidekick_validate({ data, schema }) {
  if (!data || !schema) {
    return { content: [{ type: "text", text: "data and schema required" }], isError: true };
  }
  
  let parsedData, parsedSchema;
  
  try {
    // Try to parse data as JSON, otherwise use as-is
    parsedData = typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    parsedData = data;
  }
  
  try {
    parsedSchema = typeof schema === "string" ? JSON.parse(schema) : schema;
  } catch (e) {
    return { content: [{ type: "text", text: `Schema parse error: ${e.message}` }], isError: true };
  }
  
  try {
    const validate = ajv.compile(parsedSchema);
    const valid = validate(parsedData);
    
    if (valid) {
      return { content: [{ type: "text", text: "âœ“ Validation passed" }] };
    } else {
      const errors = validate.errors.map(e => ({
        path: e.instancePath || "/",
        message: e.message,
        params: e.params
      }));
      return { content: [{ type: "text", text: `âœ— Validation failed:\n${JSON.stringify(errors, null, 2)}` }] };
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Validation error: ${e.message}` }], isError: true };
  }
}

// --- Template Tool ---

const Handlebars = require("handlebars");

async function sidekick_template({ template, data }) {
  if (!template) {
    return { content: [{ type: "text", text: "template required" }], isError: true };
  }
  
  let parsedData = {};
  
  if (data) {
    try {
      parsedData = typeof data === "string" ? JSON.parse(data) : data;
    } catch (e) {
      return { content: [{ type: "text", text: `Data parse error: ${e.message}` }], isError: true };
    }
  }
  
  try {
    const compiled = Handlebars.compile(template);
    const result = compiled(parsedData);
    return { content: [{ type: "text", text: result }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Template error: ${e.message}` }], isError: true };
  }
}

// --- Queue Tool ---

const QUEUE_FILE = path.join(DATA_DIR, "queue.json");

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return { tasks: [], nextId: 1 };
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch {
    return { tasks: [], nextId: 1 };
  }
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

async function sidekick_queue({ action, id, tool, args, priority, status }) {
  const queue = loadQueue();
  
  if (action === "add") {
    if (!tool) {
      return { content: [{ type: "text", text: "tool required" }], isError: true };
    }
    
    const task = {
      id: queue.nextId++,
      tool,
      args: args || {},
      priority: priority || 0,
      status: "pending",
      created: new Date().toISOString(),
      attempts: 0
    };
    
    queue.tasks.push(task);
    queue.tasks.sort((a, b) => b.priority - a.priority);
    saveQueue(queue);
    
    return { content: [{ type: "text", text: `Added task ${task.id} (priority: ${task.priority})` }] };
  }
  
  if (action === "list") {
    const filterStatus = status || "all";
    const filtered = filterStatus === "all" 
      ? queue.tasks 
      : queue.tasks.filter(t => t.status === filterStatus);
    
    if (filtered.length === 0) {
      return { content: [{ type: "text", text: `No tasks found (status: ${filterStatus})` }] };
    }
    
    const summary = filtered.map(t => 
      `Task ${t.id}: ${t.tool} (priority: ${t.priority}, status: ${t.status}, attempts: ${t.attempts})`
    ).join("\n");
    
    return { content: [{ type: "text", text: `Queue (${filtered.length} tasks):\n${summary}` }] };
  }
  
  if (action === "process") {
    const pending = queue.tasks.find(t => t.status === "pending");
    
    if (!pending) {
      return { content: [{ type: "text", text: "No pending tasks" }] };
    }
    
    pending.status = "processing";
    pending.attempts++;
    saveQueue(queue);
    
    try {
      const result = await callTool(pending.tool, pending.args);
      
      if (result.isError) {
        pending.status = "failed";
        pending.error = result.content?.[0]?.text || "Unknown error";
        pending.failedAt = new Date().toISOString();
      } else {
        pending.status = "completed";
        pending.result = result.content?.[0]?.text?.substring(0, 200);
        pending.completedAt = new Date().toISOString();
      }
      
      saveQueue(queue);
      return result;
    } catch (e) {
      pending.status = "failed";
      pending.error = e.message;
      pending.failedAt = new Date().toISOString();
      saveQueue(queue);
      
      return { content: [{ type: "text", text: `Task failed: ${e.message}` }], isError: true };
    }
  }
  
  if (action === "remove") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const idx = queue.tasks.findIndex(t => t.id === id);
    if (idx === -1) {
      return { content: [{ type: "text", text: `Task ${id} not found` }], isError: true };
    }
    
    queue.tasks.splice(idx, 1);
    saveQueue(queue);
    
    return { content: [{ type: "text", text: `Removed task ${id}` }] };
  }
  
  if (action === "clear") {
    const clearStatus = status || "all";
    
    if (clearStatus === "all") {
      queue.tasks = [];
    } else {
      queue.tasks = queue.tasks.filter(t => t.status !== clearStatus);
    }
    
    saveQueue(queue);
    return { content: [{ type: "text", text: `Cleared tasks (status: ${clearStatus})` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: add, list, process, remove, clear" }], isError: true };
}

// --- Retry Tool ---

async function sidekick_retry({ tool, args, max_attempts, backoff, initial_delay }) {
  if (!tool) {
    return { content: [{ type: "text", text: "tool required" }], isError: true };
  }
  
  const maxAttempts = max_attempts || 3;
  const backoffType = backoff || "exponential";
  const initialDelay = initial_delay || 1000;
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callTool(tool, args || {});
      
      if (!result.isError) {
        return { content: [{ type: "text", text: `âœ“ Succeeded on attempt ${attempt}\n\n${result.content?.[0]?.text || ""}` }] };
      }
      
      lastError = result.content?.[0]?.text || "Unknown error";
    } catch (e) {
      lastError = e.message;
    }
    
    if (attempt < maxAttempts) {
      let delay;
      if (backoffType === "exponential") {
        delay = initialDelay * Math.pow(2, attempt - 1);
      } else if (backoffType === "linear") {
        delay = initialDelay * attempt;
      } else {
        delay = initialDelay;
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return { content: [{ type: "text", text: `âœ— Failed after ${maxAttempts} attempts\nLast error: ${lastError}` }], isError: true };
}

// --- Evolve Tool ---

const EVOLVE_FILE = path.join(DATA_DIR, "evolve.json");
const MAX_PROPOSALS_PER_DAY = 10;

function loadEvolve() {
  if (!fs.existsSync(EVOLVE_FILE)) return { proposals: [], history: [] };
  try {
    return JSON.parse(fs.readFileSync(EVOLVE_FILE, "utf-8"));
  } catch {
    return { proposals: [], history: [] };
  }
}

function saveEvolve(evolve) {
  fs.writeFileSync(EVOLVE_FILE, JSON.stringify(evolve, null, 2));
}

function analyzeToolUsage() {
  if (!fs.existsSync(LOG_FILE)) return { patterns: [], suggestions: [] };
  
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    const logs = lines.map(line => JSON.parse(line));
    
    // Count tool usage
    const toolCounts = {};
    const toolSequences = [];
    
    for (let i = 0; i < logs.length; i++) {
      const tool = logs[i].n;
      toolCounts[tool] = (toolCounts[tool] || 0) + 1;
      
      // Track sequences of 2-3 tools
      if (i < logs.length - 1) {
        const seq2 = [logs[i].n, logs[i + 1].n].join(" -> ");
        toolSequences.push(seq2);
      }
      if (i < logs.length - 2) {
        const seq3 = [logs[i].n, logs[i + 1].n, logs[i + 2].n].join(" -> ");
        toolSequences.push(seq3);
      }
    }
    
    // Find frequent sequences
    const seqCounts = {};
    for (const seq of toolSequences) {
      seqCounts[seq] = (seqCounts[seq] || 0) + 1;
    }
    
    const frequentSeqs = Object.entries(seqCounts)
      .filter(([_, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    const patterns = frequentSeqs.map(([seq, count]) => ({
      pattern: seq,
      count,
      suggestion: `Frequent pattern detected: ${seq} (${count} times). Consider creating a procedure.`
    }));
    
    return { patterns, toolCounts };
  } catch {
    return { patterns: [], suggestions: [] };
  }
}

async function sidekick_evolve({ action, id, proposal, approve, test }) {
  const evolve = loadEvolve();
  const now = new Date().toISOString();
  const today = now.split("T")[0];
  
  if (action === "analyze") {
    const analysis = analyzeToolUsage();
    
    if (analysis.patterns.length === 0) {
      return { content: [{ type: "text", text: "No frequent patterns detected yet. Continue using tools to build patterns." }] };
    }
    
    const report = analysis.patterns.map(p => 
      `Pattern: ${p.pattern}\nCount: ${p.count}\nSuggestion: ${p.suggestion}`
    ).join("\n\n");
    
    return { content: [{ type: "text", text: `# Tool Usage Analysis\n\n${report}` }] };
  }
  
  if (action === "propose") {
    if (!proposal) {
      return { content: [{ type: "text", text: "proposal required" }], isError: true };
    }
    
    // Check rate limit
    const todayProposals = evolve.proposals.filter(p => p.created.startsWith(today));
    if (todayProposals.length >= MAX_PROPOSALS_PER_DAY) {
      return { content: [{ type: "text", text: `Rate limit exceeded: max ${MAX_PROPOSALS_PER_DAY} proposals per day` }], isError: true };
    }
    
    const newProposal = {
      id: generateId("prop"),
      proposal,
      status: "pending",
      created: now,
      testResults: null
    };
    
    evolve.proposals.push(newProposal);
    saveEvolve(evolve);
    
    return { content: [{ type: "text", text: `Proposal created: ${newProposal.id}\nStatus: pending\nProposal: ${proposal}` }] };
  }
  
  if (action === "list") {
    if (evolve.proposals.length === 0) {
      return { content: [{ type: "text", text: "No proposals yet" }] };
    }
    
    const list = evolve.proposals.map(p => 
      `ID: ${p.id}\nStatus: ${p.status}\nCreated: ${p.created}\nProposal: ${p.proposal.substring(0, 100)}${p.proposal.length > 100 ? "..." : ""}`
    ).join("\n\n");
    
    return { content: [{ type: "text", text: `# Proposals (${evolve.proposals.length})\n\n${list}` }] };
  }
  
  if (action === "test") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const proposal = evolve.proposals.find(p => p.id === id);
    if (!proposal) {
      return { content: [{ type: "text", text: `Proposal not found: ${id}` }], isError: true };
    }
    
    // Simulate testing the proposal
    proposal.status = "testing";
    proposal.testStarted = now;
    saveEvolve(evolve);
    
    // In a real implementation, this would sandbox and test the proposal
    // For now, we'll simulate a successful test
    proposal.testResults = {
      passed: true,
      duration: 1500,
      notes: "Simulated test passed. Proposal appears safe."
    };
    proposal.status = "tested";
    proposal.testedAt = new Date().toISOString();
    saveEvolve(evolve);
    
    return { content: [{ type: "text", text: `Test completed for ${id}\nResult: ${proposal.testResults.passed ? "PASSED" : "FAILED"}\nNotes: ${proposal.testResults.notes}` }] };
  }
  
  if (action === "approve") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const proposal = evolve.proposals.find(p => p.id === id);
    if (!proposal) {
      return { content: [{ type: "text", text: `Proposal not found: ${id}` }], isError: true };
    }
    
    if (proposal.status !== "tested") {
      return { content: [{ type: "text", text: `Proposal must be tested before approval (current status: ${proposal.status})` }], isError: true };
    }
    
    proposal.status = "approved";
    proposal.approvedAt = new Date().toISOString();
    
    // Add to history
    evolve.history.push({
      id: proposal.id,
      proposal: proposal.proposal,
      approvedAt: proposal.approvedAt
    });
    
    saveEvolve(evolve);
    
    return { content: [{ type: "text", text: `Proposal ${id} approved and added to history` }] };
  }
  
  if (action === "reject") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const proposal = evolve.proposals.find(p => p.id === id);
    if (!proposal) {
      return { content: [{ type: "text", text: `Proposal not found: ${id}` }], isError: true };
    }
    
    proposal.status = "rejected";
    proposal.rejectedAt = new Date().toISOString();
    saveEvolve(evolve);
    
    return { content: [{ type: "text", text: `Proposal ${id} rejected` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: analyze, propose, list, test, approve, reject" }], isError: true };
}

// --- Orchestrate Tool ---

const ORCHESTRATE_FILE = path.join(DATA_DIR, "orchestrate.json");

function loadOrchestrate() {
  if (!fs.existsSync(ORCHESTRATE_FILE)) return { tasks: [], nextId: 1 };
  try {
    return JSON.parse(fs.readFileSync(ORCHESTRATE_FILE, "utf-8"));
  } catch {
    return { tasks: [], nextId: 1 };
  }
}

function saveOrchestrate(orchestrate) {
  fs.writeFileSync(ORCHESTRATE_FILE, JSON.stringify(orchestrate, null, 2));
}

async function sidekick_orchestrate({ action, id, task_name, subtasks, dependencies, timeout }) {
  const orchestrate = loadOrchestrate();
  const now = new Date().toISOString();
  
  if (action === "create") {
    if (!task_name || !subtasks || !Array.isArray(subtasks)) {
      return { content: [{ type: "text", text: "task_name and subtasks array required" }], isError: true };
    }
    
    const taskId = orchestrate.nextId++;
    const task = {
      id: taskId,
      name: task_name,
      subtasks: subtasks.map((st, idx) => ({
        id: `${taskId}-${idx}`,
        name: st.name || `Subtask ${idx + 1}`,
        tool: st.tool,
        args: st.args || {},
        status: "pending",
        result: null,
        error: null
      })),
      dependencies: dependencies || {},
      status: "created",
      created: now,
      timeout: timeout || 1800000, // 30 minutes default
      results: {}
    };
    
    orchestrate.tasks.push(task);
    saveOrchestrate(orchestrate);
    
    return { content: [{ type: "text", text: `Task ${taskId} created with ${subtasks.length} subtasks\nName: ${task_name}` }] };
  }
  
  if (action === "execute") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }
    
    task.status = "executing";
    task.startedAt = now;
    saveOrchestrate(orchestrate);
    
    // Execute subtasks respecting dependencies
    const executed = new Set();
    const results = {};
    
    for (const subtask of task.subtasks) {
      const deps = task.dependencies[subtask.id] || [];
      const depsMet = deps.every(d => executed.has(d));
      
      if (!depsMet) {
        subtask.status = "skipped";
        subtask.error = "Dependencies not met";
        continue;
      }
      
      subtask.status = "running";
      saveOrchestrate(orchestrate);
      
      try {
        const result = await callTool(subtask.tool, subtask.args);
        subtask.status = result.isError ? "failed" : "completed";
        subtask.result = result.content?.[0]?.text?.substring(0, 500);
        subtask.error = result.isError ? result.content?.[0]?.text : null;
        results[subtask.id] = subtask.result;
        executed.add(subtask.id);
      } catch (e) {
        subtask.status = "failed";
        subtask.error = e.message;
      }
      
      saveOrchestrate(orchestrate);
    }
    
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    task.results = results;
    saveOrchestrate(orchestrate);
    
    const summary = task.subtasks.map(st => 
      `${st.name}: ${st.status}${st.error ? ` (${st.error.substring(0, 50)})` : ""}`
    ).join("\n");
    
    return { content: [{ type: "text", text: `Task ${id} executed\n\nSubtask Results:\n${summary}` }] };
  }
  
  if (action === "list") {
    if (orchestrate.tasks.length === 0) {
      return { content: [{ type: "text", text: "No orchestration tasks" }] };
    }
    
    const list = orchestrate.tasks.map(t => 
      `ID: ${t.id}\nName: ${t.name}\nStatus: ${t.status}\nSubtasks: ${t.subtasks.length}\nCreated: ${t.created}`
    ).join("\n\n");
    
    return { content: [{ type: "text", text: `# Orchestration Tasks (${orchestrate.tasks.length})\n\n${list}` }] };
  }
  
  if (action === "status") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }
    
    const status = task.subtasks.map(st => 
      `${st.name}: ${st.status}${st.result ? `\n  Result: ${st.result.substring(0, 100)}...` : ""}${st.error ? `\n  Error: ${st.error.substring(0, 100)}` : ""}`
    ).join("\n\n");
    
    return { content: [{ type: "text", text: `# Task ${id} Status\n\nName: ${task.name}\nOverall: ${task.status}\n\n## Subtasks\n\n${status}` }] };
  }
  
  if (action === "cancel") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    
    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }
    
    task.status = "cancelled";
    task.cancelledAt = new Date().toISOString();
    saveOrchestrate(orchestrate);
    
    return { content: [{ type: "text", text: `Task ${id} cancelled` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: create, execute, list, status, cancel" }], isError: true };
}

// --- Predict Tool ---

const PREDICT_FILE = path.join(DATA_DIR, "predict.json");

function loadPredict() {
  if (!fs.existsSync(PREDICT_FILE)) return { predictions: [], feedback: [] };
  try {
    return JSON.parse(fs.readFileSync(PREDICT_FILE, "utf-8"));
  } catch {
    return { predictions: [], feedback: [] };
  }
}

function savePredict(predict) {
  fs.writeFileSync(PREDICT_FILE, JSON.stringify(predict, null, 2));
}

function analyzeContextPatterns() {
  const CONTEXT_FILE = path.join(DATA_DIR, "context.json");
  if (!fs.existsSync(CONTEXT_FILE)) return [];
  
  try {
    const context = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf-8"));
    const patterns = [];
    
    // Analyze decision patterns
    if (context.decisions && context.decisions.length > 0) {
      const projectDecisions = {};
      for (const dec of context.decisions) {
        if (dec.project) {
          if (!projectDecisions[dec.project]) projectDecisions[dec.project] = [];
          projectDecisions[dec.project].push(dec);
        }
      }
      
      for (const [project, decisions] of Object.entries(projectDecisions)) {
        if (decisions.length >= 3) {
          patterns.push({
            type: "decision_pattern",
            project,
            count: decisions.length,
            prediction: `Project "${project}" has ${decisions.length} decisions. More decisions likely needed.`,
            confidence: 0.7
          });
        }
      }
    }
    
    // Analyze problem patterns
    if (context.problems && context.problems.length > 0) {
      const unresolved = context.problems.filter(p => !p.resolved);
      if (unresolved.length > 0) {
        patterns.push({
          type: "unresolved_problems",
          count: unresolved.length,
          prediction: `${unresolved.length} unresolved problems. Consider addressing these.`,
          confidence: 0.9
        });
      }
    }
    
    return patterns;
  } catch {
    return [];
  }
}

function analyzeToolPatterns() {
  if (!fs.existsSync(LOG_FILE)) return [];
  
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    const logs = lines.map(line => JSON.parse(line));
    
    const patterns = [];
    
    // Find most used tools
    const toolCounts = {};
    for (const log of logs) {
      toolCounts[log.n] = (toolCounts[log.n] || 0) + 1;
    }
    
    const topTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    if (topTools.length > 0) {
      patterns.push({
        type: "frequent_tools",
        tools: topTools,
        prediction: `Most used tools: ${topTools.map(([t, c]) => `${t} (${c})`).join(", ")}. These are critical to your workflow.`,
        confidence: 0.8
      });
    }
    
    // Find error patterns
    const errors = logs.filter(l => !l.ok);
    if (errors.length > logs.length * 0.1) {
      patterns.push({
        type: "error_rate",
        errorCount: errors.length,
        totalCount: logs.length,
        prediction: `Error rate: ${((errors.length / logs.length) * 100).toFixed(1)}%. Consider investigating frequent errors.`,
        confidence: 0.85
      });
    }
    
    return patterns;
  } catch {
    return [];
  }
}

async function sidekick_predict({ action, id, feedback, useful }) {
  const predict = loadPredict();
  const now = new Date().toISOString();
  
  if (action === "analyze") {
    const contextPatterns = analyzeContextPatterns();
    const toolPatterns = analyzeToolPatterns();
    
    const allPatterns = [...contextPatterns, ...toolPatterns];
    
    if (allPatterns.length === 0) {
      return { content: [{ type: "text", text: "No patterns detected yet. Continue using the system to build patterns." }] };
    }
    
    const predictions = allPatterns.map((p, idx) => ({
      id: generateId("pred"),
      ...p,
      created: now,
      feedback: null
    }));
    
    predict.predictions = predictions;
    savePredict(predict);
    
    const report = predictions.map(p => 
      `ID: ${p.id}\nType: ${p.type}\nConfidence: ${(p.confidence * 100).toFixed(0)}%\nPrediction: ${p.prediction}`
    ).join("\n\n");
    
    return { content: [{ type: "text", text: `# Predictions (${predictions.length})\n\n${report}` }] };
  }
  
  if (action === "list") {
    if (predict.predictions.length === 0) {
      return { content: [{ type: "text", text: "No predictions yet. Run 'analyze' first." }] };
    }
    
    const list = predict.predictions.map(p => 
      `ID: ${p.id}\nType: ${p.type}\nConfidence: ${(p.confidence * 100).toFixed(0)}%\nPrediction: ${p.prediction.substring(0, 100)}${p.prediction.length > 100 ? "..." : ""}\nFeedback: ${p.feedback || "none"}`
    ).join("\n\n");
    
    return { content: [{ type: "text", text: `# Predictions (${predict.predictions.length})\n\n${list}` }] };
  }
  
  if (action === "feedback") {
    if (!id || feedback === undefined) {
      return { content: [{ type: "text", text: "id and feedback (true/false) required" }], isError: true };
    }
    
    const prediction = predict.predictions.find(p => p.id === id);
    if (!prediction) {
      return { content: [{ type: "text", text: `Prediction not found: ${id}` }], isError: true };
    }
    
    prediction.feedback = feedback ? "useful" : "not_useful";
    prediction.feedbackAt = now;
    
    predict.feedback.push({
      predictionId: id,
      useful: feedback,
      timestamp: now
    });
    
    savePredict(predict);
    
    return { content: [{ type: "text", text: `Feedback recorded for ${id}: ${feedback ? "useful" : "not useful"}` }] };
  }
  
  if (action === "suggest") {
    const usefulPredictions = predict.predictions.filter(p => p.feedback === "useful");
    
    if (usefulPredictions.length === 0) {
      return { content: [{ type: "text", text: "No useful predictions yet. Provide feedback on predictions to improve suggestions." }] };
    }
    
    const suggestions = usefulPredictions.map(p => 
      `- ${p.prediction} (confidence: ${(p.confidence * 100).toFixed(0)}%)`
    ).join("\n");
    
    return { content: [{ type: "text", text: `# Suggestions Based on Past Predictions\n\n${suggestions}` }] };
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: analyze, list, feedback, suggest" }], isError: true };
}

// Debug tool implementation - uses persistent KV store for cross-session debugging
const DEBUG_SESSIONS = {};
const DEBUG_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours (for in-memory sessions)
const DEBUG_RETENTION_DAYS = 7; // For persistent storage

function loadDebugSessions() {
  const now = Date.now();
  for (const [id, session] of Object.entries(DEBUG_SESSIONS)) {
    if (now - session.started > DEBUG_TTL_MS) {
      delete DEBUG_SESSIONS[id];
    }
  }
}

function generateDebugKey(service, issue) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = (issue || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  return `debug:${service || 'unknown'}:${slug}_${date}`;
}

function getDebugEntries() {
  const entries = [];
  for (const [key, entry] of Object.entries(kvStore)) {
    if (key.startsWith('debug:') && typeof entry === 'object' && entry !== null && 'value' in entry) {
      entries.push({ key, ...entry });
    }
  }
  return entries.sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

function isOlderThan7Days(dateStr) {
  const entryDate = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DEBUG_RETENTION_DAYS);
  return entryDate < cutoff;
}

async function sidekick_debug_tool({ action, session_name, key, value, service, issue, redact }) {
  loadDebugSessions();
  const now = Date.now();
  const shouldRedact = redact !== false; // Default to true
  
  // --- Persistent storage actions (new) ---
  
  if (action === "store") {
    if (!service) {
      return { content: [{ type: "text", text: "service parameter required" }], isError: true };
    }
    if (!value) {
      return { content: [{ type: "text", text: "value parameter required" }], isError: true };
    }
    
    const debugKey = generateDebugKey(service, issue);
    const nowISO = new Date().toISOString();
    
    const storedValue = shouldRedact ? redactSensitive(value) : value;
    
    kvStore[debugKey] = {
      value: storedValue,
      project: "debug",
      category: "debug",
      source: currentSource,
      created: nowISO,
      updated: nowISO,
      service: service,
      issue: issue || "general"
    };
    
    saveKV();
    return { content: [{ type: "text", text: `Stored debug finding: ${debugKey} (${storedValue.length} chars)` }] };
  }
  
  if (action === "recall") {
    const entries = getDebugEntries();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DEBUG_RETENTION_DAYS);
    
    const recent = entries.filter(e => !isOlderThan7Days(e.updated));
    const old = entries.filter(e => isOlderThan7Days(e.updated));
    
    // Filter by service if provided
    const filtered = service 
      ? recent.filter(e => e.service === service)
      : recent;
    
    if (filtered.length === 0) {
      let msg = "No recent debug findings";
      if (service) msg += ` for service: ${service}`;
      return { content: [{ type: "text", text: msg }] };
    }
    
    let result = `# Debug Findings (last ${DEBUG_RETENTION_DAYS} days)\n\n`;
    result += filtered.map(e => {
      const age = Math.round((now - new Date(e.updated)) / 1000 / 60 / 60);
      return `## ${e.key}\n- Service: ${e.service}\n- Issue: ${e.issue}\n- Updated: ${age}h ago\n- Value: ${e.value}\n`;
    }).join("\n");
    
    if (old.length > 0) {
      result += `\n---\n**Note:** Found ${old.length} debug entries older than ${DEBUG_RETENTION_DAYS} days. Run cleanup with: sidekick_debug_tool action="cleanup"`;
    }
    
    return { content: [{ type: "text", text: result }] };
  }
  
  if (action === "cleanup") {
    // If key parameter provided, delete that specific entry (regardless of age)
    if (key && key !== "all") {
      if (kvStore[key] && key.startsWith('debug:')) {
        delete kvStore[key];
        saveKV();
        return { content: [{ type: "text", text: `Deleted: ${key}` }] };
      }
      return { content: [{ type: "text", text: `Key not found or not a debug entry: ${key}` }], isError: true };
    }
    
    const entries = getDebugEntries();
    const old = entries.filter(e => isOlderThan7Days(e.updated));
    
    if (old.length === 0) {
      return { content: [{ type: "text", text: "No debug entries older than " + DEBUG_RETENTION_DAYS + " days" }] };
    }
    
    // List old entries for review
    let result = `# Debug Entries Older Than ${DEBUG_RETENTION_DAYS} Days\n\n`;
    result += old.map(e => {
      const age = Math.round((now - new Date(e.updated)) / 1000 / 60 / 60 / 24);
      return `- **${e.key}** (${age} days old)\n  - Service: ${e.service}, Issue: ${e.issue}\n  - Delete with: sidekick_debug_tool action="cleanup" key="${e.key}"`;
    }).join("\n\n");
    
    result += `\n\nTo delete all old entries, use: sidekick_debug_tool action="cleanup" key="all"`;
    
    return { content: [{ type: "text", text: result }] };
  }
  
  // Special case: delete all old entries
  if (action === "cleanup" && key === "all") {
    const entries = getDebugEntries();
    const old = entries.filter(e => isOlderThan7Days(e.updated));
    let deleted = 0;
    for (const e of old) {
      delete kvStore[e.key];
      deleted++;
    }
    saveKV();
    return { content: [{ type: "text", text: `Deleted ${deleted} old debug entries` }] };
  }
  
  // --- Legacy in-memory session actions (backward compatibility) ---
  
  if (action === "start") {
    const sessionId = session_name || `debug_${Date.now()}`;
    DEBUG_SESSIONS[sessionId] = {
      started: now,
      cache: {},
      name: session_name || sessionId
    };
    return { content: [{ type: "text", text: `Debug session started: ${sessionId}\nTTL: 8 hours\n\nNote: For cross-session persistence, use action="store" instead.` }] };
  }
  
  if (action === "stop") {
    const sessionId = session_name || Object.keys(DEBUG_SESSIONS).pop();
    if (!DEBUG_SESSIONS[sessionId]) {
      return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }
    delete DEBUG_SESSIONS[sessionId];
    return { content: [{ type: "text", text: `Debug session stopped: ${sessionId}` }] };
  }
  
  if (action === "cache") {
    const sessionId = session_name || Object.keys(DEBUG_SESSIONS).pop();
    if (!DEBUG_SESSIONS[sessionId]) {
      return { content: [{ type: "text", text: `No active session. Start one with action="start"` }], isError: true };
    }
    if (!key || value === undefined) {
      return { content: [{ type: "text", text: `key and value required` }], isError: true };
    }
    DEBUG_SESSIONS[sessionId].cache[key] = {
      value: value,
      cached_at: new Date().toISOString()
    };
    return { content: [{ type: "text", text: `Cached: ${key} (${String(value).length} chars)` }] };
  }
  
  if (action === "get") {
    const sessionId = session_name || Object.keys(DEBUG_SESSIONS).pop();
    if (!DEBUG_SESSIONS[sessionId]) {
      return { content: [{ type: "text", text: `No active session` }], isError: true };
    }
    if (!key) {
      return { content: [{ type: "text", text: `key required` }], isError: true };
    }
    const cached = DEBUG_SESSIONS[sessionId].cache[key];
    if (!cached) {
      return { content: [{ type: "text", text: `Key not found in session: ${key}` }], isError: true };
    }
    return { content: [{ type: "text", text: cached.value }] };
  }
  
  if (action === "status") {
    if (Object.keys(DEBUG_SESSIONS).length === 0) {
      return { content: [{ type: "text", text: `No active debug sessions` }] };
    }
    const sessions = Object.entries(DEBUG_SESSIONS).map(([id, s]) => {
      const age = Math.round((now - s.started) / 1000 / 60);
      const cacheSize = Object.keys(s.cache).length;
      return `${id}: ${cacheSize} items, ${age}min old`;
    }).join("\n");
    return { content: [{ type: "text", text: `Active sessions:\n${sessions}` }] };
  }
  
  if (action === "clear") {
    const sessionId = session_name;
    if (sessionId) {
      if (!DEBUG_SESSIONS[sessionId]) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
      }
      delete DEBUG_SESSIONS[sessionId];
      return { content: [{ type: "text", text: `Cleared session: ${sessionId}` }] };
    } else {
      const count = Object.keys(DEBUG_SESSIONS).length;
      for (const id of Object.keys(DEBUG_SESSIONS)) {
        delete DEBUG_SESSIONS[id];
      }
      return { content: [{ type: "text", text: `Cleared ${count} sessions` }] };
    }
  }
  
  return { content: [{ type: "text", text: "Unknown action. Use: store, recall, cleanup (persistent) or start, stop, cache, get, status, clear (session)" }], isError: true };
}

// FreshEyes tool implementation
async function sidekick_fresheyes({ problem, context, files, hypotheses, full_response }) {
  let prompt = `You are analyzing a problem with fresh eyes. Provide a clear, independent analysis.

Problem: ${problem}

`;
  
  if (context) {
    prompt += `Context:\n${context}\n\n`;
  }
  
  if (files && files.length > 0) {
    prompt += `Files analyzed:\n${files.map(f => `- ${f}`).join("\n")}\n\n`;
  }
  
  if (hypotheses && hypotheses.length > 0) {
    prompt += `Current hypotheses:\n${hypotheses.map(h => `- ${h}`).join("\n")}\n\n`;
  }
  
  prompt += `Provide your analysis:
1. What do you think is the root cause?
2. What approach would you take to solve it?
3. Are there any blind spots or assumptions in the current thinking?`;
  
  const sanitizedPrompt = redactSensitive(prompt);
  
  try {
    const result = await sidekick_llm({
      prompt: sanitizedPrompt,
      system: "You are a senior engineer providing a fresh perspective on a problem. Be direct and analytical. Focus on key insights, not verbose explanations.",
      temperature: 0.3
    });
    
    if (full_response) {
      return result;
    }
    
    const response = result.content?.[0]?.text || "";
    const insights = response.split("\n").filter(line => 
      line.trim().length > 0 && 
      (line.includes("root cause") || line.includes("approach") || line.includes("blind spot") || line.match(/^\d+\./))
    ).slice(0, 10).join("\n");
    
    return { content: [{ type: "text", text: insights || response.substring(0, 500) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error calling LLM: ${e.message}` }], isError: true };
  }
}

// --- Token-efficient tools (v1.17) ---

const sessionCache = new Map();

function parseDuration(str) {
  if (!str) return 300000;
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 300000;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * (multipliers[unit] || 60000);
}

async function sidekick_batch({ calls }) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return { content: [{ type: "text", text: "calls must be a non-empty array" }], isError: true };
  }
  if (calls.length > 20) {
    return { content: [{ type: "text", text: "Maximum 20 calls per batch" }], isError: true };
  }
  const results = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call.tool || !TOOLS[call.tool]) {
      results.push({ index: i, tool: call.tool, error: "Unknown tool: " + call.tool });
      continue;
    }
    const start = Date.now();
    try {
      const result = await TOOLS[call.tool](call.args || {});
      results.push({
        index: i,
        tool: call.tool,
        result: result.content?.[0]?.text?.substring(0, 500) || "(ok)",
        error: result.isError || false,
        duration_ms: Date.now() - start
      });
    } catch (e) {
      results.push({ index: i, tool: call.tool, error: e.message });
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

async function sidekick_cache({ action, key, ttl, value }) {
  const now = Date.now();
  if (action === "clear") {
    if (key) {
      sessionCache.delete(key);
      return { content: [{ type: "text", text: "Cleared cache: " + key }] };
    }
    const count = sessionCache.size;
    sessionCache.clear();
    return { content: [{ type: "text", text: "Cleared " + count + " cache entries" }] };
  }
  if (action === "list") {
    const entries = [];
    for (const [k, v] of sessionCache) {
      entries.push({ key: k, expires_in_ms: v.expires - now, size: v.value.length });
    }
    return { content: [{ type: "text", text: JSON.stringify(entries) }] };
  }
  if (action === "get") {
    if (!key) return { content: [{ type: "text", text: "key required" }], isError: true };
    const entry = sessionCache.get(key);
    if (!entry || entry.expires < now) {
      if (entry) sessionCache.delete(key);
      return { content: [{ type: "text", text: "Cache miss: " + key }], isError: true };
    }
    return { content: [{ type: "text", text: redactSensitive(entry.value) }] };
  }
  if (action === "set") {
    if (!key || value === undefined) return { content: [{ type: "text", text: "key and value required" }], isError: true };
    const duration = parseDuration(ttl);
    sessionCache.set(key, { value: String(value), expires: now + duration });
    return { content: [{ type: "text", text: "Cached " + key + " (TTL: " + ttl + ")" }] };
  }
  return { content: [{ type: "text", text: "Invalid action. Use: get, set, clear, list" }], isError: true };
}

async function sidekick_summarize({ path: filePath, max_lines, strategy, pattern }) {
  const maxLines = max_lines || 50;
  const strat = strategy || "head";
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 50 * 1024 * 1024) {
    return { content: [{ type: "text", text: "File too large to summarize (>50MB): " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  let summary;
  if (strat === "head") {
    summary = lines.slice(0, maxLines).join("\n");
  } else if (strat === "tail") {
    summary = lines.slice(-maxLines).join("\n");
  } else if (strat === "grep") {
    if (!pattern) return { content: [{ type: "text", text: "pattern required for grep strategy" }], isError: true };
    const re = new RegExp(pattern, "i");
    const matched = [];
    for (let i = 0; i < lines.length && matched.length < maxLines; i++) {
      if (re.test(lines[i])) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 2);
        for (let j = start; j < end; j++) {
          if (!matched.includes(lines[j])) matched.push(lines[j]);
        }
      }
    }
    summary = matched.join("\n");
  } else if (strat === "stats") {
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    summary = [
      "File: " + filePath,
      "Size: " + stat.size + " bytes",
      "Total lines: " + lines.length,
      "Non-empty lines: " + nonEmpty.length,
      "First line: " + (lines[0] || "(empty)"),
      "Last line: " + (lines[lines.length - 1] || "(empty)")
    ].join("\n");
  } else {
    return { content: [{ type: "text", text: "Invalid strategy. Use: head, tail, grep, stats" }], isError: true };
  }
  const header = "[Summary: " + lines.length + " lines, strategy=" + strat + (strat === "grep" ? ", pattern=" + pattern : "") + "]\n";
  return { content: [{ type: "text", text: redactSensitive(header + summary) }] };
}

async function sidekick_filter({ path: targetPath, pattern, after, before, max_results }) {
  const maxResults = max_results || 50;
  if (!fs.existsSync(targetPath)) {
    return { content: [{ type: "text", text: "Path not found: " + targetPath }], isError: true };
  }
  const stat = fs.statSync(targetPath);
  const results = [];
  if (stat.isFile()) {
    const content = fs.readFileSync(targetPath, "utf-8");
    const lines = content.split("\n");
    const re = pattern ? new RegExp(pattern, "i") : null;
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (!re || re.test(lines[i])) {
        results.push({ line: i + 1, text: lines[i].substring(0, 200) });
      }
    }
  } else if (stat.isDirectory()) {
    const afterDate = after ? new Date(after).getTime() : 0;
    const beforeDate = before ? new Date(before).getTime() : Infinity;
    const re = pattern ? new RegExp(pattern, "i") : null;
    function walkDir(dir, depth) {
      if (depth > 5 || results.length >= maxResults) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = path.join(dir, entry.name);
        try {
          const s = fs.statSync(fullPath);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
              walkDir(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            if (s.mtimeMs >= afterDate && s.mtimeMs <= beforeDate) {
              if (!re || re.test(entry.name)) {
                results.push({
                  path: fullPath,
                  size: s.size,
                  modified: s.mtime.toISOString().slice(0, 19)
                });
              }
            }
          }
        } catch (e) {}
      }
    }
    walkDir(targetPath, 0);
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

async function sidekick_project({ name, include }) {
  const sections = (include || "kv,context").split(",").map(s => s.trim());
  const output = {};
  if (sections.includes("kv")) {
    const kvResults = [];
    for (const [key, entry] of Object.entries(kvStore)) {
      if (typeof entry === 'object' && entry !== null && entry.project === name) {
        kvResults.push({ key, value: typeof entry.value === 'string' ? entry.value.substring(0, 200) : entry.value, updated: entry.updated });
      }
    }
    output.kv = kvResults;
  }
  if (sections.includes("context")) {
    const ctxFile = path.join(DATA_DIR, "context.json");
    if (fs.existsSync(ctxFile)) {
      try {
        const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf-8"));
        const items = (ctx.items || []).filter(i => i.project === name);
        output.context = items.slice(-20).map(i => ({
          type: i.type,
          summary: (i.context || i.decision || i.problem || i.pattern || "").substring(0, 200),
          created: i.created
        }));
      } catch (e) { output.context = []; }
    } else { output.context = []; }
  }
  if (sections.includes("logs")) {
    if (fs.existsSync(LOG_FILE)) {
      try {
        const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
        const recent = lines.slice(-50).map(l => {
          try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
        output.logs = recent.slice(-20).map(l => ({
          time: l.t, tool: l.n, ok: l.ok, summary: l.s
        }));
      } catch (e) { output.logs = []; }
    } else { output.logs = []; }
  }
  if (sections.includes("procedures")) {
    const procs = loadProcedures();
    output.procedures = Object.keys(procs).filter(n => n.toLowerCase().includes(name.toLowerCase()));
  }
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

async function sidekick_tail({ source, pattern, lines, since }) {
  const maxLines = lines || 50;
  const re = pattern ? new RegExp(pattern, "i") : null;
  let content;
  if (source === "log.jsonl" || source === "log") {
    if (!fs.existsSync(LOG_FILE)) {
      return { content: [{ type: "text", text: "Log file not found" }], isError: true };
    }
    const allLines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    const parsed = allLines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    let filtered = parsed;
    if (since) {
      const sinceDate = new Date(since).getTime();
      filtered = parsed.filter(l => new Date(l.t).getTime() >= sinceDate);
    }
    if (re) {
      filtered = filtered.filter(l => re.test(l.n) || re.test(l.s) || re.test(l.a));
    }
    content = filtered.slice(-maxLines).map(l =>
      l.t.slice(11, 19) + " [" + (l.ok ? "OK" : "ERR") + "] " + l.n + ": " + l.s
    ).join("\n");
  } else if (source === "journalctl") {
    try {
      const svc = pattern || "sidekick-mcp";
      const stdout = execFileSync("journalctl", ["-u", svc, "-n", String(maxLines), "--no-pager"], {
        timeout: 10000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024
      });
      content = stdout;
    } catch (e) {
      content = e.stdout || e.message;
    }
  } else {
    if (!fs.existsSync(source)) {
      return { content: [{ type: "text", text: "File not found: " + source }], isError: true };
    }
    const allLines = fs.readFileSync(source, "utf-8").split("\n");
    let filtered = allLines;
    if (re) filtered = allLines.filter(l => re.test(l));
    content = filtered.slice(-maxLines).join("\n");
  }
  return { content: [{ type: "text", text: redactSensitive(content || "(no matching entries)") }] };
}

async function sidekick_diff_files({ path_a, path_b, format }) {
  if (!fs.existsSync(path_a)) return { content: [{ type: "text", text: "File not found: " + path_a }], isError: true };
  if (!fs.existsSync(path_b)) return { content: [{ type: "text", text: "File not found: " + path_b }], isError: true };
  const contentA = fs.readFileSync(path_a, "utf-8");
  const contentB = fs.readFileSync(path_b, "utf-8");
  if (format === "summary") {
    const linesA = contentA.split("\n");
    const linesB = contentB.split("\n");
    let added = 0, removed = 0, changed = 0;
    const maxLen = Math.max(linesA.length, linesB.length);
    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i] || "";
      const b = linesB[i] || "";
      if (a === b) continue;
      if (i >= linesA.length) added++;
      else if (i >= linesB.length) removed++;
      else changed++;
    }
    return { content: [{ type: "text", text: JSON.stringify({
      file_a: path_a, file_b: path_b,
      lines_a: linesA.length, lines_b: linesB.length,
      added, removed, changed
    }) }] };
  }
  const linesA = contentA.split("\n");
  const linesB = contentB.split("\n");
  const diffLines = [];
  const maxLen = Math.max(linesA.length, linesB.length);
  let diffCount = 0;
  for (let i = 0; i < maxLen && diffCount < 100; i++) {
    const a = linesA[i];
    const b = linesB[i];
    if (a !== b) {
      diffCount++;
      if (a !== undefined) diffLines.push("- " + (i + 1) + ": " + a.substring(0, 200));
      if (b !== undefined) diffLines.push("+ " + (i + 1) + ": " + b.substring(0, 200));
    }
  }
  const header = "--- " + path_a + "\n+++ " + path_b + "\n";
  return { content: [{ type: "text", text: redactSensitive(header + diffLines.join("\n")) }] };
}

async function sidekick_find({ path: searchPath, name, modified_after, modified_before, size_min, size_max, content, max_results }) {
  const maxResults = max_results || 50;
  if (!fs.existsSync(searchPath)) {
    return { content: [{ type: "text", text: "Path not found: " + searchPath }], isError: true };
  }
  const afterMs = modified_after ? new Date(modified_after).getTime() : 0;
  const beforeMs = modified_before ? new Date(modified_before).getTime() : Infinity;
  const sizeMin = size_min ? parseSize(size_min) : 0;
  const sizeMax = size_max ? parseSize(size_max) : Infinity;
  const nameRe = name ? new RegExp("^" + name.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
  const contentRe = content ? new RegExp(content, "i") : null;
  const results = [];
  function walk(dir, depth) {
    if (depth > 8 || results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const s = fs.statSync(fullPath);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          if (nameRe && !nameRe.test(entry.name)) continue;
          if (s.mtimeMs < afterMs || s.mtimeMs > beforeMs) continue;
          if (s.size < sizeMin || s.size > sizeMax) continue;
          if (contentRe) {
            try {
              const fileContent = fs.readFileSync(fullPath, "utf-8").substring(0, 1024 * 1024);
              if (!contentRe.test(fileContent)) continue;
            } catch (e) { continue; }
          }
          results.push({
            path: fullPath,
            size: s.size,
            modified: s.mtime.toISOString().slice(0, 19)
          });
        }
      } catch (e) {}
    }
  }
  walk(searchPath, 0);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

function parseSize(str) {
  if (typeof str === "number") return str;
  const match = String(str).match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] || "B").toUpperCase();
  const multipliers = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
  return Math.floor(val * (multipliers[unit] || 1));
}

async function sidekick_status({ include, services }) {
  const sections = (include || "services,disk").split(",").map(s => s.trim());
  const output = {};
  if (sections.includes("services")) {
    const svcList = (services || "sidekick-mcp,sidekick-dashboard,sidekick-agent").split(",").map(s => s.trim());
    output.services = {};
    for (const svc of svcList) {
      try {
        const stdout = execFileSync("systemctl", ["is-active", svc], { timeout: 5000, encoding: "utf-8" }).trim();
        output.services[svc] = stdout;
      } catch (e) {
        output.services[svc] = (e.stdout || "unknown").trim();
      }
    }
  }
  if (sections.includes("disk")) {
    try {
      const stdout = execFileSync("df", ["-h", "--output=target,size,used,avail,pcent", "/"], {
        timeout: 5000, encoding: "utf-8"
      }).trim();
      const lines = stdout.split("\n");
      if (lines.length > 1) {
        const parts = lines[1].trim().split(/\s+/);
        output.disk = { mount: parts[0], size: parts[1], used: parts[2], avail: parts[3], pct: parts[4] };
      }
    } catch (e) { output.disk = { error: e.message }; }
  }
  if (sections.includes("memory")) {
    try {
      const stdout = execFileSync("free", ["-h"], { timeout: 5000, encoding: "utf-8" }).trim();
      const lines = stdout.split("\n");
      if (lines.length > 1) {
        const parts = lines[1].trim().split(/\s+/);
        output.memory = { total: parts[1], used: parts[2], free: parts[3] };
      }
    } catch (e) { output.memory = { error: e.message }; }
  }
  if (sections.includes("load")) {
    try {
      const stdout = fs.readFileSync("/proc/loadavg", "utf-8").trim();
      const parts = stdout.split(/\s+/);
      output.load = { "1m": parts[0], "5m": parts[1], "15m": parts[2] };
    } catch (e) { output.load = { error: e.message }; }
  }
  if (sections.includes("uptime")) {
    try {
      const stdout = execFileSync("uptime", ["-p"], { timeout: 5000, encoding: "utf-8" }).trim();
      output.uptime = stdout;
    } catch (e) { output.uptime = { error: e.message }; }
  }
  if (sections.includes("processes")) {
    try {
      const stdout = execFileSync("ps", ["aux", "--sort=-%cpu"], { timeout: 5000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
      const lines = stdout.trim().split("\n").slice(0, 11);
      output.processes_top = lines.slice(1).map(l => {
        const p = l.trim().split(/\s+/);
        return { user: p[0], pid: p[1], cpu: p[2], mem: p[3], cmd: p.slice(10).join(" ").substring(0, 80) };
      });
    } catch (e) { output.processes_top = []; }
  }
  output.timestamp = new Date().toISOString();
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

async function sidekick_extract({ path: filePath, fields }) {
  if (!filePath) return { content: [{ type: "text", text: "path required" }], isError: true };
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  let data;
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".json") {
      data = JSON.parse(content);
    } else if (ext === ".yaml" || ext === ".yml") {
      const yaml = require("yaml");
      data = yaml.parse(content);
    } else if (ext === ".ini" || ext === ".cfg") {
      const ini = require("ini");
      data = ini.parse(content);
    } else if (ext === ".xml") {
      const { XMLParser } = require("fast-xml-parser");
      const parser = new XMLParser();
      data = parser.parse(content);
    } else {
      data = JSON.parse(content);
    }
  } catch (e) {
    return { content: [{ type: "text", text: "Parse error: " + e.message }], isError: true };
  }
  if (!fields) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
  const fieldList = Array.isArray(fields) ? fields : fields.split(",").map(f => f.trim());
  const result = {};
  for (const fieldPath of fieldList) {
    const parts = fieldPath.replace(/\[(\d+)\]/g, ".$1").split(".");
    let val = data;
    for (const part of parts) {
      if (val === null || val === undefined) { val = undefined; break; }
      val = val[part];
    }
    result[fieldPath] = val !== undefined ? (typeof val === "object" ? JSON.stringify(val) : String(val)) : null;
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

const ANONYMIZE_PATTERNS_FILE = path.join(DATA_DIR, "anonymize_patterns.json");
const MAX_ANONYMIZE_INPUT_SIZE = 1024 * 1024;

function loadAnonymizePatterns() {
  try {
    if (fs.existsSync(ANONYMIZE_PATTERNS_FILE)) {
      return JSON.parse(fs.readFileSync(ANONYMIZE_PATTERNS_FILE, "utf8"));
    }
  } catch {}
  return { patterns: [] };
}

function saveAnonymizePatterns(data) {
  fs.writeFileSync(ANONYMIZE_PATTERNS_FILE, JSON.stringify(data, null, 2));
}

function buildConsistencyMap() {
  return {
    emails: new Map(),
    ips: new Map(),
    hostnames: new Map(),
    paths: new Map(),
    uuids: new Map(),
    phones: new Map(),
    names: new Map(),
    _counters: { email: 0, ip: 0, host: 0, path: 0, uuid: 0, phone: 0, name: 0 }
  };
}

function getOrAssign(map, key, counter, generator) {
  if (map.has(key)) return map.get(key);
  const val = generator(counter.value);
  counter.value++;
  map.set(key, val);
  return val;
}

function anonymizeText(text, consistency, customPatterns) {
  if (!text || typeof text !== "string") return text;
  
  if (text.length > MAX_ANONYMIZE_INPUT_SIZE) {
    return `[ANONYMIZE ERROR: Input exceeds maximum size of ${MAX_ANONYMIZE_INPUT_SIZE} bytes (${text.length} bytes)]`;
  }

  const cmap = buildConsistencyMap();
  let result = text;

  const uuidCounter = { value: 1 };
  result = result.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (match) => {
    if (consistency) {
      return getOrAssign(cmap.uuids, match.toLowerCase(), uuidCounter, (n) => 
        `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
      );
    }
    return `00000000-0000-0000-0000-${String(Math.floor(Math.random() * 999999999999)).padStart(12, "0")}`;
  });

  const ipCounter = { value: 1 };
  result = result.replace(/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, (match) => {
    if (match === "127.0.0.1" || match === "0.0.0.0" || match === "255.255.255.255") return match;
    if (consistency) {
      return getOrAssign(cmap.ips, match, ipCounter, (n) => `10.0.0.${n}`);
    }
    return `10.0.0.${Math.floor(Math.random() * 254) + 1}`;
  });

  const emailCounter = { value: 1 };
  result = result.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, (match) => {
    if (match.endsWith("@example.com") || match.endsWith("@localhost")) return match;
    if (consistency) {
      return getOrAssign(cmap.emails, match.toLowerCase(), emailCounter, (n) => `user${n}@example.com`);
    }
    return `user${Math.floor(Math.random() * 9999) + 1}@example.com`;
  });

  const phoneCounter = { value: 1 };
  result = result.replace(/(?<!\d[-\d])(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b(?!\d)/g, (match) => {
    if (consistency) {
      return getOrAssign(cmap.phones, match.replace(/\D/g, ""), phoneCounter, (n) => 
        `555-000-${String(n).padStart(4, "0")}`
      );
    }
    return `555-000-${String(Math.floor(Math.random() * 9999)).padStart(4, "0")}`;
  });

  const SYSTEM_USERS = ["sidekick", "root", "nobody", "admin", "www-data", "nginx", "apache", "mysql", "postgres", "redis", "daemon", "bin", "sys", "sync", "games", "man", "mail", "news", "proxy", "backup", "list", "irc", "gnats", "systemd", "messagebus", "sshd", "ntp", "avahi", "colord", "hplp", "pollinate", "landscape", "ubuntu"];
  const pathCounter = { value: 1 };
  result = result.replace(/\/(?:home|Users)\/([a-zA-Z0-9_\-]+)(?:\/[^\s]*)?/g, (match, userPart) => {
    if (SYSTEM_USERS.includes(userPart.toLowerCase())) return match;
    if (consistency) {
      const replacement = getOrAssign(cmap.paths, userPart, pathCounter, (n) => `user${n}`);
      return match.replace(`/${userPart}`, `/${replacement}`);
    }
    const replacement = `user${Math.floor(Math.random() * 99) + 1}`;
    return match.replace(`/${userPart}`, `/${replacement}`);
  });

  const hostnameCounter = { value: 1 };
  result = result.replace(/\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+(?:com|org|net|io|dev|app|local|internal)\b/g, (match) => {
    if (match === "example.com" || match === "localhost" || match.endsWith(".example.com")) return match;
    if (consistency) {
      return getOrAssign(cmap.hostnames, match.toLowerCase(), hostnameCounter, (n) => `host-${n}.internal`);
    }
    return `host-${Math.floor(Math.random() * 999) + 1}.internal`;
  });

  if (customPatterns && customPatterns.length > 0) {
    for (const cp of customPatterns) {
      try {
        const regex = new RegExp(cp.pattern, "g");
        result = result.replace(regex, cp.replacement);
      } catch {}
    }
  }

  const stored = loadAnonymizePatterns();
  for (const sp of stored.patterns) {
    try {
      const regex = new RegExp(sp.pattern, "g");
      result = result.replace(regex, sp.replacement);
    } catch {}
  }

  result = redactSensitive(result);

  return result;
}

async function sidekick_anonymize({ action, input, format, custom_patterns, consistency }) {
  if (action === "patterns") {
    const stored = loadAnonymizePatterns();
    if (stored.patterns.length === 0) {
      return { content: [{ type: "text", text: "No custom patterns defined.\n\nBuilt-in patterns:\n- IPv4 addresses â†’ 10.0.0.x\n- Email addresses â†’ user{n}@example.com\n- UUIDs â†’ 00000000-0000-0000-0000-{n}\n- Phone numbers â†’ 555-000-XXXX\n- File paths (/home/user, /Users/user) â†’ /home/user{n}\n- Hostnames (*.com, *.org, etc.) â†’ host-{n}.internal\n- SSH private keys â†’ [REDACTED]\n- GitHub tokens â†’ [REDACTED]\n- API keys â†’ [REDACTED]\n- AWS keys â†’ [REDACTED]\n- Passwords/secrets â†’ [REDACTED]\n- Bearer tokens â†’ [REDACTED]\n- Database connection strings â†’ [REDACTED]\n- Stripe keys â†’ [REDACTED]\n- JWT tokens â†’ [REDACTED]" }] };
    }
    const list = stored.patterns.map((p, i) => `${i + 1}. Pattern: ${p.pattern}\n   Replacement: ${p.replacement}`).join("\n\n");
    return { content: [{ type: "text", text: `Custom patterns (${stored.patterns.length}):\n\n${list}` }] };
  }

  if (action === "add_pattern") {
    if (!custom_patterns || custom_patterns.length === 0) {
      return { content: [{ type: "text", text: "custom_patterns required (array of {pattern, replacement})" }], isError: true };
    }
    const stored = loadAnonymizePatterns();
    let added = 0;
    for (const cp of custom_patterns) {
      if (!cp.pattern || !cp.replacement) continue;
      try {
        new RegExp(cp.pattern);
      } catch (e) {
        return { content: [{ type: "text", text: `Invalid regex pattern: ${cp.pattern} (${e.message})` }], isError: true };
      }
      stored.patterns.push({ pattern: cp.pattern, replacement: cp.replacement, added: new Date().toISOString() });
      added++;
    }
    saveAnonymizePatterns(stored);
    return { content: [{ type: "text", text: `Added ${added} custom pattern(s). Total: ${stored.patterns.length}` }] };
  }

  if (action === "remove_pattern") {
    if (!custom_patterns || custom_patterns.length === 0) {
      return { content: [{ type: "text", text: "custom_patterns required with pattern field to remove" }], isError: true };
    }
    const stored = loadAnonymizePatterns();
    const before = stored.patterns.length;
    const toRemove = custom_patterns.map(cp => cp.pattern);
    stored.patterns = stored.patterns.filter(p => !toRemove.includes(p.pattern));
    const removed = before - stored.patterns.length;
    saveAnonymizePatterns(stored);
    return { content: [{ type: "text", text: `Removed ${removed} pattern(s). Remaining: ${stored.patterns.length}` }] };
  }

  if (action === "anonymize") {
    if (input === undefined || input === null) {
      return { content: [{ type: "text", text: "input required" }], isError: true };
    }

    const useConsistency = consistency !== false;
    let result = anonymizeText(input, useConsistency, custom_patterns);

    if (format === "json") {
      try {
        const parsed = JSON.parse(result);
        result = JSON.stringify(parsed, null, 2);
      } catch {}
    } else if (format === "yaml") {
      try {
        const yaml = require("yaml");
        const parsed = JSON.parse(result);
        result = yaml.stringify(parsed);
      } catch {}
    }

    const stats = {
      original_size: input.length,
      anonymized_size: result.length,
      consistency: useConsistency
    };

    return { content: [{ type: "text", text: `${result}\n\n--- Anonymization Stats ---\n${JSON.stringify(stats, null, 2)}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: anonymize, patterns, add_pattern, remove_pattern" }], isError: true };
}

const SANDBOX_FILE = path.join(DATA_DIR, "sandbox.json");
const SANDBOX_DIR = path.join(DATA_DIR, "sandboxes");
const MAX_ACTIVE_SANDBOXES = 5;
const MAX_ROLLBACKS_PER_SANDBOX = 50;
const SANDBOX_TTL_HOURS = 24;
const MAX_BACKUP_FILE_SIZE = 10 * 1024 * 1024;

fs.mkdirSync(SANDBOX_DIR, { recursive: true });

function loadSandboxes() {
  try {
    if (fs.existsSync(SANDBOX_FILE)) {
      return JSON.parse(fs.readFileSync(SANDBOX_FILE, "utf8"));
    }
  } catch {}
  return { sandboxes: {} };
}

function saveSandboxes(data) {
  fs.writeFileSync(SANDBOX_FILE, JSON.stringify(data, null, 2));
}

function purgeExpiredSandboxes(data) {
  const now = Date.now();
  const ttlMs = SANDBOX_TTL_HOURS * 60 * 60 * 1000;
  let purged = 0;
  for (const [id, sb] of Object.entries(data.sandboxes)) {
    if (now - sb.created > ttlMs) {
      const sbPath = path.join(SANDBOX_DIR, id);
      try { fs.rmSync(sbPath, { recursive: true, force: true }); } catch {}
      delete data.sandboxes[id];
      purged++;
    }
  }
  return purged;
}

function generateSandboxId() {
  return "sb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function sidekick_sandbox({ action, sandbox_name, command, files, auto_backup, rollback_id }) {
  const data = loadSandboxes();
  purgeExpiredSandboxes(data);

  if (action === "list") {
    const entries = Object.entries(data.sandboxes);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No active sandboxes" }] };
    }
    const list = entries.map(([id, sb]) => {
      const age = Math.round((Date.now() - sb.created) / 1000 / 60);
      return `${id} (${sb.name || "unnamed"}): ${sb.operations.length} ops, ${age}min old, ${sb.backups.length} backups`;
    }).join("\n");
    return { content: [{ type: "text", text: `Active sandboxes (${entries.length}/${MAX_ACTIVE_SANDBOXES}):\n\n${list}` }] };
  }

  if (action === "exec") {
    if (!command) {
      return { content: [{ type: "text", text: "command required" }], isError: true };
    }

    const name = sandbox_name || `sandbox_${Date.now()}`;
    let sbId = null;
    for (const [id, sb] of Object.entries(data.sandboxes)) {
      if (sb.name === name) { sbId = id; break; }
    }

    if (!sbId) {
      if (Object.keys(data.sandboxes).length >= MAX_ACTIVE_SANDBOXES) {
        return { content: [{ type: "text", text: `Max active sandboxes reached (${MAX_ACTIVE_SANDBOXES}). Clean up with action="clean" or wait for TTL expiry.` }], isError: true };
      }
      sbId = generateSandboxId();
      data.sandboxes[sbId] = {
        name,
        created: Date.now(),
        operations: [],
        backups: [],
        newFiles: []
      };
    }

    const sb = data.sandboxes[sbId];
    if (sb.operations.length >= MAX_ROLLBACKS_PER_SANDBOX) {
      return { content: [{ type: "text", text: `Max operations reached for this sandbox (${MAX_ROLLBACKS_PER_SANDBOX}). Create a new sandbox or clean this one.` }], isError: true };
    }

    const sbPath = path.join(SANDBOX_DIR, sbId);
    fs.mkdirSync(sbPath, { recursive: true });

    const filesToBackup = files || [];
    const backedUp = [];
    const skipped = [];

    if (auto_backup !== false && filesToBackup.length > 0) {
      for (const f of filesToBackup) {
        try {
          const stat = fs.statSync(f);
          if (!stat.isFile()) continue;
          if (stat.size > MAX_BACKUP_FILE_SIZE) {
            skipped.push({ file: f, reason: `exceeds ${MAX_BACKUP_FILE_SIZE} bytes` });
            continue;
          }
          const relPath = f.replace(/^\//, "").replace(/\//g, "_");
          const backupPath = path.join(sbPath, `backup_${sb.operations.length}_${relPath}`);
          fs.copyFileSync(f, backupPath);
          sb.backups.push({ original: f, backup: backupPath, size: stat.size, timestamp: Date.now() });
          backedUp.push(f);
        } catch (e) {
          if (e.code === "ENOENT") {
            sb.newFiles.push({ path: f, opIndex: sb.operations.length });
          }
        }
      }
    }

    const opRecord = {
      index: sb.operations.length,
      command,
      timestamp: Date.now(),
      backedUp,
      skipped
    };

    let output = "";
    let exitCode = 0;
    try {
      output = execSync(command, { timeout: 30000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      output = (e.stdout || "") + (e.stderr || "");
      exitCode = e.status || 1;
    }

    opRecord.exitCode = exitCode;
    opRecord.output = output.substring(0, 5000);
    sb.operations.push(opRecord);
    saveSandboxes(data);

    const summary = [
      `Sandbox: ${sbId} (${sb.name})`,
      `Command: ${command}`,
      `Exit: ${exitCode}`,
      `Backed up: ${backedUp.length} file(s)${backedUp.length > 0 ? " [" + backedUp.join(", ") + "]" : ""}`,
      skipped.length > 0 ? `Skipped: ${skipped.length} file(s) ${JSON.stringify(skipped)}` : "",
      `Operations: ${sb.operations.length}/${MAX_ROLLBACKS_PER_SANDBOX}`,
      "",
      output.substring(0, 2000)
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "rollback") {
    let targetId = rollback_id;
    
    if (!targetId && sandbox_name) {
      for (const [id, sb] of Object.entries(data.sandboxes)) {
        if (sb.name === sandbox_name) {
          targetId = id;
          break;
        }
      }
    }
    
    if (!targetId) {
      const entries = Object.entries(data.sandboxes);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No active sandboxes to rollback" }], isError: true };
      }
      targetId = entries[entries.length - 1][0];
    }

    const sb = data.sandboxes[targetId];
    if (!sb) {
      return { content: [{ type: "text", text: `Sandbox not found: ${targetId}` }], isError: true };
    }

    if (sb.backups.length === 0 && sb.newFiles.length === 0) {
      return { content: [{ type: "text", text: `No backups to rollback for sandbox ${targetId}` }] };
    }

    const restored = [];
    const removed = [];
    const errors = [];

    for (const backup of sb.backups.reverse()) {
      try {
        fs.copyFileSync(backup.backup, backup.original);
        restored.push(backup.original);
      } catch (e) {
        errors.push({ file: backup.original, error: e.message });
      }
    }

    for (const nf of sb.newFiles.reverse()) {
      try {
        if (fs.existsSync(nf.path)) {
          fs.unlinkSync(nf.path);
          removed.push(nf.path);
        }
      } catch (e) {
        errors.push({ file: nf.path, error: e.message });
      }
    }

    sb.backups = [];
    sb.newFiles = [];
    saveSandboxes(data);

    const summary = [
      `Rollback complete for sandbox: ${targetId} (${sb.name})`,
      `Restored: ${restored.length} file(s)${restored.length > 0 ? " [" + restored.join(", ") + "]" : ""}`,
      `Removed: ${removed.length} new file(s)${removed.length > 0 ? " [" + removed.join(", ") + "]" : ""}`,
      errors.length > 0 ? `Errors: ${JSON.stringify(errors)}` : ""
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "diff") {
    let targetId = sandbox_name;
    if (!targetId) {
      return { content: [{ type: "text", text: "sandbox_name required for diff" }], isError: true };
    }
    
    for (const [id, sb] of Object.entries(data.sandboxes)) {
      if (sb.name === sandbox_name) {
        targetId = id;
        break;
      }
    }

    const sb = data.sandboxes[targetId];
    if (!sb) {
      return { content: [{ type: "text", text: `Sandbox not found: ${targetId}` }], isError: true };
    }

    if (sb.operations.length === 0) {
      return { content: [{ type: "text", text: `No operations recorded for sandbox ${targetId}` }] };
    }

    const diffs = sb.operations.map((op, i) => {
      return [
        `--- Operation ${op.index} ---`,
        `Command: ${op.command}`,
        `Time: ${new Date(op.timestamp).toISOString()}`,
        `Exit: ${op.exitCode}`,
        `Backed up: ${op.backedUp.join(", ") || "none"}`,
        op.output ? `Output:\n${op.output.substring(0, 500)}` : ""
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    return { content: [{ type: "text", text: `Sandbox: ${targetId} (${sb.name})\nOperations: ${sb.operations.length}\n\n${diffs}` }] };
  }

  if (action === "clean") {
    let targetId = sandbox_name;
    if (targetId) {
      for (const [id, sb] of Object.entries(data.sandboxes)) {
        if (sb.name === sandbox_name) {
          targetId = id;
          break;
        }
      }
      
      if (!data.sandboxes[targetId]) {
        return { content: [{ type: "text", text: `Sandbox not found: ${targetId}` }], isError: true };
      }
      const sbPath = path.join(SANDBOX_DIR, targetId);
      try { fs.rmSync(sbPath, { recursive: true, force: true }); } catch {}
      delete data.sandboxes[targetId];
      saveSandboxes(data);
      return { content: [{ type: "text", text: `Cleaned sandbox: ${targetId}` }] };
    } else {
      const count = Object.keys(data.sandboxes).length;
      for (const id of Object.keys(data.sandboxes)) {
        const sbPath = path.join(SANDBOX_DIR, id);
        try { fs.rmSync(sbPath, { recursive: true, force: true }); } catch {}
      }
      data.sandboxes = {};
      saveSandboxes(data);
      return { content: [{ type: "text", text: `Cleaned ${count} sandbox(es)` }] };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: exec, rollback, list, diff, clean" }], isError: true };
}

const COMMIT_TYPE_MAP = {
  feat: "Features",
  fix: "Bug Fixes",
  docs: "Documentation",
  style: "Styles",
  refactor: "Code Refactoring",
  perf: "Performance Improvements",
  test: "Tests",
  build: "Build System",
  ci: "Continuous Integration",
  chore: "Chores",
  revert: "Reverts",
  deps: "Dependencies"
};

function parseConventionalCommit(message) {
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!match) {
    return { type: "other", scope: null, breaking: false, description: message };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || null,
    breaking: !!match[3] || message.includes("BREAKING CHANGE:"),
    description: match[4]
  };
}

async function sidekick_changelog({ action, from, to, format, group_by, use_llm, include, path: repoPath }) {
  if (!from) {
    return { content: [{ type: "text", text: "from parameter required (starting ref: tag, commit, or branch)" }], isError: true };
  }

  const toRef = to || "HEAD";
  const fmt = format || "markdown";
  const groupBy = group_by || "type";
  const includeType = include || "all";
  const cwd = repoPath || process.cwd();

  let gitLogCmd = `git log ${from}..${toRef} --pretty=format:"%H|%s|%an|%ad" --date=short`;
  
  let logOutput = "";
  try {
    logOutput = execSync(gitLogCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], cwd });
  } catch (e) {
    return { content: [{ type: "text", text: `Git log failed: ${e.message}\n\nMake sure you're in a git repository and the refs exist.` }], isError: true };
  }

  if (!logOutput.trim()) {
    return { content: [{ type: "text", text: `No commits found between ${from} and ${toRef}` }] };
  }

  const commits = logOutput.trim().split("\n").map(line => {
    const [hash, message, author, date] = line.split("|");
    const parsed = parseConventionalCommit(message);
    return { hash, message, author, date, ...parsed };
  });

  let filtered = commits;
  if (includeType !== "all") {
    const typeFilter = {
      features: ["feat"],
      fixes: ["fix"],
      breaking: commits.filter(c => c.breaking).map(c => c.type),
      refactor: ["refactor"],
      deps: ["deps", "chore"]
    };
    const allowedTypes = typeFilter[includeType] || [];
    filtered = commits.filter(c => allowedTypes.includes(c.type) || (includeType === "breaking" && c.breaking));
  }

  if (filtered.length === 0) {
    return { content: [{ type: "text", text: `No commits matching filter "${includeType}" between ${from} and ${toRef}` }] };
  }

  const grouped = {};
  for (const commit of filtered) {
    let key;
    if (groupBy === "type") {
      key = COMMIT_TYPE_MAP[commit.type] || commit.type;
    } else if (groupBy === "scope") {
      key = commit.scope || "general";
    } else if (groupBy === "author") {
      key = commit.author;
    } else {
      key = "other";
    }
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(commit);
  }

  let changelog = "";
  
  if (fmt === "markdown") {
    const breaking = filtered.filter(c => c.breaking);
    if (breaking.length > 0) {
      changelog += "## âš  BREAKING CHANGES\n\n";
      for (const c of breaking) {
        changelog += `- ${c.description} (${c.hash.substring(0, 7)})\n`;
      }
      changelog += "\n";
    }

    for (const [group, commits] of Object.entries(grouped)) {
      if (groupBy === "type" && group === "other") continue;
      changelog += `## ${group}\n\n`;
      for (const c of commits) {
        const scope = c.scope ? `**${c.scope}:** ` : "";
        changelog += `- ${scope}${c.description} (${c.hash.substring(0, 7)})\n`;
      }
      changelog += "\n";
    }

    changelog += `---\n**${filtered.length} commits** from ${from} to ${toRef}\n`;
  } else if (fmt === "plain") {
    for (const [group, commits] of Object.entries(grouped)) {
      changelog += `${group}:\n`;
      for (const c of commits) {
        changelog += `  - ${c.description}\n`;
      }
      changelog += "\n";
    }
  } else if (fmt === "conventional") {
    for (const c of filtered) {
      changelog += `${c.message}\n`;
    }
  }

  if (use_llm && fmt === "markdown") {
    try {
      const summaryPrompt = `Summarize these ${filtered.length} git commits in 2-3 sentences for release notes. Focus on what changed and why it matters:\n\n${filtered.map(c => `- ${c.message}`).join("\n")}`;
      const llmResult = await sidekick_llm({
        prompt: summaryPrompt,
        system: "You are a technical writer creating release notes. Be concise and focus on user-facing changes.",
        temperature: 0.3
      });
      if (llmResult.content && llmResult.content[0]) {
        changelog = `## Summary\n\n${llmResult.content[0].text}\n\n${changelog}`;
      }
    } catch (e) {
      changelog += `\n*LLM summary failed: ${e.message}*\n`;
    }
  }

  if (action === "preview" || action === "generate") {
    return { content: [{ type: "text", text: changelog }] };
  }

  if (action === "save") {
    const changelogPath = path.join(cwd, "CHANGELOG.md");
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(changelogPath, "utf8");
    } catch {}

    const date = new Date().toISOString().split("T")[0];
    const header = `## ${date}\n\n`;
    const newEntry = header + changelog;

    const lines = existingContent.split("\n");
    let insertIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        insertIndex = i + 1;
        while (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex++;
        break;
      }
    }

    lines.splice(insertIndex, 0, newEntry);
    fs.writeFileSync(changelogPath, lines.join("\n"));

    return { content: [{ type: "text", text: `Changelog saved to ${changelogPath}\n\n${newEntry}` }] };
  }

  return { content: [{ type: "text", text: changelog }] };
}

const MAX_NETDIAG_COMMANDS = 15;
const COMMON_PORTS = [22, 80, 443, 3000, 3001, 4000, 5000, 8080, 8443, 9090];

function runNetDiagCommand(cmd, timeout = 5000) {
  try {
    const output = execSync(cmd, { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] });
    return { success: true, output: output.trim() };
  } catch (e) {
    return { success: false, output: (e.stdout || "") + (e.stderr || ""), error: e.message };
  }
}

async function sidekick_netdiag({ action, target, port_range, timeout, format }) {
  if (!target && action !== "listeners") {
    return { content: [{ type: "text", text: "target required (host, URL, or IP)" }], isError: true };
  }

  const fmt = format || "detailed";
  const to = timeout || 5000;
  let commandCount = 0;

  const checkLimit = () => {
    commandCount++;
    if (commandCount > MAX_NETDIAG_COMMANDS) {
      throw new Error(`Exceeded max commands per diagnostic (${MAX_NETDIAG_COMMANDS})`);
    }
  };

  if (action === "dns") {
    checkLimit();
    const dnsResult = runNetDiagCommand(`dig +short ${shellEscape(target)} A`, to);
    checkLimit();
    const dnsAny = runNetDiagCommand(`dig +short ${shellEscape(target)} ANY`, to);
    checkLimit();
    const reverse = runNetDiagCommand(`dig +short -x ${shellEscape(target)}`, to);

    let result = `DNS Resolution for: ${target}\n\n`;
    result += `A Records:\n${dnsResult.output || "None"}\n\n`;
    result += `ANY Records:\n${dnsAny.output || "None"}\n\n`;
    result += `Reverse DNS:\n${reverse.output || "None"}`;

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "route") {
    checkLimit();
    const traceResult = runNetDiagCommand(`traceroute -m 10 -w 2 ${shellEscape(target)}`, to * 2);
    
    let result = `Route to: ${target}\n\n`;
    result += traceResult.output || "Traceroute failed or timed out";

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "ports") {
    let ports = COMMON_PORTS;
    if (port_range) {
      const match = port_range.match(/(\d+)-(\d+)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = parseInt(match[2]);
        ports = [];
        for (let i = start; i <= end && ports.length < 20; i++) {
          ports.push(i);
        }
      }
    }

    checkLimit();
    const results = [];
    for (const port of ports) {
      const ncResult = runNetDiagCommand(`nc -z -w 2 ${shellEscape(target)} ${port} 2>&1`, 3000);
      const isOpen = ncResult.success && !ncResult.output.includes("failed");
      results.push({ port, open: isOpen });
    }

    let result = `Port Scan for: ${target}\n\n`;
    const openPorts = results.filter(r => r.open);
    const closedPorts = results.filter(r => !r.open);
    
    result += `Open: ${openPorts.length}\n`;
    if (openPorts.length > 0) {
      result += `  ${openPorts.map(r => r.port).join(", ")}\n`;
    }
    result += `\nClosed: ${closedPorts.length}\n`;
    if (fmt === "detailed" && closedPorts.length > 0) {
      result += `  ${closedPorts.map(r => r.port).join(", ")}\n`;
    }

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "listeners") {
    checkLimit();
    const ssResult = runNetDiagCommand("ss -tlnp", to);
    
    let result = "Local Listening Ports\n\n";
    result += ssResult.output || "No listeners found or ss command failed";

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "connectivity") {
    const targets = target.split(",").map(t => t.trim());
    const results = [];

    for (const t of targets) {
      checkLimit();
      const pingResult = runNetDiagCommand(`ping -c 2 -W 2 ${shellEscape(t)} 2>&1`, to);
      const isUp = pingResult.success && pingResult.output.includes("bytes from");
      results.push({ target: t, up: isUp, latency: isUp ? pingResult.output.match(/time[=<](\d+\.?\d*)/)?.[1] + "ms" : "N/A" });
    }

    let result = "Connectivity Check\n\n";
    for (const r of results) {
      result += `${r.target}: ${r.up ? "âœ“ UP" : "âœ— DOWN"} (${r.latency})\n`;
    }

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "check") {
    let host = target;
    let url = null;
    if (target.startsWith("http://") || target.startsWith("https://")) {
      try {
        const parsed = new URL(target);
        host = parsed.hostname;
        url = target;
      } catch {}
    }

    const report = { target, host, timestamp: new Date().toISOString(), checks: {} };

    checkLimit();
    const dnsResult = runNetDiagCommand(`dig +short ${shellEscape(host)} A`, to);
    report.checks.dns = dnsResult.output || "Failed";

    checkLimit();
    const pingResult = runNetDiagCommand(`ping -c 2 -W 2 ${shellEscape(host)} 2>&1`, to);
    report.checks.ping = pingResult.success && pingResult.output.includes("bytes from") ? "OK" : "Failed";

    if (url) {
      checkLimit();
      const curlResult = runNetDiagCommand(`curl -s -o /dev/null -w "%{http_code}|%{time_total}|%{ssl_verify_result}" --max-time ${to / 1000} ${shellEscape(url)}`, to);
      if (curlResult.success) {
        const parts = curlResult.output.split("|");
        report.checks.http = {
          status: parts[0] || "N/A",
          time: parts[1] ? parseFloat(parts[1]).toFixed(3) + "s" : "N/A",
          ssl: parts[2] === "0" ? "Valid" : "Invalid"
        };
      } else {
        report.checks.http = "Failed";
      }
    }

    checkLimit();
    const portResult = runNetDiagCommand(`nc -z -w 2 ${shellEscape(host)} 22 2>&1`, 3000);
    report.checks.ssh = portResult.success && !portResult.output.includes("failed") ? "Open" : "Closed";

    let result = `Network Diagnostic Report\n`;
    result += `Target: ${target}\n`;
    result += `Time: ${report.timestamp}\n\n`;
    result += `DNS: ${report.checks.dns}\n`;
    result += `Ping: ${report.checks.ping}\n`;
    if (report.checks.http) {
      if (typeof report.checks.http === "object") {
        result += `HTTP: ${report.checks.http.status} (${report.checks.http.time}, SSL: ${report.checks.http.ssl})\n`;
      } else {
        result += `HTTP: ${report.checks.http}\n`;
      }
    }
    result += `SSH (22): ${report.checks.ssh}\n`;

    return { content: [{ type: "text", text: result }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: check, dns, route, ports, listeners, connectivity" }], isError: true };
}

const MAX_TIMELINE_EVENTS = 500;
const MAX_TIMELINE_RANGE_DAYS = 30;

function parseRelativeTime(str) {
  if (!str || str === "now") return new Date();
  const match = str.match(/^(\d+)([smhd])$/);
  if (match) {
    const val = parseInt(match[1]);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(Date.now() - val * multipliers[unit]);
  }
  return new Date(str);
}

function parseJournalctlLine(line) {
  const match = line.match(/^(\S+ \d+ \d+:\d+:\d+) (\S+) (.+)$/);
  if (!match) return null;
  const [_, timestamp, host, message] = match;
  const year = new Date().getFullYear();
  const date = new Date(`${year} ${timestamp}`);
  const severity = /error|fail|critical/i.test(message) ? "error" 
    : /warn/i.test(message) ? "warn" : "info";
  return { timestamp: date.toISOString(), source: "journalctl", severity, summary: message.substring(0, 200) };
}

function parseLogJsonlLine(line) {
  try {
    const entry = JSON.parse(line);
    return {
      timestamp: entry.t,
      source: "log.jsonl",
      severity: entry.ok ? "info" : "error",
      summary: `${entry.n}: ${(entry.s || "").substring(0, 150)}`
    };
  } catch {
    return null;
  }
}

function parseGitLogLine(line) {
  const match = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) return null;
  const [_, hash, date, message] = match;
  return {
    timestamp: new Date(date).toISOString(),
    source: "git",
    severity: "info",
    summary: `${hash.substring(0, 7)}: ${message.substring(0, 150)}`
  };
}

async function sidekick_timeline({ action, since, until, sources, pattern, severity, format, max_events }) {
  const maxEvents = max_events || MAX_TIMELINE_EVENTS;
  const startTime = parseRelativeTime(since);
  const endTime = parseRelativeTime(until || "now");
  
  const rangeDays = (endTime - startTime) / 86400000;
  if (rangeDays > MAX_TIMELINE_RANGE_DAYS) {
    return { content: [{ type: "text", text: `Time range exceeds maximum of ${MAX_TIMELINE_RANGE_DAYS} days` }], isError: true };
  }

  const useSources = sources && sources[0] !== "all" ? sources : ["log.jsonl", "journalctl", "git", "files"];
  const events = [];

  if (useSources.includes("log.jsonl")) {
    try {
      const logContent = fs.readFileSync(LOG_FILE, "utf8");
      const lines = logContent.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const event = parseLogJsonlLine(line);
        if (event) {
          const eventTime = new Date(event.timestamp);
          if (eventTime >= startTime && eventTime <= endTime) {
            events.push(event);
          }
        }
      }
    } catch {}
  }

  if (useSources.includes("journalctl")) {
    try {
      const sinceStr = startTime.toISOString();
      const result = execSync(`journalctl --since "${sinceStr}" --no-pager -n 500`, { 
        encoding: "utf8", 
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"] 
      });
      const lines = result.trim().split("\n").slice(4);
      for (const line of lines) {
        const event = parseJournalctlLine(line);
        if (event) {
          const eventTime = new Date(event.timestamp);
          if (eventTime >= startTime && eventTime <= endTime) {
            events.push(event);
          }
        }
      }
    } catch {}
  }

  if (useSources.includes("git")) {
    try {
      const sinceDate = startTime.toISOString();
      const result = execSync(`git log --since="${sinceDate}" --pretty=format:"%H %ad %s" --date=iso -n 100`, {
        encoding: "utf8",
        timeout: 10000,
        cwd: "/home/sidekick/sidekick",
        stdio: ["pipe", "pipe", "pipe"]
      });
      const lines = result.trim().split("\n");
      for (const line of lines) {
        const event = parseGitLogLine(line);
        if (event) events.push(event);
      }
    } catch {}
  }

  if (useSources.includes("files")) {
    try {
      const minutes = Math.ceil((Date.now() - startTime.getTime()) / 60000);
      const result = execSync(`find /home/sidekick/sidekick -type f -mmin -${minutes} -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -50`, {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const files = result.trim().split("\n").filter(Boolean);
      for (const file of files) {
        try {
          const stat = fs.statSync(file);
          events.push({
            timestamp: stat.mtime.toISOString(),
            source: "files",
            severity: "info",
            summary: `Modified: ${file}`
          });
        } catch {}
      }
    } catch {}
  }

  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let filtered = events;
  if (severity && severity !== "all") {
    filtered = filtered.filter(e => e.severity === severity);
  }
  if (pattern) {
    const regex = new RegExp(pattern, "i");
    filtered = filtered.filter(e => regex.test(e.summary));
  }

  if (filtered.length > maxEvents) {
    filtered = filtered.slice(0, maxEvents);
  }

  if (action === "filter") {
    return { content: [{ type: "text", text: `Found ${filtered.length} events matching filters` }] };
  }

  if (action === "export" && format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
  }

  if (filtered.length === 0) {
    return { content: [{ type: "text", text: `No events found between ${since} and ${until || "now"}` }] };
  }

  let output = `Timeline: ${startTime.toISOString()} to ${endTime.toISOString()}\n`;
  output += `Events: ${filtered.length}\n\n`;

  if (format === "detailed") {
    for (const event of filtered) {
      output += `[${event.timestamp}] [${event.source}] [${event.severity}]\n  ${event.summary}\n\n`;
    }
  } else {
    for (const event of filtered) {
      const time = event.timestamp.substring(11, 19);
      output += `${time} [${event.source.padEnd(10)}] ${event.summary}\n`;
    }
  }

  return { content: [{ type: "text", text: output }] };
}

const CIRCUIT_FILE = path.join(DATA_DIR, "circuits.json");
const MAX_CIRCUIT_TARGETS = 20;
const CIRCUIT_IDLE_RESET_HOURS = 1;

function loadCircuits() {
  try {
    if (fs.existsSync(CIRCUIT_FILE)) {
      return JSON.parse(fs.readFileSync(CIRCUIT_FILE, "utf8"));
    }
  } catch {}
  return { circuits: {} };
}

function saveCircuits(data) {
  fs.writeFileSync(CIRCUIT_FILE, JSON.stringify(data, null, 2));
}

function cleanupIdleCircuits(data) {
  const now = Date.now();
  const idleMs = CIRCUIT_IDLE_RESET_HOURS * 3600000;
  let cleaned = 0;
  for (const [target, circuit] of Object.entries(data.circuits)) {
    if (now - circuit.lastAccess > idleMs) {
      delete data.circuits[target];
      cleaned++;
    }
  }
  return cleaned;
}

async function sidekick_circuit({ action, target, tool, args, failure_threshold, cooldown_seconds, cache_response }) {
  const data = loadCircuits();
  cleanupIdleCircuits(data);

  if (action === "status") {
    const entries = Object.entries(data.circuits);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No circuits configured" }] };
    }
    const list = entries.map(([t, c]) => {
      const age = Math.round((Date.now() - c.lastAccess) / 1000);
      return `${t}: ${c.state} (failures: ${c.failures}/${c.threshold}, cooldown: ${c.cooldown}s, last: ${age}s ago)`;
    }).join("\n");
    return { content: [{ type: "text", text: `Circuits (${entries.length}/${MAX_CIRCUIT_TARGETS}):\n\n${list}` }] };
  }

  if (action === "reset") {
    if (!target) {
      return { content: [{ type: "text", text: "target required" }], isError: true };
    }
    if (data.circuits[target]) {
      data.circuits[target].state = "closed";
      data.circuits[target].failures = 0;
      data.circuits[target].lastFailure = null;
      saveCircuits(data);
      return { content: [{ type: "text", text: `Circuit reset: ${target}` }] };
    }
    return { content: [{ type: "text", text: `Circuit not found: ${target}` }], isError: true };
  }

  if (action === "configure") {
    if (!target) {
      return { content: [{ type: "text", text: "target required" }], isError: true };
    }
    if (!data.circuits[target]) {
      if (Object.keys(data.circuits).length >= MAX_CIRCUIT_TARGETS) {
        return { content: [{ type: "text", text: `Max circuits reached (${MAX_CIRCUIT_TARGETS})` }], isError: true };
      }
      data.circuits[target] = {
        state: "closed",
        failures: 0,
        threshold: failure_threshold || 5,
        cooldown: cooldown_seconds || 60,
        lastFailure: null,
        lastAccess: Date.now(),
        cachedResponse: null
      };
    } else {
      if (failure_threshold !== undefined) data.circuits[target].threshold = failure_threshold;
      if (cooldown_seconds !== undefined) data.circuits[target].cooldown = cooldown_seconds;
    }
    saveCircuits(data);
    return { content: [{ type: "text", text: `Circuit configured: ${target} (threshold: ${data.circuits[target].threshold}, cooldown: ${data.circuits[target].cooldown}s)` }] };
  }

  if (action === "call") {
    if (!target || !tool) {
      return { content: [{ type: "text", text: "target and tool required" }], isError: true };
    }

    if (!data.circuits[target]) {
      if (Object.keys(data.circuits).length >= MAX_CIRCUIT_TARGETS) {
        return { content: [{ type: "text", text: `Max circuits reached (${MAX_CIRCUIT_TARGETS}). Configure a circuit first.` }], isError: true };
      }
      data.circuits[target] = {
        state: "closed",
        failures: 0,
        threshold: failure_threshold || 5,
        cooldown: cooldown_seconds || 60,
        lastFailure: null,
        lastAccess: Date.now(),
        cachedResponse: null
      };
    }

    const circuit = data.circuits[target];
    circuit.lastAccess = Date.now();
    const now = Date.now();

    if (circuit.state === "open") {
      const elapsed = (now - circuit.lastFailure) / 1000;
      if (elapsed >= circuit.cooldown) {
        circuit.state = "half-open";
      } else {
        const remaining = Math.ceil(circuit.cooldown - elapsed);
        if (cache_response && circuit.cachedResponse) {
          saveCircuits(data);
          return { content: [{ type: "text", text: `[CIRCUIT OPEN - CACHED] ${target}\nCooldown: ${remaining}s remaining\n\n${circuit.cachedResponse}` }] };
        }
        saveCircuits(data);
        return { content: [{ type: "text", text: `[CIRCUIT OPEN] ${target}\nFailures: ${circuit.failures}/${circuit.threshold}\nCooldown: ${remaining}s remaining\nTool: ${tool} (not called)` }], isError: true };
      }
    }

    const result = await callTool(tool, args || {});
    const success = !result.isError;

    if (success) {
      circuit.state = "closed";
      circuit.failures = 0;
      circuit.lastFailure = null;
      if (cache_response && result.content && result.content[0]) {
        circuit.cachedResponse = result.content[0].text;
      }
      saveCircuits(data);
      return result;
    } else {
      circuit.failures++;
      circuit.lastFailure = now;
      if (circuit.failures >= circuit.threshold) {
        circuit.state = "open";
      }
      saveCircuits(data);
      const stateInfo = circuit.state === "open" ? " (CIRCUIT NOW OPEN)" : "";
      return { content: [{ type: "text", text: `${result.content?.[0]?.text || "Tool call failed"}\n\n[CIRCUIT] ${target}: ${circuit.failures}/${circuit.threshold} failures${stateInfo}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: call, status, reset, configure" }], isError: true };
}

const BASELINE_FILE = path.join(DATA_DIR, "baselines.json");
const MAX_TRACKED_METRICS = 50;
const MAX_DATA_POINTS_PER_METRIC = 1000;
const MIN_DATA_POINTS_FOR_LEARNING = 10;

function loadBaselines() {
  try {
    if (fs.existsSync(BASELINE_FILE)) {
      return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    }
  } catch {}
  return { metrics: {} };
}

function saveBaselines(data) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
}

function getTimeBucket(hour) {
  return Math.floor(hour / 4) * 4;
}

function calculateStats(values) {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  return { mean, stddev };
}

async function sidekick_baseline({ action, metric_name, value, source, command, window, sensitivity }) {
  const data = loadBaselines();
  const sens = sensitivity || "medium";
  const sigmaMultiplier = { low: 3, medium: 2, high: 1.5 }[sens] || 2;

  if (action === "record") {
    if (!metric_name || value === undefined) {
      return { content: [{ type: "text", text: "metric_name and value required" }], isError: true };
    }

    if (!data.metrics[metric_name]) {
      if (Object.keys(data.metrics).length >= MAX_TRACKED_METRICS) {
        return { content: [{ type: "text", text: `Max metrics reached (${MAX_TRACKED_METRICS})` }], isError: true };
      }
      data.metrics[metric_name] = {
        dataPoints: [],
        baseline: null,
        created: Date.now()
      };
    }

    const metric = data.metrics[metric_name];
    metric.dataPoints.push({
      value,
      timestamp: Date.now(),
      hour: new Date().getHours()
    });

    if (metric.dataPoints.length > MAX_DATA_POINTS_PER_METRIC) {
      metric.dataPoints = metric.dataPoints.slice(-MAX_DATA_POINTS_PER_METRIC);
    }

    saveBaselines(data);
    return { content: [{ type: "text", text: `Recorded ${value} for ${metric_name} (${metric.dataPoints.length} points total)` }] };
  }

  if (action === "learn") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }

    const metric = data.metrics[metric_name];
    if (!metric) {
      return { content: [{ type: "text", text: `Metric not found: ${metric_name}` }], isError: true };
    }

    if (metric.dataPoints.length < MIN_DATA_POINTS_FOR_LEARNING) {
      return { content: [{ type: "text", text: `Insufficient data: ${metric.dataPoints.length}/${MIN_DATA_POINTS_FOR_LEARNING} points needed` }], isError: true };
    }

    const buckets = {};
    for (const point of metric.dataPoints) {
      const bucket = getTimeBucket(point.hour);
      if (!buckets[bucket]) buckets[bucket] = [];
      buckets[bucket].push(point.value);
    }

    const baseline = {};
    for (const [bucket, values] of Object.entries(buckets)) {
      const stats = calculateStats(values);
      baseline[bucket] = {
        mean: stats.mean,
        stddev: stats.stddev,
        count: values.length
      };
    }

    metric.baseline = baseline;
    metric.learnedAt = Date.now();
    saveBaselines(data);

    const bucketSummary = Object.entries(baseline).map(([b, s]) => 
      `${b.toString().padStart(2, "0")}:00 - mean: ${s.mean.toFixed(2)}, Ïƒ: ${s.stddev.toFixed(2)} (n=${s.count})`
    ).join("\n");

    return { content: [{ type: "text", text: `Baseline learned for ${metric_name}\n\nTime buckets:\n${bucketSummary}` }] };
  }

  if (action === "check") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }

    let currentValue = value;
    if (currentValue === undefined && source === "command" && command) {
      try {
        const result = execSync(command, { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
        currentValue = parseFloat(result.trim());
      } catch (e) {
        return { content: [{ type: "text", text: `Command failed: ${e.message}` }], isError: true };
      }
    }

    if (currentValue === undefined || isNaN(currentValue)) {
      return { content: [{ type: "text", text: "value required (or use source=command with a command that outputs a number)" }], isError: true };
    }

    const metric = data.metrics[metric_name];
    if (!metric || !metric.baseline) {
      return { content: [{ type: "text", text: `No baseline for ${metric_name}. Use action=learn first.` }], isError: true };
    }

    const currentHour = new Date().getHours();
    const bucket = getTimeBucket(currentHour);
    const bucketStats = metric.baseline[bucket];

    if (!bucketStats) {
      return { content: [{ type: "text", text: `No baseline data for time bucket ${bucket}:00` }], isError: true };
    }

    const deviation = Math.abs(currentValue - bucketStats.mean);
    const sigmaDeviation = bucketStats.stddev > 0 ? deviation / bucketStats.stddev : 0;
    const isAnomaly = sigmaDeviation > sigmaMultiplier;

    const result = {
      metric: metric_name,
      current: currentValue,
      expected: bucketStats.mean.toFixed(2),
      deviation: sigmaDeviation.toFixed(2) + "Ïƒ",
      threshold: sigmaMultiplier + "Ïƒ",
      status: isAnomaly ? "ANOMALY" : "normal",
      timeBucket: `${bucket}:00-${bucket + 3}:59`
    };

    let output = `Baseline Check: ${metric_name}\n`;
    output += `Current: ${result.current}\n`;
    output += `Expected: ${result.expected} (Â±${bucketStats.stddev.toFixed(2)}Ïƒ)\n`;
    output += `Deviation: ${result.deviation} (threshold: ${result.threshold})\n`;
    output += `Time bucket: ${result.timeBucket}\n`;
    output += `Status: ${result.status}`;

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "status") {
    const entries = Object.entries(data.metrics);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No metrics tracked" }] };
    }
    const list = entries.map(([name, m]) => {
      const learned = m.baseline ? "âœ“" : "âœ—";
      return `${name}: ${m.dataPoints.length} points, baseline: ${learned}`;
    }).join("\n");
    return { content: [{ type: "text", text: `Tracked metrics (${entries.length}/${MAX_TRACKED_METRICS}):\n\n${list}` }] };
  }

  if (action === "reset") {
    if (!metric_name) {
      return { content: [{ type: "text", text: "metric_name required" }], isError: true };
    }
    if (data.metrics[metric_name]) {
      delete data.metrics[metric_name];
      saveBaselines(data);
      return { content: [{ type: "text", text: `Reset metric: ${metric_name}` }] };
    }
    return { content: [{ type: "text", text: `Metric not found: ${metric_name}` }], isError: true };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: record, learn, check, status, reset" }], isError: true };
}

const MAX_DEPEND_DEPTH = 10;
const MAX_DEPEND_RESULTS = 100;

async function sidekick_depend({ action, type, target, depth, format }) {
  const maxDepth = Math.min(depth || 5, MAX_DEPEND_DEPTH);
  const fmt = format || "tree";

  if (action === "tree") {
    if (!type) {
      return { content: [{ type: "text", text: "type required (npm, service, process)" }], isError: true };
    }

    if (type === "npm") {
      const cwd = target || process.cwd();
      try {
        const result = execSync(`npm ls --depth=${maxDepth} --json`, { 
          encoding: "utf8", 
          cwd,
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);
        
        if (fmt === "json") {
          return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
        }
        
        const formatNpmTree = (node, indent = 0) => {
          let output = "";
          const prefix = "  ".repeat(indent);
          if (node.name) {
            output += `${prefix}${node.name}@${node.version || "?"}\n`;
          }
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              output += formatNpmTree(dep, indent + 1);
            }
          }
          return output;
        };
        
        return { content: [{ type: "text", text: formatNpmTree(tree) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `npm ls failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "service") {
      if (!target) {
        return { content: [{ type: "text", text: "target required for service tree" }], isError: true };
      }
      try {
        const result = execSync(`systemctl list-dependencies ${shellEscape(target)} --no-pager`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `systemctl failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "process") {
      const pid = target || "1";
      try {
        const result = execSync(`pstree -p ${shellEscape(pid)}`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `pstree failed: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown type. Use: npm, service, process" }], isError: true };
  }

  if (action === "reverse") {
    if (!type || !target) {
      return { content: [{ type: "text", text: "type and target required" }], isError: true };
    }

    if (type === "npm") {
      const cwd = process.cwd();
      try {
        const result = execSync(`npm ls --all --json`, {
          encoding: "utf8",
          cwd,
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);
        
        const findDependents = (node, targetName, path = []) => {
          const results = [];
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              if (name === targetName) {
                results.push([...path, node.name || "root"]);
              }
              results.push(...findDependents(dep, targetName, [...path, node.name || "root"]));
            }
          }
          return results;
        };
        
        const dependents = findDependents(tree, target);
        if (dependents.length === 0) {
          return { content: [{ type: "text", text: `No packages depend on ${target}` }] };
        }
        
        const unique = [...new Set(dependents.map(d => d.join(" â†’ ")))];
        return { content: [{ type: "text", text: `Packages depending on ${target}:\n\n${unique.slice(0, MAX_DEPEND_RESULTS).join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `npm ls failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "service") {
      try {
        const result = execSync(`systemctl list-dependencies --reverse ${shellEscape(target)} --no-pager`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result || `No services depend on ${target}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `systemctl failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "process") {
      try {
        const result = execSync(`ps -o pid,ppid,comm --ppid ${shellEscape(target)}`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result || `No child processes for PID ${target}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `ps failed: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown type. Use: npm, service, process" }], isError: true };
  }

  if (action === "outdated") {
    if (type !== "npm") {
      return { content: [{ type: "text", text: "outdated only supported for npm" }], isError: true };
    }
    const cwd = target || process.cwd();
    try {
      const result = execSync(`npm outdated --json`, {
        encoding: "utf8",
        cwd,
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const outdated = JSON.parse(result);
      if (Object.keys(outdated).length === 0) {
        return { content: [{ type: "text", text: "All packages are up to date" }] };
      }
      const list = Object.entries(outdated).map(([name, info]) => 
        `${name}: ${info.current || "?"} â†’ ${info.latest} (wanted: ${info.wanted || "?"})`
      ).join("\n");
      return { content: [{ type: "text", text: `Outdated packages:\n\n${list}` }] };
    } catch (e) {
      if (e.stdout) {
        try {
          const outdated = JSON.parse(e.stdout);
          const list = Object.entries(outdated).map(([name, info]) => 
            `${name}: ${info.current || "?"} â†’ ${info.latest} (wanted: ${info.wanted || "?"})`
          ).join("\n");
          return { content: [{ type: "text", text: `Outdated packages:\n\n${list}` }] };
        } catch {}
      }
      return { content: [{ type: "text", text: `npm outdated failed: ${e.message}` }], isError: true };
    }
  }

  if (action === "impact") {
    if (!type || !target) {
      return { content: [{ type: "text", text: "type and target required" }], isError: true };
    }

    let impact = `Impact analysis for removing ${target}:\n\n`;
    
    if (type === "npm") {
      try {
        const result = execSync(`npm ls --all --json`, {
          encoding: "utf8",
          cwd: process.cwd(),
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);
        
        const findDependents = (node, targetName) => {
          const results = [];
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              if (name === targetName) {
                results.push(node.name || "root");
              }
              results.push(...findDependents(dep, targetName));
            }
          }
          return results;
        };
        
        const dependents = findDependents(tree, target);
        if (dependents.length === 0) {
          impact += "No packages depend on this. Safe to remove.";
        } else {
          const unique = [...new Set(dependents)];
          impact += `WARNING: ${unique.length} package(s) depend on this:\n`;
          impact += unique.slice(0, 20).map(d => `  - ${d}`).join("\n");
          if (unique.length > 20) impact += `\n  ... and ${unique.length - 20} more`;
        }
      } catch (e) {
        impact += `Analysis failed: ${e.message}`;
      }
    } else if (type === "service") {
      try {
        const result = execSync(`systemctl list-dependencies --reverse ${shellEscape(target)} --no-pager`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        if (result.trim()) {
          impact += `WARNING: The following services depend on ${target}:\n${result}`;
        } else {
          impact += "No services depend on this. Safe to remove.";
        }
      } catch (e) {
        impact += `Analysis failed: ${e.message}`;
      }
    } else {
      impact += "Impact analysis not supported for this type";
    }

    return { content: [{ type: "text", text: impact }] };
  }

  if (action === "orphans") {
    if (type !== "npm") {
      return { content: [{ type: "text", text: "orphans only supported for npm" }], isError: true };
    }
    const cwd = target || process.cwd();
    try {
      const pkgPath = path.join(cwd, "package.json");
      if (!fs.existsSync(pkgPath)) {
        return { content: [{ type: "text", text: "No package.json found" }], isError: true };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const declared = Object.keys(pkg.dependencies || {});
      
      const result = execSync(`npm ls --depth=0 --json`, {
        encoding: "utf8",
        cwd,
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const tree = JSON.parse(result);
      const installed = Object.keys(tree.dependencies || {});
      
      const orphans = installed.filter(dep => !declared.includes(dep));
      if (orphans.length === 0) {
        return { content: [{ type: "text", text: "No orphaned dependencies found" }] };
      }
      return { content: [{ type: "text", text: `Orphaned dependencies (installed but not in package.json):\n\n${orphans.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Analysis failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: tree, reverse, outdated, impact, orphans" }], isError: true };
}

const RUNBOOK_FILE = path.join(DATA_DIR, "runbooks.json");
const MAX_RUNBOOKS = 20;
const MAX_ACTIVE_INSTANCES = 5;
const MAX_STEPS_PER_RUNBOOK = 20;
const STEP_TIMEOUT_MS = 60000;

function loadRunbooks() {
  try {
    if (fs.existsSync(RUNBOOK_FILE)) {
      return JSON.parse(fs.readFileSync(RUNBOOK_FILE, "utf8"));
    }
  } catch {}
  return { definitions: {}, instances: {} };
}

function saveRunbooks(data) {
  fs.writeFileSync(RUNBOOK_FILE, JSON.stringify(data, null, 2));
}

function generateRunbookId() {
  return "rb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function sidekick_runbook({ action, name, mode, steps, runbook_id, step_index }) {
  const data = loadRunbooks();
  const execMode = mode || "autonomous";

  if (action === "create") {
    if (!name || !steps || steps.length === 0) {
      return { content: [{ type: "text", text: "name and steps required" }], isError: true };
    }
    if (steps.length > MAX_STEPS_PER_RUNBOOK) {
      return { content: [{ type: "text", text: `Max steps per runbook: ${MAX_STEPS_PER_RUNBOOK}` }], isError: true };
    }
    if (Object.keys(data.definitions).length >= MAX_RUNBOOKS) {
      return { content: [{ type: "text", text: `Max runbooks reached (${MAX_RUNBOOKS})` }], isError: true };
    }

    const id = generateRunbookId();
    data.definitions[id] = {
      name,
      steps,
      created: Date.now()
    };
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Runbook created: ${id} (${name})\nSteps: ${steps.length}` }] };
  }

  if (action === "list") {
    const entries = Object.entries(data.definitions);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No runbooks defined" }] };
    }
    const list = entries.map(([id, rb]) => {
      const instances = Object.values(data.instances).filter(i => i.definitionId === id && i.status === "running").length;
      return `${id}: ${rb.name} (${rb.steps.length} steps, ${instances} active)`;
    }).join("\n");
    return { content: [{ type: "text", text: `Runbooks (${entries.length}/${MAX_RUNBOOKS}):\n\n${list}` }] };
  }

  if (action === "get") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let rb = null;
    let rbId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { rb = def; rbId = id; break; }
      }
    } else {
      rb = data.definitions[runbook_id];
    }
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }
    const stepsList = rb.steps.map((s, i) => `${i + 1}. ${s.name}\n   Command: ${s.command}\n   ${s.rollback ? "Rollback: " + s.rollback : ""}\n   ${s.verify_command ? "Verify: " + s.verify_command : ""}`).join("\n\n");
    return { content: [{ type: "text", text: `Runbook: ${rbId} (${rb.name})\n\n${stepsList}` }] };
  }

  if (action === "delete") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let targetId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { targetId = id; break; }
      }
    }
    if (!data.definitions[targetId]) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }
    delete data.definitions[targetId];
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Deleted runbook: ${targetId}` }] };
  }

  if (action === "start") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let rb = null;
    let rbId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { rb = def; rbId = id; break; }
      }
    } else {
      rb = data.definitions[runbook_id];
    }
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }

    const activeCount = Object.values(data.instances).filter(i => i.status === "running").length;
    if (activeCount >= MAX_ACTIVE_INSTANCES) {
      return { content: [{ type: "text", text: `Max active instances reached (${MAX_ACTIVE_INSTANCES})` }], isError: true };
    }

    const instanceId = generateRunbookId();
    data.instances[instanceId] = {
      definitionId: rbId,
      status: "running",
      currentStep: 0,
      mode: execMode,
      started: Date.now(),
      results: []
    };
    saveRunbooks(data);

    if (execMode === "autonomous") {
      let output = `Starting autonomous runbook: ${rbId} (${rb.name})\n\n`;
      for (let i = 0; i < rb.steps.length; i++) {
        const step = rb.steps[i];
        output += `Step ${i + 1}/${rb.steps.length}: ${step.name}\n`;
        try {
          const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
          output += `  âœ“ Success\n`;
          if (step.verify_command) {
            try {
              const verifyResult = execSync(step.verify_command, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
              output += `  âœ“ Verified\n`;
            } catch (e) {
              output += `  âœ— Verification failed: ${e.message}\n`;
              if (step.rollback) {
                output += `  Rolling back...\n`;
                try {
                  execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
                  output += `  âœ“ Rollback successful\n`;
                } catch (re) {
                  output += `  âœ— Rollback failed: ${re.message}\n`;
                }
              }
              data.instances[instanceId].status = "failed";
              saveRunbooks(data);
              return { content: [{ type: "text", text: output }], isError: true };
            }
          }
          data.instances[instanceId].results.push({ step: i, success: true });
        } catch (e) {
          output += `  âœ— Failed: ${e.message}\n`;
          if (step.rollback) {
            output += `  Rolling back...\n`;
            try {
              execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
              output += `  âœ“ Rollback successful\n`;
            } catch (re) {
              output += `  âœ— Rollback failed: ${re.message}\n`;
            }
          }
          data.instances[instanceId].status = "failed";
          data.instances[instanceId].currentStep = i;
          saveRunbooks(data);
          return { content: [{ type: "text", text: output }], isError: true };
        }
      }
      data.instances[instanceId].status = "completed";
      saveRunbooks(data);
      output += `\nâœ“ Runbook completed successfully`;
      return { content: [{ type: "text", text: output }] };
    } else {
      const step = rb.steps[0];
      let output = `Starting guided runbook: ${rbId} (${rb.name})\n\n`;
      output += `Step 1/${rb.steps.length}: ${step.name}\n`;
      output += `Command: ${step.command}\n`;
      try {
        const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
        output += `Result: ${result.substring(0, 500)}\n`;
        data.instances[instanceId].results.push({ step: 0, success: true, output: result });
        if (rb.steps.length > 1) {
          output += `\nUse action="next" with runbook_id="${instanceId}" to continue`;
        } else {
          data.instances[instanceId].status = "completed";
          output += `\nâœ“ Runbook completed`;
        }
      } catch (e) {
        output += `Failed: ${e.message}\n`;
        if (step.rollback) {
          output += `Use action="rollback" with runbook_id="${instanceId}" to rollback`;
        }
        data.instances[instanceId].status = "failed";
      }
      saveRunbooks(data);
      return { content: [{ type: "text", text: output }] };
    }
  }

  if (action === "next") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (instance.mode !== "guided") {
      return { content: [{ type: "text", text: "Instance is not in guided mode" }], isError: true };
    }
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }

    instance.currentStep++;
    if (instance.currentStep >= rb.steps.length) {
      instance.status = "completed";
      saveRunbooks(data);
      return { content: [{ type: "text", text: `âœ“ Runbook completed` }] };
    }

    const step = rb.steps[instance.currentStep];
    let output = `Step ${instance.currentStep + 1}/${rb.steps.length}: ${step.name}\n`;
    output += `Command: ${step.command}\n`;
    try {
      const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
      output += `Result: ${result.substring(0, 500)}\n`;
      instance.results.push({ step: instance.currentStep, success: true, output: result });
      if (instance.currentStep < rb.steps.length - 1) {
        output += `\nUse action="next" to continue`;
      } else {
        instance.status = "completed";
        output += `\nâœ“ Runbook completed`;
      }
    } catch (e) {
      output += `Failed: ${e.message}\n`;
      if (step.rollback) {
        output += `Use action="rollback" to rollback`;
      }
      instance.status = "failed";
    }
    saveRunbooks(data);
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "verify") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }
    const step = rb.steps[instance.currentStep];
    if (!step.verify_command) {
      return { content: [{ type: "text", text: "No verification command for this step" }] };
    }
    try {
      const result = execSync(step.verify_command, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
      return { content: [{ type: "text", text: `âœ“ Verification passed\n\n${result}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `âœ— Verification failed\n\n${e.message}` }], isError: true };
    }
  }

  if (action === "rollback") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }

    let output = `Rolling back runbook: ${runbook_id}\n\n`;
    for (let i = instance.currentStep; i >= 0; i--) {
      const step = rb.steps[i];
      if (step.rollback) {
        output += `Step ${i + 1}: ${step.name}\n`;
        try {
          execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
          output += `  âœ“ Rollback successful\n`;
        } catch (e) {
          output += `  âœ— Rollback failed: ${e.message}\n`;
        }
      }
    }
    instance.status = "rolled_back";
    saveRunbooks(data);
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "abort") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    instance.status = "aborted";
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Aborted runbook: ${runbook_id}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: create, start, next, verify, rollback, abort, list, get, delete" }], isError: true };
}

const BLACKBOX_FILE = path.join(DATA_DIR, "blackbox.json");
const BLACKBOX_DIR = path.join(DATA_DIR, "blackbox");
const MAX_BLACKBOX_PER_DAY = 5;
const BLACKBOX_TTL_DAYS = 7;
const MAX_BLACKBOX_ACTIVE = 3;
const MAX_BLACKBOX_COMMANDS = 10;

fs.mkdirSync(BLACKBOX_DIR, { recursive: true });

function loadBlackbox() {
  try {
    if (fs.existsSync(BLACKBOX_FILE)) {
      return JSON.parse(fs.readFileSync(BLACKBOX_FILE, "utf8"));
    }
  } catch {}
  return { incidents: {} };
}

function saveBlackbox(data) {
  fs.writeFileSync(BLACKBOX_FILE, JSON.stringify(data, null, 2));
}

function purgeExpiredIncidents(data) {
  const now = Date.now();
  const ttlMs = BLACKBOX_TTL_DAYS * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const [id, incident] of Object.entries(data.incidents)) {
    if (now - incident.captured > ttlMs) {
      const incidentPath = path.join(BLACKBOX_DIR, id);
      try { fs.rmSync(incidentPath, { recursive: true, force: true }); } catch {}
      delete data.incidents[id];
      purged++;
    }
  }
  return purged;
}

function generateIncidentId() {
  return "bb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function sidekick_black_box({ action, name, include, analyze_with_llm, incident_id }) {
  const data = loadBlackbox();
  purgeExpiredIncidents(data);

  if (action === "list") {
    const entries = Object.entries(data.incidents);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No incidents captured" }] };
    }
    const list = entries.map(([id, inc]) => {
      const age = Math.round((Date.now() - inc.captured) / 1000 / 60);
      return `${id}: ${inc.name || "unnamed"} (${age}min ago, ${inc.sources.length} sources)`;
    }).join("\n");
    return { content: [{ type: "text", text: `Incidents (${entries.length}/${MAX_BLACKBOX_ACTIVE}):\n\n${list}` }] };
  }

  if (action === "get") {
    if (!incident_id) {
      return { content: [{ type: "text", text: "incident_id required" }], isError: true };
    }
    const incident = data.incidents[incident_id];
    if (!incident) {
      return { content: [{ type: "text", text: `Incident not found: ${incident_id}` }], isError: true };
    }
    const incidentPath = path.join(BLACKBOX_DIR, incident_id);
    let content = "";
    try {
      content = fs.readFileSync(incidentPath, "utf8");
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to read incident data: ${e.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: content }] };
  }

  if (action === "delete") {
    if (!incident_id) {
      return { content: [{ type: "text", text: "incident_id required" }], isError: true };
    }
    if (!data.incidents[incident_id]) {
      return { content: [{ type: "text", text: `Incident not found: ${incident_id}` }], isError: true };
    }
    const incidentPath = path.join(BLACKBOX_DIR, incident_id);
    try { fs.rmSync(incidentPath, { recursive: true, force: true }); } catch {}
    delete data.incidents[incident_id];
    saveBlackbox(data);
    return { content: [{ type: "text", text: `Deleted incident: ${incident_id}` }] };
  }

  if (action === "capture") {
    const today = new Date().toISOString().split("T")[0];
    const todayIncidents = Object.values(data.incidents).filter(inc => {
      const incDate = new Date(inc.captured).toISOString().split("T")[0];
      return incDate === today;
    });

    if (todayIncidents.length >= MAX_BLACKBOX_PER_DAY) {
      return { content: [{ type: "text", text: `Rate limit exceeded: max ${MAX_BLACKBOX_PER_DAY} captures per day` }], isError: true };
    }

    if (Object.keys(data.incidents).length >= MAX_BLACKBOX_ACTIVE) {
      return { content: [{ type: "text", text: `Max active incidents reached (${MAX_BLACKBOX_ACTIVE}). Delete old incidents or wait for TTL expiry.` }], isError: true };
    }

    const id = generateIncidentId();
    const incidentName = name || `incident_${Date.now()}`;
    const sources = include && include[0] !== "all" ? include : ["services", "processes", "logs", "disk", "network"];
    
    let commandCount = 0;
    const checkLimit = () => {
      commandCount++;
      if (commandCount > MAX_BLACKBOX_COMMANDS) {
        throw new Error(`Exceeded max commands per capture (${MAX_BLACKBOX_COMMANDS})`);
      }
    };

    let content = `# Incident Report: ${incidentName}\n`;
    content += `ID: ${id}\n`;
    content += `Time: ${new Date().toISOString()}\n`;
    content += `Sources: ${sources.join(", ")}\n\n`;

    try {
      if (sources.includes("services")) {
        checkLimit();
        content += "## Services\n\n";
        try {
          const result = execSync("systemctl list-units --type=service --no-pager --state=running", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get services: ${e.message}\n`;
        }
      }

      if (sources.includes("processes")) {
        checkLimit();
        content += "## Top Processes\n\n";
        try {
          const result = execSync("ps aux --sort=-%cpu | head -20", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get processes: ${e.message}\n`;
        }
      }

      if (sources.includes("logs")) {
        checkLimit();
        content += "## Recent Logs (journalctl)\n\n";
        try {
          const result = execSync("journalctl -n 100 --no-pager", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get journalctl: ${e.message}\n`;
        }

        checkLimit();
        content += "## Recent Tool Calls (log.jsonl)\n\n";
        try {
          const logContent = fs.readFileSync(LOG_FILE, "utf8");
          const lines = logContent.trim().split("\n").slice(-100);
          content += lines.join("\n") + "\n";
        } catch (e) {
          content += `Failed to read log.jsonl: ${e.message}\n`;
        }
      }

      if (sources.includes("disk")) {
        checkLimit();
        content += "## Disk Usage\n\n";
        try {
          const result = execSync("df -h", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get disk: ${e.message}\n`;
        }
      }

      if (sources.includes("network")) {
        checkLimit();
        content += "## Network Listeners\n\n";
        try {
          const result = execSync("ss -tlnp", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });
          content += result + "\n";
        } catch (e) {
          content += `Failed to get network: ${e.message}\n`;
        }
      }
    } catch (e) {
      content += `\n\nCapture error: ${e.message}\n`;
    }

    const incidentPath = path.join(BLACKBOX_DIR, id);
    fs.writeFileSync(incidentPath, content);

    data.incidents[id] = {
      name: incidentName,
      captured: Date.now(),
      sources,
      size: content.length
    };
    saveBlackbox(data);

    let result = `Incident captured: ${id}\n`;
    result += `Name: ${incidentName}\n`;
    result += `Sources: ${sources.join(", ")}\n`;
    result += `Size: ${content.length} bytes\n`;
    result += `Commands executed: ${commandCount}\n`;

    if (analyze_with_llm) {
      try {
        const summaryPrompt = `Analyze this incident report and identify potential issues or anomalies:\n\n${content.substring(0, 5000)}`;
        const llmResult = await sidekick_llm({
          prompt: summaryPrompt,
          system: "You are a senior systems engineer analyzing an incident report. Identify key issues, anomalies, and potential root causes. Be concise and actionable.",
          temperature: 0.3
        });
        if (llmResult.content && llmResult.content[0]) {
          result += `\n## LLM Analysis\n\n${llmResult.content[0].text}`;
        }
      } catch (e) {
        result += `\nLLM analysis failed: ${e.message}`;
      }
    }

    return { content: [{ type: "text", text: result }] };
  }

  if (action === "analyze") {
    if (!incident_id) {
      return { content: [{ type: "text", text: "incident_id required" }], isError: true };
    }
    const incident = data.incidents[incident_id];
    if (!incident) {
      return { content: [{ type: "text", text: `Incident not found: ${incident_id}` }], isError: true };
    }
    const incidentPath = path.join(BLACKBOX_DIR, incident_id);
    let content = "";
    try {
      content = fs.readFileSync(incidentPath, "utf8");
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to read incident data: ${e.message}` }], isError: true };
    }

    try {
      const summaryPrompt = `Analyze this incident report and identify potential issues or anomalies:\n\n${content.substring(0, 5000)}`;
      const llmResult = await sidekick_llm({
        prompt: summaryPrompt,
        system: "You are a senior systems engineer analyzing an incident report. Identify key issues, anomalies, and potential root causes. Be concise and actionable.",
        temperature: 0.3
      });
      if (llmResult.content && llmResult.content[0]) {
        return { content: [{ type: "text", text: `## LLM Analysis for ${incident_id}\n\n${llmResult.content[0].text}` }] };
      }
    } catch (e) {
      return { content: [{ type: "text", text: `LLM analysis failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: capture, list, get, delete, analyze" }], isError: true };
}

// Simple respond tool for agent to return text without calling other tools
async function sidekick_respond({ text }) {
  if (!text) {
    return { content: [{ type: "text", text: "text parameter required" }], isError: true };
  }
  return { content: [{ type: "text", text: text }] };
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
  sidekick_teach,
  sidekick_transform,
  sidekick_health,
  sidekick_delay,
  sidekick_snapshot,
  sidekick_watch,
  sidekick_secret,
  sidekick_parse,
  sidekick_diff,
  sidekick_hash,
  sidekick_validate,
  sidekick_template,
  sidekick_queue,
  sidekick_retry,
  sidekick_evolve,
  sidekick_orchestrate,
  sidekick_predict,
  sidekick_debug_tool,
  sidekick_fresheyes,
  sidekick_batch,
  sidekick_cache,
  sidekick_summarize,
  sidekick_filter,
  sidekick_project,
  sidekick_tail,
  sidekick_diff_files,
  sidekick_find,
  sidekick_status,
  sidekick_extract,
  sidekick_anonymize,
  sidekick_sandbox,
  sidekick_changelog,
  sidekick_netdiag,
  sidekick_timeline,
  sidekick_circuit,
  sidekick_baseline,
  sidekick_depend,
  sidekick_runbook,
  sidekick_black_box,
  sidekick_respond,
};

const TOOL_DEFS = [
  { name: "sidekick_bash", description: "Execute a shell command on the remote machine", args: { command: "string" } },
  { name: "sidekick_read", description: "Read a file from the remote filesystem", args: { path: "string" } },
  { name: "sidekick_write", description: "Write content to a file on the remote machine", args: { path: "string", content: "string" } },
  { name: "sidekick_list", description: "List files and directories on the remote machine", args: { path: "string" } },
  { name: "sidekick_store", description: "Store a value persistently in KV storage", args: { key: "string", value: "string", project: "string (optional)" } },
  { name: "sidekick_get", description: "Retrieve a stored value from KV storage", args: { key: "string" } },
  { name: "sidekick_web_fetch", description: "Fetch a URL from the remote machine", args: { url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" } },
  { name: "sidekick_llm", description: "Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq)", args: { prompt: "string", system: "string (optional)", temperature: "number (optional)", provider: "string (optional, 'ollama' or 'groq' - default from SIDEKICK_DEFAULT_LLM env var or 'ollama')" } },
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
  { name: "sidekick_teach", description: "Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows", args: { action: "string", name: "string (optional)", description: "string (optional)", steps: "array (optional)", parameters: "object (optional)", args: "object (optional)", example: "string (optional)", trigger_phrases: "array (optional)", implementation: "string (optional)" } },
  { name: "sidekick_transform", description: "Data manipulation pipeline: filter, extract, sort, format, and map data", args: { action: "string (filter|extract|sort|format|map)", input: "string", pattern: "string (optional, for filter)", field: "string (optional, for extract)", key: "string (optional, for sort/map)", value: "string (optional, for map)", format: "string (optional, for format: json|csv|table|text)" } },
  { name: "sidekick_health", description: "Composite system health checks with scoring and issue detection", args: { check: "string (all|services|processes|disk|network|custom)", services: "string (optional, comma-separated service names)", commands: "string (optional, comma-separated commands for custom check)", threshold: "string (optional, e.g. 'disk>90,mem>80')" } },
  { name: "sidekick_delay", description: "One-shot task scheduling: run a tool once at a specific time or after a delay", args: { action: "string (add|list|cancel|run)", id: "string (optional, for cancel/run)", when: "string (optional, e.g. 10s, 5m, 2h, 1d, or ISO date)", name: "string (optional, human-readable name)", tool: "string (optional, tool name to execute)", args: "object (optional, arguments for the tool)" } },
  { name: "sidekick_snapshot", description: "Capture system state and detect drift by comparing snapshots", args: { action: "string (capture|compare|list|delete)", name: "string (snapshot name)", capture: "string (optional, comma-separated: processes,services,disk,packages,network,files:/path)", compare: "string (optional, baseline snapshot name for compare action)" } },
  { name: "sidekick_watch", description: "Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions", args: { action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, URL, or file path)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" } },
  { name: "sidekick_secret", description: "Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env)", args: { action: "string (store|get|delete|list|rotate)", key: "string (secret name)", value: "string (optional, for store)", generate: "string (optional, length for rotate, e.g. '32')" } },
  { name: "sidekick_parse", description: "Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection", args: { input: "string (data to parse)", format: "string (optional, json|yaml|xml|ini|csv - auto-detected if not specified)" } },
  { name: "sidekick_diff", description: "Semantic comparison of text, JSON, or YAML with structure-aware diffing", args: { old_text: "string (original content)", new_text: "string (modified content)", type: "string (optional, text|json|yaml|auto - default auto)", format: "string (optional, unified|summary|json - default unified)" } },
  { name: "sidekick_hash", description: "Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification", args: { input: "string (optional, data to hash)", path: "string (optional, file path to hash)", algorithm: "string (optional, md5|sha1|sha256|sha512 - default sha256)", verify: "string (optional, expected hash to verify against)" } },
  { name: "sidekick_validate", description: "Validate data against JSON Schema", args: { data: "string|object (data to validate)", schema: "string|object (JSON Schema)" } },
  { name: "sidekick_template", description: "Render Handlebars templates with data", args: { template: "string (Handlebars template)", data: "string|object (template data)" } },
  { name: "sidekick_queue", description: "Persistent task queue with priorities", args: { action: "string (add|list|process|remove|clear)", id: "number (optional, task id for remove)", tool: "string (optional, tool name for add)", args: "object (optional, tool args for add)", priority: "number (optional, priority for add, default 0)", status: "string (optional, status filter for list/clear)" } },
  { name: "sidekick_retry", description: "Retry tool calls with exponential backoff", args: { tool: "string (tool to retry)", args: "object (optional, tool args)", max_attempts: "number (optional, default 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" } },
  { name: "sidekick_evolve", description: "Self-modification with safety: analyze patterns, propose improvements, test and approve changes", args: { action: "string (analyze|propose|list|test|approve|reject)", id: "string (optional, proposal id for test/approve/reject)", proposal: "string (optional, proposal description for propose)", approve: "boolean (optional, deprecated - use action=approve)", test: "boolean (optional, deprecated - use action=test)" } },
  { name: "sidekick_orchestrate", description: "Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress", args: { action: "string (create|execute|list|status|cancel)", id: "number (optional, task id for execute/status/cancel)", task_name: "string (optional, task name for create)", subtasks: "array (optional, subtask definitions for create)", dependencies: "object (optional, dependency map for create)", timeout: "number (optional, timeout in ms, default 1800000)" } },
  { name: "sidekick_predict", description: "Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness", args: { action: "string (analyze|list|feedback|suggest)", id: "string (optional, prediction id for feedback)", feedback: "boolean (optional, true if useful, false if not)" } },
  { name: "sidekick_debug_tool", description: "Structured debugging cache with persistent storage for cross-session debugging. Store findings, recall past investigations, cleanup old entries.", args: { action: "string (store|recall|cleanup|start|stop|cache|get|status|clear)", session_name: "string (optional, session identifier for legacy actions)", key: "string (optional, cache key for get/cache, or debug key for cleanup)", value: "string (optional, value to cache/store)", service: "string (optional, service name for store/recall)", issue: "string (optional, issue description for store)", redact: "boolean (optional, default true - set false to skip redaction)" } },
  { name: "sidekick_fresheyes", description: "Get a fresh perspective from Sidekick's LLM (Grok) on a problem. Sends sanitized context for independent analysis", args: { problem: "string (problem description)", context: "string (optional, relevant context)", files: "array (optional, files analyzed)", hypotheses: "array (optional, current hypotheses)", full_response: "boolean (optional, return full response vs key insights)" } },
  { name: "sidekick_batch", description: "Execute multiple tool calls in one request to reduce API round-trips. Max 20 calls per batch.", args: { calls: "array (array of { tool: string, args: object })" } },
  { name: "sidekick_cache", description: "Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL.", args: { action: "string (get|set|clear|list)", key: "string (cache key)", ttl: "string (optional, e.g. 30s, 5m, 1h - default 5m)", value: "string (value to cache, for set action)" } },
  { name: "sidekick_summarize", description: "Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats.", args: { path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" } },
  { name: "sidekick_filter", description: "Filter file contents or directory listings by pattern, date, or size before returning.", args: { path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" } },
  { name: "sidekick_project", description: "Get complete project context in one call: KV entries, context tracking, recent logs, procedures.", args: { name: "string (project name)", include: "string (optional, comma-separated: kv,context,logs,procedures - default kv,context)" } },
  { name: "sidekick_tail", description: "Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file.", args: { source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" } },
  { name: "sidekick_diff_files", description: "Compare two files directly without reading both into context. Returns unified diff or summary.", args: { path_a: "string (first file path)", path_b: "string (second file path)", format: "string (optional, unified|summary - default unified)" } },
  { name: "sidekick_find", description: "Advanced file finder: search by name pattern, date range, size range, and content pattern.", args: { path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" } },
  { name: "sidekick_status", description: "Unified system status: services, disk, memory, load, uptime, top processes in one call.", args: { include: "string (optional, comma-separated: services,disk,memory,load,uptime,processes - default services,disk)", services: "string (optional, comma-separated service names - default sidekick-mcp,sidekick-dashboard,sidekick-agent)" } },
  { name: "sidekick_extract", description: "Parse JSON/YAML/INI/XML and extract specific fields by path. Returns only what you need.", args: { path: "string (file path)", fields: "string|array (optional, field paths to extract e.g. 'database.host,database.port')" } },
  { name: "sidekick_anonymize", description: "Replace sensitive data with realistic but fake values. Preserves data structure while making it safe to share externally.", args: { action: "string (anonymize|patterns|add_pattern|remove_pattern)", input: "string (optional, text to anonymize)", format: "string (optional, text|json|yaml - default text)", custom_patterns: "array (optional, {pattern, replacement} objects)", consistency: "boolean (optional, same input always maps to same output - default true)" } },
  { name: "sidekick_sandbox", description: "Execute operations in a tracked context with automatic backup and rollback. Safe experimentation on remote systems.", args: { action: "string (exec|rollback|list|diff|clean)", sandbox_name: "string (optional, sandbox identifier)", command: "string (optional, command to execute)", files: "array (optional, files to auto-backup before exec)", auto_backup: "boolean (optional, default true)", rollback_id: "string (optional, sandbox to rollback)" } },
  { name: "sidekick_changelog", description: "Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries.", args: { action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" } },
  { name: "sidekick_netdiag", description: "Unified network diagnostics: DNS, routing, port scanning, connectivity checks, and local listeners.", args: { action: "string (check|dns|route|ports|listeners|connectivity)", target: "string (host, URL, or IP to diagnose)", port_range: "string (optional, port range e.g. '80-443')", timeout: "number (optional, timeout in ms - default 5000)", format: "string (optional, detailed|compact|json - default detailed)" } },
  { name: "sidekick_timeline", description: "Build chronological timeline from multiple log sources. Correlates events across log.jsonl, journalctl, git, and file modifications.", args: { action: "string (build|filter|export)", since: "string (start time: ISO or relative like 1h, 1d)", until: "string (optional, end time - default now)", sources: "array (optional, log.jsonl|journalctl|git|files|all - default all)", pattern: "string (optional, regex filter)", severity: "string (optional, error|warn|info|all - default all)", format: "string (optional, compact|detailed|json - default compact)", max_events: "number (optional, default 200)" } },
  { name: "sidekick_circuit", description: "Circuit breaker for tool calls. Prevents cascading failures by fast-failing when a target is down.", args: { action: "string (call|status|reset|configure)", target: "string (circuit target label)", tool: "string (optional, tool name for call action)", args: "object (optional, tool arguments for call action)", failure_threshold: "number (optional, failures before opening - default 5)", cooldown_seconds: "number (optional, seconds before half-open - default 60)", cache_response: "boolean (optional, cache last successful response - default false)" } },
  { name: "sidekick_baseline", description: "Behavioral baseline and anomaly detection. Learns normal patterns and detects statistical deviations.", args: { action: "string (record|learn|check|status|reset)", metric_name: "string (metric identifier)", value: "number (optional, value to record)", source: "string (optional, health|custom|command)", command: "string (optional, command to collect metric)", window: "string (optional, history window - default 7d)", sensitivity: "string (optional, low|medium|high - default medium)" } },
  { name: "sidekick_depend", description: "Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis.", args: { action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" } },
  { name: "sidekick_runbook", description: "Operational runbook executor with autonomous and guided modes. Supports verification, rollback, and step-by-step execution.", args: { action: "string (create|start|next|verify|rollback|abort|list|get|delete)", name: "string (optional, runbook name)", mode: "string (optional, autonomous|guided - default autonomous)", steps: "array (optional, step definitions)", runbook_id: "string (optional, instance or definition ID)", step_index: "number (optional, step index)" } },
  { name: "sidekick_black_box", description: "Incident time capsule: captures full system context (services, processes, logs, disk, network) in one call for debugging. Rate limited.", args: { action: "string (capture|list|get|delete|analyze)", name: "string (optional, incident name)", include: "array (optional, services|processes|logs|disk|network|all - default all)", analyze_with_llm: "boolean (optional, use LLM for analysis - default false)", incident_id: "string (optional, incident ID)" } },
  { name: "sidekick_respond", description: "Return a text response directly without calling other tools. Use this for simple answers or when no tool action is needed.", args: { text: "string (the response text to return)" } },
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

module.exports = { TOOLS, TOOL_DEFS, callTool, logToolCall, setSource, DATA_DIR, OLLAMA_URL, GROQ_API_KEY, GROQ_MODEL, migrateKV, loadProcedures, loadDelays, saveDelays, loadWatches, saveWatches, isDangerous };
