"use strict";

// Process and service management tool family: process, service, archive.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, the shared
// redaction utility, and the shared filesystem path policy — never on
// tools-legacy.js. `process` and `service` are `high` risk (they can kill
// processes and request systemd unit changes through systemd's polkit API;
// those classifications are preserved
// from src/tools/metadata.js and gated by the dispatcher. Command arguments are
// passed to execFileSync as arrays (no shell string), and all output is passed
// through redactSensitive before return.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { childProcessEnv } = require("../../security/child-process");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");
const { requireToolExecution } = require("../read-authorization");
const { createArchiveSnapshot } = require("../archive-snapshot");

const MAX_ARCHIVE_ENTRIES = 10000;
const MAX_ARCHIVE_DESTINATION_COMPONENTS = 100000;
const ALLOWED_SERVICE_NAMES = Object.freeze([
  "sidekick-mcp", "sidekick-dashboard", "sidekick-agent", "sidekick-postgres",
  "sidekick-redis", "sidekick-qdrant", "sidekick-influxdb", "sidekick-grafana",
  "sidekick-metrics.timer", "nginx"
]);
const ALLOWED_SERVICE_NAME_SET = new Set(ALLOWED_SERVICE_NAMES);
const ALLOWED_PROCESS_SIGNALS = new Set(["HUP", "INT", "QUIT", "KILL", "TERM", "USR1", "USR2", "STOP", "CONT"]);
// Archive utilities have their own option-bearing environment variables. They
// must not alter either the preflight listing or the eventual operation.
const ARCHIVE_ENV_OVERRIDES = Object.freeze({
  TAR_OPTIONS: null,
  GZIP: null,
  ZIPOPT: null,
  UNZIP: null,
  UNZIPOPT: null,
  ZIPINFO: null,
  ZIPINFOOPT: null,
});

function archiveProcessEnv() {
  return childProcessEnv(ARCHIVE_ENV_OVERRIDES);
}

function buildProcessKillCommand({ pid, name, signal }) {
  const selectedSignal = signal || "TERM";
  if (typeof selectedSignal !== "string" || !ALLOWED_PROCESS_SIGNALS.has(selectedSignal.toUpperCase())) {
    throw new Error("signal is outside the supported process signal allowlist");
  }
  const flag = `-${selectedSignal.toUpperCase()}`;
  if (pid !== undefined && pid !== null) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be a positive safe integer");
    if (name !== undefined && name !== null && name !== "") throw new Error("provide either pid or name, not both");
    return ["kill", [flag, "--", String(pid)]];
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 128 || /[\0\r\n]/.test(name)) {
    throw new Error("name must be a non-empty process name of at most 128 characters");
  }
  if (!name.trim()) throw new Error("name must not be whitespace");
  // pkill interprets its name argument as an extended regular expression.
  // Escape metacharacters and request a full-name match to avoid broad kills.
  const literalPattern = name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return ["pkill", [flag, "-x", "--", literalPattern]];
}

function normalizeManagedService(service) {
  if (typeof service !== "string") return null;
  const normalized = service.replace(/\.service$/, "");
  return ALLOWED_SERVICE_NAME_SET.has(normalized) ? normalized : null;
}

function validateArchiveEntryNames(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("archive entry list could not be verified");
  }
  const names = entries.length > 0 && entries[entries.length - 1] === "" ? entries.slice(0, -1) : entries;
  if (names.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`archive exceeds the ${MAX_ARCHIVE_ENTRIES}-entry validation limit`);
  }
  for (const entry of names) {
    const raw = String(entry || "").replace(/\r$/, "");
    // Listing-based preflight treats each line as one archive member. Control
    // characters can split or rewrite those records and make type/destination
    // checks inspect a different set of names than the extractor consumes.
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error("archive contains an invalid entry name");
    const normalized = raw.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
      throw new Error("archive contains an absolute entry path");
    }
    const components = normalized.split("/").filter(Boolean);
    if (components.includes("..")) throw new Error("archive contains a path traversal entry");
  }
  return true;
}

function validateArchiveEntryDestinations(root, entries) {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    throw new Error("archive destination could not be resolved");
  }
  let inspectedComponents = 0;
  const names = entries.length > 0 && entries[entries.length - 1] === "" ? entries.slice(0, -1) : entries;
  for (const entry of names) {
    const raw = String(entry || "").replace(/\r$/, "");
    const normalized = raw.replace(/\\/g, "/");
    const target = path.resolve(canonicalRoot, normalized);
    const relative = path.relative(canonicalRoot, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("archive destination escapes its extraction root");
    }
    let current = canonicalRoot;
    const components = relative.split(path.sep).filter(Boolean);
    inspectedComponents += components.length;
    if (inspectedComponents > MAX_ARCHIVE_DESTINATION_COMPONENTS) {
      throw new Error(`archive exceeds the ${MAX_ARCHIVE_DESTINATION_COMPONENTS}-component destination validation limit`);
    }
    for (let index = 0; index < components.length; index++) {
      current = path.join(current, components[index]);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw new Error("archive destination path could not be inspected");
      }
      if (stat.isSymbolicLink()) throw new Error("archive destination contains a symbolic link");
      if (index < components.length - 1 && !stat.isDirectory()) {
        throw new Error("archive destination path is not a directory");
      }
    }
  }
  return true;
}

function validateArchiveEntryTypes(listing) {
  if (typeof listing !== "string" || listing.length === 0) {
    throw new Error("archive member types could not be verified");
  }
  const lines = listing.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) throw new Error("archive member types could not be verified");

  for (const line of lines) {
    const match = /^([bcdhlps-])([rwxStTs-]{9})\s/.exec(line);
    if (!match) throw new Error("archive member type listing is invalid");
    if (match[1] !== "-" && match[1] !== "d") {
      throw new Error("archive contains a link or special file entry");
    }
  }
  return true;
}

function validateZipEntryTypes(listing) {
  if (typeof listing !== "string" || listing.length === 0) {
    throw new Error("zip member types could not be verified");
  }
  const normalized = listing.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const starts = [...normalized.matchAll(/^Central directory entry #\d+:\s*$/gim)].map(match => match.index);
  if (starts.length === 0) throw new Error("zip member metadata could not be verified");

  // Info-ZIP emits one verbose section per central-directory member. Unix
  // creator entries must expose their Unix mode; unknown or malformed metadata
  // fails closed rather than allowing an uninspected symlink through.
  for (let index = 0; index < starts.length; index++) {
    const section = normalized.slice(starts[index], starts[index + 1] ?? normalized.length);
    const origin = section.match(/^\s*file system or operating system of origin:\s*(.*?)\s*$/im);
    if (!origin || !origin[1]) throw new Error("zip member origin could not be verified");

    const attributeLines = [...section.matchAll(/^\s*Unix file attributes\s*\([^)]*\):\s*([bcdhlps-][rwxStTs-]{9})\s*$/gim)];
    if (attributeLines.length > 1 || (/unix/i.test(origin[1]) && attributeLines.length !== 1)) {
      throw new Error("zip member Unix attributes could not be verified");
    }
    if (attributeLines.length === 1) {
      const memberType = attributeLines[0][1][0];
      if (memberType !== "-" && memberType !== "d") {
        throw new Error("zip contains a link or special file entry");
      }
    }
  }
  return true;
}

function validateArchiveSourceType(stat, action) {
  if (!stat || typeof stat.isFile !== "function" || typeof stat.isDirectory !== "function") {
    return "archive source type could not be verified";
  }
  if (action === "create") {
    return stat.isFile() || stat.isDirectory()
      ? null
      : "archive creation source must be a regular file or directory";
  }
  return stat.isFile() ? null : "archive source must be a regular file";
}

async function sidekick_process({ action, filter, pid, name, signal }) {
  const denied = requireToolExecution({ tool: "process" }, "tools.execute_high", "process");
  if (denied) return denied;
  const allowedActions = ["list", "top", "kill", "tree"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  let cmd;
  if (action === "list") {
    cmd = ["ps", ["aux"]];
  } else if (action === "top") {
    cmd = ["ps", ["aux", "--sort=-%cpu"]];
  } else if (action === "kill") {
    if (!pid && !name) {
      return { content: [{ type: "text", text: "pid or name required for kill" }], isError: true };
    }
    try {
      cmd = buildProcessKillCommand({ pid, name, signal });
    } catch (error) {
      return { content: [{ type: "text", text: `Invalid process kill request: ${error.message}` }], isError: true };
    }
  } else if (action === "tree") {
    cmd = ["pstree", ["-p"]];
  }

  try {
    let stdout = execFileSync(cmd[0], cmd[1], { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, env: childProcessEnv() });
    if (action === "list" && filter) {
      const needle = String(filter).toLowerCase();
      stdout = stdout.split("\n").filter(line => line.toLowerCase().includes(needle)).join("\n");
    } else if (action === "top") {
      stdout = stdout.split("\n").slice(0, 20).join("\n");
    }
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    if (action === "kill" && e.status === 0) {
      return { content: [{ type: "text", text: "Process killed" }] };
    }
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
  }
}

async function sidekick_service({ action, service, lines }) {
  const denied = requireToolExecution({ tool: "service" }, "tools.execute_high", "service");
  if (denied) return denied;
  const allowedActions = ["start", "stop", "restart", "status", "enable", "disable", "logs"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const normalizedService = normalizeManagedService(service);
  if (!normalizedService) {
    return { content: [{ type: "text", text: "Service is outside the Sidekick-managed unit allowlist" }], isError: true };
  }
  if (["enable", "disable"].includes(action)) {
    return { content: [{ type: "text", text: "Service enablement changes are not available to the Sidekick service account; they require an administrator-managed unit-file operation" }], isError: true };
  }

  let cmd;
  if (action === "logs") {
    if (!service) {
      return { content: [{ type: "text", text: "service required for logs" }], isError: true };
    }
    const n = lines || 50;
    cmd = ["journalctl", ["-u", normalizedService, "-n", String(n), "--no-pager"]];
  } else {
    if (!service) {
      return { content: [{ type: "text", text: "service required for " + action }], isError: true };
    }
    cmd = ["systemctl", [action, normalizedService]];
  }

  try {
    const stdout = execFileSync(cmd[0], cmd[1], { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, env: childProcessEnv() });
    return { content: [{ type: "text", text: redactSensitive(stdout || "OK") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
  }
}

async function sidekick_archive({ action, path: sourcePath, output, format }) {
  const denied = requireToolExecution({ tool: "archive" }, "tools.execute", "archive");
  if (denied) return denied;
  const allowedActions = ["create", "extract", "list"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  if (!sourcePath) {
    return { content: [{ type: "text", text: "path required" }], isError: true };
  }

  const sourcePolicyError = enforcePathPolicy(sourcePath, "read");
  if (sourcePolicyError) return sourcePolicyError;

  if (!fs.existsSync(sourcePath)) {
    return { content: [{ type: "text", text: "Path not found: " + sourcePath }], isError: true };
  }

  let sourceAbsolute;
  try {
    sourceAbsolute = fs.realpathSync(sourcePath);
  } catch (error) {
    return { content: [{ type: "text", text: `Unable to resolve archive source: ${error.message}` }], isError: true };
  }
  const canonicalSourcePolicyError = enforcePathPolicy(sourceAbsolute, "read");
  if (canonicalSourcePolicyError) return canonicalSourcePolicyError;

  let sourceStat;
  try {
    sourceStat = fs.statSync(sourceAbsolute);
  } catch (error) {
    return { content: [{ type: "text", text: `Unable to inspect archive source: ${error.message}` }], isError: true };
  }
  const sourceTypeError = validateArchiveSourceType(sourceStat, action);
  if (sourceTypeError) return { content: [{ type: "text", text: sourceTypeError }], isError: true };

  let extractTarget;
  if (action === "extract") {
    if (!sourcePath.endsWith(".tar.gz") && !sourcePath.endsWith(".tgz") && !sourcePath.endsWith(".zip")) {
      return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
    }
    extractTarget = output ? path.resolve(output) : process.cwd();
    const outputPolicyError = enforcePathPolicy(extractTarget, "write");
    if (outputPolicyError) return outputPolicyError;
  }

  let snapshot = null;
  if (action === "extract") {
    try {
      snapshot = await createArchiveSnapshot(sourceAbsolute, sourcePath);
    } catch (error) {
      return { content: [{ type: "text", text: `Unable to stage archive source: ${error.message}` }], isError: true };
    }
  }
  const archiveSource = snapshot ? snapshot.path : sourceAbsolute;

  try {
    const fmt = format || "tar.gz";
    let cmd;

    if (action === "create") {
      if (!output) {
        return { content: [{ type: "text", text: "output required for create" }], isError: true };
      }
      const outputPolicyError = enforcePathPolicy(output, "write");
      if (outputPolicyError) return outputPolicyError;
      if (fmt === "tar.gz" || fmt === "tgz") {
        cmd = ["tar", ["-czf", path.resolve(output), "-C", path.dirname(sourceAbsolute), path.basename(sourceAbsolute)]];
      } else if (fmt === "zip") {
        cmd = ["zip", ["-r", path.resolve(output), sourceAbsolute]];
      } else {
        return { content: [{ type: "text", text: "Invalid format. Use: tar.gz, tgz, or zip" }], isError: true };
      }
    } else if (action === "extract") {
      try {
        if (sourcePath.endsWith(".tar.gz") || sourcePath.endsWith(".tgz")) {
          const listing = execFileSync("tar", ["-tzf", archiveSource], { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, env: archiveProcessEnv() });
          const entries = listing.split("\n");
          validateArchiveEntryNames(entries);
          const typeListing = execFileSync("tar", ["-tvzf", archiveSource], { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, env: archiveProcessEnv() });
          validateArchiveEntryTypes(typeListing);
          fs.mkdirSync(extractTarget, { recursive: true });
          const canonicalExtractTarget = fs.realpathSync(extractTarget);
          const canonicalOutputPolicyError = enforcePathPolicy(canonicalExtractTarget, "write");
          if (canonicalOutputPolicyError) throw new Error("archive destination is outside the allowed write scope");
          validateArchiveEntryDestinations(canonicalExtractTarget, entries);
          cmd = ["tar", ["-xzf", archiveSource, "-C", canonicalExtractTarget, "--no-same-owner", "--no-overwrite-dir"]];
        } else if (sourcePath.endsWith(".zip")) {
          const listing = execFileSync("unzip", ["-Z1", archiveSource], { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, env: archiveProcessEnv() });
          const entries = listing.split("\n");
          validateArchiveEntryNames(entries);
          const typeListing = execFileSync("unzip", ["-Z", "-v", archiveSource], { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, env: archiveProcessEnv() });
          validateZipEntryTypes(typeListing);
          fs.mkdirSync(extractTarget, { recursive: true });
          const canonicalExtractTarget = fs.realpathSync(extractTarget);
          const canonicalOutputPolicyError = enforcePathPolicy(canonicalExtractTarget, "write");
          if (canonicalOutputPolicyError) throw new Error("archive destination is outside the allowed write scope");
          validateArchiveEntryDestinations(canonicalExtractTarget, entries);
          cmd = ["unzip", [archiveSource, "-d", canonicalExtractTarget]];
        } else {
          return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
        }
      } catch (e) {
        const diagnostic = String(e.stderr || e.stdout || e.message).replaceAll(archiveSource, sourcePath);
        return { content: [{ type: "text", text: redactSensitive("Archive preflight failed: " + diagnostic) }], isError: true };
      }
    } else if (action === "list") {
      if (sourcePath.endsWith(".tar.gz") || sourcePath.endsWith(".tgz")) {
        cmd = ["tar", ["-tzf", sourceAbsolute]];
      } else if (sourcePath.endsWith(".zip")) {
        cmd = ["unzip", ["-l", sourceAbsolute]];
      } else {
        return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
      }
    }

    try {
      const stdout = execFileSync(cmd[0], cmd[1], { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, env: archiveProcessEnv() });
      return { content: [{ type: "text", text: redactSensitive((stdout || "OK").replaceAll(archiveSource, sourcePath)) }] };
    } catch (e) {
      const diagnostic = String(e.stderr || e.stdout || e.message).replaceAll(archiveSource, sourcePath);
      return { content: [{ type: "text", text: redactSensitive("Error: " + diagnostic) }], isError: true };
    }
  } finally {
    if (snapshot) await snapshot.cleanup();
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "process",
    description: "Manage processes (list, top CPU/memory, kill, tree)",
    schema: z.object({
      action: z.enum(["list", "top", "kill", "tree"]).describe("Process action to perform"),
      filter: z.string().optional().describe("Filter processes by name (for list action)"),
      pid: z.number().optional().describe("Process ID to kill"),
      name: z.string().optional().describe("Process name to kill (alternative to pid)"),
      signal: z.string().optional().describe("Signal to send when killing (default: TERM)"),
    }),
    args: { action: "string", filter: "string (optional)", pid: "number (optional)", name: "string (optional)", signal: "string (optional)" },
    risk: "high",
    category: "Services",
    source: "builtin",
    family: "process-mgmt",
    handler: sidekick_process,
  }),
  Object.freeze({
    name: "service",
    description: "Manage systemd services (start, stop, restart, status, enable, disable, logs)",
    schema: z.object({
      action: z.enum(["start", "stop", "restart", "status", "enable", "disable", "logs"]).describe("Service action to perform"),
      service: z.string().describe("Systemd service name"),
      lines: z.number().optional().describe("Number of log lines to show (default: 50)"),
    }),
    args: { action: "string", service: "string", lines: "number (optional)" },
    risk: "high",
    category: "Services",
    source: "builtin",
    family: "process-mgmt",
    handler: sidekick_service,
  }),
  Object.freeze({
    name: "archive",
    description: "Create, extract, or list archives (tar.gz, zip)",
    schema: z.object({
      action: z.enum(["create", "extract", "list"]).describe("Archive action to perform"),
      path: z.string().describe("Source path (file/directory for create, archive for extract/list)"),
      output: z.string().optional().describe("Output path (required for create)"),
      format: z.string().optional().describe("Archive format: tar.gz, tgz, or zip (default: tar.gz)"),
    }),
    args: { action: "string", path: "string", output: "string (optional)", format: "string (optional)" },
    risk: "medium",
    category: "Archive",
    source: "builtin",
    family: "process-mgmt",
    handler: sidekick_archive,
  }),
]);

module.exports = { descriptors, sidekick_process, sidekick_service, sidekick_archive, validateArchiveEntryNames, validateArchiveEntryDestinations, validateArchiveEntryTypes, validateZipEntryTypes, validateArchiveSourceType, archiveProcessEnv, MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_DESTINATION_COMPONENTS, normalizeManagedService, ALLOWED_SERVICE_NAMES, buildProcessKillCommand, ALLOWED_PROCESS_SIGNALS };
