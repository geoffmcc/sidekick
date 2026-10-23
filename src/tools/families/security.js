"use strict";

// Security tool family: security_scan, sandbox, anonymize.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, zod,
// shared non-legacy modules (security-scan, redact, path-policy) and a lazy
// yaml require in anonymize's format path — never on tools-legacy.js. All
// handlers and helpers move verbatim. `sandbox` is `critical` risk
// (tracked host file changes; command execution disabled without OS isolation); risk
// classifications are preserved from src/tools/metadata.js and gated by the
// dispatcher. The sandboxes directory mkdir moves here with its cluster.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { z } = require("zod");
const { performance } = require("node:perf_hooks");
const { BoundedRegex } = require("../../core/bounded-regex");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy, getPathPolicyDecision } = require("../path-policy");
const { scanSecurityConfig } = require("../../security-scan");
const { errorResult } = require("../result");
const toolContext = require("../context");
const { requireCanonicalInvocation, requireToolExecution } = require("../read-authorization");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "..", "data");

async function sidekick_security_scan({ path: rootPath, max_files, format } = {}) {
  const authError = requireToolExecution({ tool: "security_scan" }, "tools.execute", "security_scan");
  if (authError) return authError;
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
    const regexDeadline = performance.now() + 500;
    for (const cp of customPatterns) {
      const regex = new BoundedRegex(cp.pattern, "", { deadline: regexDeadline });
      result = regex.replace(result, cp.replacement);
    }
  }

  const stored = loadAnonymizePatterns();
  const regexDeadline = performance.now() + 500;
  for (const sp of stored.patterns) {
    const regex = new BoundedRegex(sp.pattern, "", { deadline: regexDeadline });
    result = regex.replace(result, sp.replacement);
  }

  result = redactSensitive(result);

  return result;
}

async function sidekick_anonymize({ action, input, format, custom_patterns, consistency }) {
  if (["patterns", "add_pattern", "remove_pattern"].includes(action)) {
    const dispatchError = requireCanonicalInvocation("anonymize");
    if (dispatchError) return dispatchError;
    const authorization = require("../../core/authorization");
    const execution = toolContext.getExecutionContext();
    const permission = ["add_pattern", "remove_pattern"].includes(action) ? "tools.execute_high" : "tools.execute";
    if (!execution.authIdentity?.principal_id) {
      if (execution.source !== "test") return errorResult("Authenticated principal required for anonymization pattern access", "unauthenticated");
    } else {
      const decision = authorization.authorize({
        principalId: execution.authIdentity.principal_id,
        permission,
        credentialScopes: execution.authIdentity.scopes,
        delegationId: execution.authIdentity.delegation_id || execution.authIdentity.delegationId || null,
        resource: { tool: "anonymize", action },
      });
      if (!decision.ok) return errorResult(`Anonymization pattern access denied: ${decision.code}`, "authorization_denied");
    }
  }

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
        new BoundedRegex(cp.pattern);
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
const SANDBOX_TTL_HOURS = 24;

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

async function sidekick_sandbox({ action, sandbox_name, rollback_id }) {
  const authorizationError = requireToolExecution({ tool: "sandbox", action: action || null }, "tools.execute_critical", "sandbox");
  if (authorizationError) return authorizationError;
  // Backups and rollback do not isolate host commands. Refuse before reading
  // or mutating sandbox state until an OS-enforced backend is available.
  if (action === "exec") {
    return errorResult(
      "Sandbox command execution is unavailable because no OS-enforced isolation backend is configured. Use a separately governed command operation only when its host effects are intended.",
      "isolation_unavailable",
      { status: "unavailable", subsystem: "execution_isolation" }
    );
  }

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
      pattern: z.string().max(512),
      replacement: z.string().max(4096)
    })).max(20).optional(),
    consistency: z.boolean().optional().default(true).describe("Same input always maps to same output")
  }),
  sandbox: z.object({
    action: z.enum(["exec", "rollback", "list", "diff", "clean"]),
    sandbox_name: z.string().optional(),
    command: z.string().optional().describe("Legacy parameter; exec is unavailable until OS-enforced isolation is configured"),
    files: z.array(z.string()).optional().describe("Legacy parameter; exec is unavailable until OS-enforced isolation is configured"),
    auto_backup: z.boolean().optional().default(true).describe("Legacy parameter; exec is unavailable until OS-enforced isolation is configured"),
    rollback_id: z.string().optional()
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "security_scan",
    description: "Read-only audit for tracked sensitive files, secret signatures, hardcoded credential settings, runtime .env safety, and sensitive-file permissions. Reports metadata only and never returns secret values.",
    schema: SCHEMAS.security_scan,
    args: { path: "string (optional, directory to scan - default Sidekick repo)", max_files: "number (optional, bounded 1-10000 - default 2000)", format: "string (optional, text|json - default text)" },
    risk: "medium",
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
    risk: "high",
    category: "Data Pipeline",
    source: "builtin",
    family: "security",
    handler: sidekick_anonymize,
  }),
  Object.freeze({
    name: "sandbox",
    description: "Inspect and manage tracked backup/rollback records. Command execution is unavailable until an OS-enforced isolation backend is configured; backups are not a sandbox.",
    schema: SCHEMAS.sandbox,
    args: { action: "string (rollback|list|diff|clean); exec returns isolation_unavailable", sandbox_name: "string (optional, sandbox identifier)", command: "string (legacy; execution unavailable)", files: "array (legacy; execution unavailable)", auto_backup: "boolean (legacy; execution unavailable)", rollback_id: "string (optional, sandbox to rollback)" },
    risk: "critical",
    category: "Security",
    source: "builtin",
    family: "security",
    handler: sidekick_sandbox,
  }),
]);

module.exports = { descriptors, sidekick_security_scan, sidekick_anonymize, sidekick_sandbox };
