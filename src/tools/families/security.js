"use strict";

// Security tool family: security_scan, sandbox, anonymize.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, zod,
// shared non-legacy modules (security-scan, redact, path-policy) and a lazy
// yaml require in anonymize's format path — never on tools-legacy.js. All
// handlers and helpers move verbatim. `sandbox` is `critical` risk
// (arbitrary command execution against sandboxed file copies); risk
// classifications are preserved from src/tools/metadata.js and gated by the
// dispatcher. The sandboxes directory mkdir moves here with its cluster.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy, getPathPolicyDecision } = require("../path-policy");
const { scanSecurityConfig } = require("../../security-scan");
const { childProcessEnv } = require("../../security/child-process");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "..", "data");

async function sidekick_security_scan({ path: rootPath, max_files, format } = {}) {
  // Re-based on extraction: __dirname moved from src/ to src/tools/families/,
  // so the repo-root default needs three levels up, not one.
  const scanRoot = path.resolve(rootPath || process.env.SIDEKICK_REPO_DIR || path.join(__dirname, "..", "..", ".."));
  const policyError = enforcePathPolicy(scanRoot, "security_scan");
  if (policyError) return policyError;
  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    return { content: [{ type: "text", text: "Scan directory not found: " + scanRoot }], isError: true };
  }

  const report = scanSecurityConfig({
    root: scanRoot,
    maxFiles: max_files,
    canAccess: target => getPathPolicyDecision(target, "security_scan").allowed
  });
  if (format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }

  const lines = [
    "SECURITY CONFIG SCAN",
    "Root: " + report.root,
    "Files scanned: " + report.files_scanned,
    "Skipped by path policy: " + report.skipped_by_policy,
    "Truncated: " + (report.truncated ? "yes" : "no"),
    `Findings: ${report.findings.length} (critical=${report.counts.critical}, high=${report.counts.high}, medium=${report.counts.medium}, low=${report.counts.low})`
  ];
  for (const finding of report.findings) {
    const location = finding.path + (finding.line ? ":" + finding.line : "");
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.type} ${location} - ${finding.message}`);
  }
  if (report.findings.length === 0) lines.push("No config or secret handling findings.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
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
      return { content: [{ type: "text", text: "No custom patterns defined.\n\nBuilt-in patterns:\n- IPv4 addresses → 10.0.0.x\n- Email addresses → user{n}@example.com\n- UUIDs → 00000000-0000-0000-0000-{n}\n- Phone numbers → 555-000-XXXX\n- File paths (/home/user, /Users/user) → /home/user{n}\n- Hostnames (*.com, *.org, etc.) → host-{n}.internal\n- SSH private keys → [REDACTED]\n- GitHub tokens → [REDACTED]\n- API keys → [REDACTED]\n- AWS keys → [REDACTED]\n- Passwords/secrets → [REDACTED]\n- Bearer tokens → [REDACTED]\n- Database connection strings → [REDACTED]\n- Stripe keys → [REDACTED]\n- JWT tokens → [REDACTED]" }] };
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
          const readPolicyError = enforcePathPolicy(f, "read");
          if (readPolicyError) return readPolicyError;
          const writePolicyError = enforcePathPolicy(f, "write");
          if (writePolicyError) return writePolicyError;
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
      output = execSync(command, { timeout: 30000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024, env: childProcessEnv() });
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

    for (const backup of sb.backups) {
      const policyError = enforcePathPolicy(backup.original, "write");
      if (policyError) return policyError;
    }
    for (const nf of sb.newFiles) {
      const policyError = enforcePathPolicy(nf.path, "delete");
      if (policyError) return policyError;
    }

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

const SCHEMAS = {
  security_scan: z.object({
    path: z.string().optional().describe("Directory to scan (default Sidekick repository)"),
    max_files: z.number().int().min(1).max(10000).optional().describe("Maximum files to inspect (default 2000, maximum 10000)"),
    format: z.enum(["text", "json"]).optional().describe("Output format (default text)")
  }),
  anonymize: z.object({
    action: z.enum(["anonymize", "patterns", "add_pattern", "remove_pattern"]),
    input: z.string().optional().describe("Text to anonymize"),
    format: z.enum(["text", "json", "yaml"]).optional().default("text"),
    custom_patterns: z.array(z.object({
      pattern: z.string(),
      replacement: z.string()
    })).optional(),
    consistency: z.boolean().optional().default(true).describe("Same input always maps to same output")
  }),
  sandbox: z.object({
    action: z.enum(["exec", "rollback", "list", "diff", "clean"]),
    sandbox_name: z.string().optional(),
    command: z.string().optional().describe("Command to execute in sandbox"),
    files: z.array(z.string()).optional().describe("Files to auto-backup before exec"),
    auto_backup: z.boolean().optional().default(true),
    rollback_id: z.string().optional()
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "security_scan",
    description: "Read-only audit for tracked sensitive files, secret signatures, hardcoded credential settings, runtime .env safety, and sensitive-file permissions. Reports metadata only and never returns secret values.",
    schema: SCHEMAS.security_scan,
    args: { path: "string (optional, directory to scan - default Sidekick repo)", max_files: "number (optional, bounded 1-10000 - default 2000)", format: "string (optional, text|json - default text)" },
    risk: "low",
    category: "Security",
    source: "builtin",
    family: "security",
    handler: sidekick_security_scan,
  }),
  Object.freeze({
    name: "anonymize",
    description: "Replace sensitive data with realistic but fake values. Preserves data structure while making it safe to share externally.",
    schema: SCHEMAS.anonymize,
    args: { action: "string (anonymize|patterns|add_pattern|remove_pattern)", input: "string (optional, text to anonymize)", format: "string (optional, text|json|yaml - default text)", custom_patterns: "array (optional, {pattern, replacement} objects)", consistency: "boolean (optional, same input always maps to same output - default true)" },
    risk: "low",
    category: "Data Pipeline",
    source: "builtin",
    family: "security",
    handler: sidekick_anonymize,
  }),
  Object.freeze({
    name: "sandbox",
    description: "Execute operations in a tracked context with automatic backup and rollback. Safe experimentation on remote systems.",
    schema: SCHEMAS.sandbox,
    args: { action: "string (exec|rollback|list|diff|clean)", sandbox_name: "string (optional, sandbox identifier)", command: "string (optional, command to execute)", files: "array (optional, files to auto-backup before exec)", auto_backup: "boolean (optional, default true)", rollback_id: "string (optional, sandbox to rollback)" },
    risk: "critical",
    category: "Security",
    source: "builtin",
    family: "security",
    handler: sidekick_sandbox,
  }),
]);

module.exports = { descriptors, sidekick_security_scan, sidekick_anonymize, sidekick_sandbox };
