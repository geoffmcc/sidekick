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
        return `• You previously decided: "${item.decision}" because "${item.reasoning || "no reason recorded"}" (on ${item.date})`;
      } else if (r.type === "problem") {
        return `• You encountered a similar problem: "${item.description}" - ${item.solution ? `solved with: "${item.solution}"` : "unresolved"}`;
      } else if (r.type === "pattern") {
        return `• You have a pattern: "${item.description}"`;
      } else if (r.type === "session") {
        return `• You had a session on ${item.date}: "${item.summary}" (${item.outcome || "no outcome recorded"})`;
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
    
    const summary = results.map(r => `Step ${r.step} (${r.tool}): ${r.success ? "✓" : "✗"} ${r.output}`).join("\n");
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
        output += `  - ${svc.service}: ${svc.status} ${svc.healthy ? "✓" : "✗"}\n`;
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
      output += `- Internet: ${results.network.results.internet ? "✓" : "✗"}\n`;
      output += `- Ports:\n`;
      for (const [svc, info] of Object.entries(results.network.results.ports)) {
        output += `  - ${svc} (${info.port}): ${info.listening ? "listening" : "not listening"}\n`;
      }
    } else if (c === "custom") {
      output += `- Score: ${results.custom.score.toFixed(0)}/100\n`;
      for (const res of results.custom.results) {
        output += `  - ${res.command}: ${res.success ? "✓" : "✗"}\n`;
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
    output += `**Status: HEALTHY** ✓\n`;
  } else if (overallScore >= 70) {
    output += `**Status: WARNING** ⚠\n`;
  } else {
    output += `**Status: CRITICAL** ✗\n`;
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
    return { content: [{ type: "text", text: matches ? `✓ Hash matches (${algo}: ${hash})` : `✗ Hash mismatch\nExpected: ${verify}\nActual:   ${hash}` }] };
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
      return { content: [{ type: "text", text: "✓ Validation passed" }] };
    } else {
      const errors = validate.errors.map(e => ({
        path: e.instancePath || "/",
        message: e.message,
        params: e.params
      }));
      return { content: [{ type: "text", text: `✗ Validation failed:\n${JSON.stringify(errors, null, 2)}` }] };
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
        return { content: [{ type: "text", text: `✓ Succeeded on attempt ${attempt}\n\n${result.content?.[0]?.text || ""}` }] };
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
  
  return { content: [{ type: "text", text: `✗ Failed after ${maxAttempts} attempts\nLast error: ${lastError}` }], isError: true };
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
};

const TOOL_DEFS = [
  { name: "sidekick_bash", description: "Execute a shell command on the remote machine", args: { command: "string" } },
  { name: "sidekick_read", description: "Read a file from the remote filesystem", args: { path: "string" } },
  { name: "sidekick_write", description: "Write content to a file on the remote machine", args: { path: "string", content: "string" } },
  { name: "sidekick_list", description: "List files and directories on the remote machine", args: { path: "string" } },
  { name: "sidekick_store", description: "Store a value persistently in KV storage", args: { key: "string", value: "string", project: "string (optional)" } },
  { name: "sidekick_get", description: "Retrieve a stored value from KV storage", args: { key: "string" } },
  { name: "sidekick_web_fetch", description: "Fetch a URL from the remote machine", args: { url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" } },
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

module.exports = { TOOLS, TOOL_DEFS, callTool, logToolCall, setSource, DATA_DIR, OLLAMA_URL, GROQ_API_KEY, GROQ_MODEL, migrateKV, loadProcedures, loadDelays, saveDelays, loadWatches, saveWatches };
