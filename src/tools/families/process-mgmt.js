"use strict";

// Process and service management tool family: process, service, archive.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, the shared
// redaction utility, and the shared filesystem path policy — never on
// tools-legacy.js. `process` and `service` are `high` risk (they can kill
// processes and control systemd via sudo); those classifications are preserved
// from src/tools/metadata.js and gated by the dispatcher. Command arguments are
// passed to execFileSync as arrays (no shell string), and all output is passed
// through redactSensitive before return.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");

async function sidekick_process({ action, filter, pid, name, signal }) {
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
    const sig = signal || "TERM";
    if (pid) {
      cmd = ["kill", ["-" + sig, String(pid)]];
    } else {
      cmd = ["pkill", ["-" + sig, name]];
    }
  } else if (action === "tree") {
    cmd = ["pstree", ["-p"]];
  }

  try {
    let stdout = execFileSync(cmd[0], cmd[1], { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
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
    cmd = ["journalctl", ["-u", service, "-n", String(n), "--no-pager"]];
  } else {
    if (!service) {
      return { content: [{ type: "text", text: "service required for " + action }], isError: true };
    }
    cmd = ["sudo", ["systemctl", action, service]];
  }

  try {
    const stdout = execFileSync(cmd[0], cmd[1], { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
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

  const sourcePolicyError = enforcePathPolicy(sourcePath, "read");
  if (sourcePolicyError) return sourcePolicyError;

  if (!fs.existsSync(sourcePath)) {
    return { content: [{ type: "text", text: "Path not found: " + sourcePath }], isError: true };
  }

  const fmt = format || "tar.gz";
  let cmd;

  if (action === "create") {
    if (!output) {
      return { content: [{ type: "text", text: "output required for create" }], isError: true };
    }
    const outputPolicyError = enforcePathPolicy(output, "write");
    if (outputPolicyError) return outputPolicyError;
    if (fmt === "tar.gz" || fmt === "tgz") {
      cmd = ["tar", ["-czf", output, "-C", path.dirname(sourcePath), path.basename(sourcePath)]];
    } else if (fmt === "zip") {
      cmd = ["zip", ["-r", output, sourcePath]];
    } else {
      return { content: [{ type: "text", text: "Invalid format. Use: tar.gz, tgz, or zip" }], isError: true };
    }
  } else if (action === "extract") {
    const extractTarget = process.cwd();
    const outputPolicyError = enforcePathPolicy(extractTarget, "write");
    if (outputPolicyError) return outputPolicyError;
    if (sourcePath.endsWith(".tar.gz") || sourcePath.endsWith(".tgz")) {
      cmd = ["tar", ["-xzf", sourcePath]];
    } else if (sourcePath.endsWith(".zip")) {
      cmd = ["unzip", [sourcePath]];
    } else {
      return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
    }
  } else if (action === "list") {
    if (sourcePath.endsWith(".tar.gz") || sourcePath.endsWith(".tgz")) {
      cmd = ["tar", ["-tzf", sourcePath]];
    } else if (sourcePath.endsWith(".zip")) {
      cmd = ["unzip", ["-l", sourcePath]];
    } else {
      return { content: [{ type: "text", text: "Unsupported archive format" }], isError: true };
    }
  }

  try {
    const stdout = execFileSync(cmd[0], cmd[1], { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "OK") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
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

module.exports = { descriptors, sidekick_process, sidekick_service, sidekick_archive };
