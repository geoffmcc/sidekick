"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { parsePolicyList, sourceEnvName } = require("./policy-env");
const pathPolicy = require("../tools/path-policy");

const DEFAULT_BWRAP = "/usr/bin/bwrap";
const MAX_COMMAND_LENGTH = 65536;
const MAX_TMPFS_BYTES = 256 * 1024 * 1024;
const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SYSTEM_MOUNTS = ["/usr", "/bin", "/lib", "/lib64", "/sbin"];

function isolationError(message, code = "isolation_unavailable") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasSingleUnprivilegedUidMap() {
  try {
    const lines = fs.readFileSync("/proc/self/uid_map", "utf8").trim().split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) return false;
    const [namespaceStart, hostStart, length] = lines[0].trim().split(/\s+/).map(Number);
    return namespaceStart >= 0 && hostStart >= 0 && length === 1;
  } catch {
    return false;
  }
}

function isImmutableRootSystemPath(resolved) {
  if (resolved !== DEFAULT_BWRAP || !hasSingleUnprivilegedUidMap()) return false;
  let current = resolved;
  while (current !== path.dirname(current)) {
    try {
      const stat = fs.statSync(current);
      // In a one-ID unprivileged mapping, host root-owned system files and
      // directories appear as overflow UID 65534. Never accept a path mapped
      // to the service UID inside that namespace.
      if (stat.uid !== 65534 || (stat.mode & 0o022) !== 0) return false;
    } catch {
      return false;
    }
    current = path.dirname(current);
  }
  return true;
}

function resolveBubblewrap(binaryPath = process.env.SIDEKICK_BWRAP_PATH || DEFAULT_BWRAP) {
  if (process.platform !== "linux") {
    throw isolationError(`OS-enforced bash isolation is unavailable on ${process.platform}; command execution was not started`);
  }
  if (typeof binaryPath !== "string" || !path.isAbsolute(binaryPath)) {
    throw isolationError("SIDEKICK_BWRAP_PATH must be an absolute path to a trusted bubblewrap binary", "isolation_configuration_invalid");
  }

  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(binaryPath);
    stat = fs.statSync(resolved);
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    throw isolationError("The required bubblewrap executable is unavailable; command execution was not started");
  }
  const trustedOwner = stat.uid === 0 || (stat.uid === 65534 && isImmutableRootSystemPath(resolved));
  if (!stat.isFile() || !trustedOwner || (stat.mode & 0o022) !== 0) {
    throw isolationError("The bubblewrap executable must be a root-owned, non-writable regular file; command execution was not started", "isolation_configuration_invalid");
  }
  return resolved;
}

function getDeniedRoots(source) {
  return [
    ...parsePolicyList(process.env.SIDEKICK_DENIED_PATHS),
    ...parsePolicyList(process.env[sourceEnvName(source, "DENIED_PATHS")]),
  ];
}

function resolveWorkspace(workspace, source = "mcp") {
  if (workspace === undefined || workspace === null || workspace === "") return null;
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    throw isolationError("workspace_path must be an absolute path", "workspace_invalid");
  }

  const decision = pathPolicy.getPathPolicyDecision(workspace, "execute", source);
  if (!decision.allowed) {
    throw isolationError(`Workspace is not authorized for shell execution: ${decision.reason}`, "workspace_denied");
  }

  let canonical;
  let stat;
  try {
    canonical = fs.realpathSync(workspace);
    stat = fs.statSync(canonical);
  } catch {
    throw isolationError("workspace_path must name an existing directory", "workspace_invalid");
  }
  if (!stat.isDirectory()) throw isolationError("workspace_path must name an existing directory", "workspace_invalid");

  // A bind of a directory exposes all descendants, so refuse rather than
  // accidentally bypassing a narrower operator deny root inside it.
  for (const deniedRoot of getDeniedRoots(source)) {
    if (
      pathPolicy.pathMatchesPolicyEntry(canonical, deniedRoot) ||
      pathPolicy.pathMatchesPolicyEntry(deniedRoot, canonical)
    ) {
      throw isolationError("workspace_path overlaps a denied filesystem root", "workspace_denied");
    }
  }
  return canonical;
}

function buildBubblewrapArgs({ command, workspace = null, source = "mcp", binaryPath = DEFAULT_BWRAP } = {}) {
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
    throw isolationError("command must be a non-empty string within the shell command size limit", "command_invalid");
  }
  const executable = resolveBubblewrap(binaryPath);
  const canonicalWorkspace = resolveWorkspace(workspace, source);
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop", "ALL",
    "--json-status-fd", "3",
    "--clearenv",
    "--setenv", "PATH", SANDBOX_PATH,
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8",
  ];

  for (const mount of SYSTEM_MOUNTS) {
    if (fs.existsSync(mount)) args.push("--ro-bind", mount, mount);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--size", String(MAX_TMPFS_BYTES), "--tmpfs", "/tmp", "--dir", "/tmp/home");
  if (canonicalWorkspace) args.push("--bind", canonicalWorkspace, "/workspace");
  else args.push("--dir", "/workspace");
  args.push("--chdir", "/workspace", "--", "/bin/sh", "-c", command);
  return { executable, args, workspace: canonicalWorkspace };
}

async function runBubblewrap({ command, workspace = null, source = "mcp", timeoutMs, signal, maxBuffer = 10 * 1024 * 1024 } = {}) {
  const invocation = buildBubblewrapArgs({ command, workspace, source });
  const timeout = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 3600000) : 60000;
  const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(invocation.executable, invocation.args, {
        env,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(isolationError("The required bubblewrap executable could not be started; command execution was not started"));
      return;
    }

    let stdout = "";
    let stderr = "";
    let statusBuffer = "";
    let childStarted = false;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn(value);
    };
    const append = (current, chunk) => {
      const combined = current + chunk.toString("utf8");
      if (Buffer.byteLength(combined, "utf8") > maxBuffer) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return current;
      }
      return combined;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    const abort = () => child.kill("SIGKILL");
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(Object.assign(new Error("Shell execution cancelled"), { code: "ABORT_ERR" }));
      child.kill("SIGKILL");
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.stdio[3].on("data", chunk => {
      statusBuffer += chunk.toString("utf8");
      const lines = statusBuffer.split("\n");
      statusBuffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const status = JSON.parse(line);
          if (Number.isInteger(status["child-pid"])) childStarted = true;
        } catch { /* Ignore unknown or incomplete future status documents. */ }
      }
    });
    child.on("error", () => {
      finish(reject, isolationError("The required bubblewrap executable could not be started; command execution was not started"));
    });
    child.on("close", (code, childSignal) => {
      if (statusBuffer.trim()) {
        try {
          const status = JSON.parse(statusBuffer.trim());
          if (Number.isInteger(status["child-pid"])) childStarted = true;
        } catch { /* Ignore malformed final status. */ }
      }
      if (!childStarted) {
        const diagnostic = String(stderr || "").replace(/[\r\n\t]+/g, " ").slice(0, 300);
        const detail = diagnostic ? ` (${diagnostic})` : "";
        finish(reject, isolationError(`OS sandbox initialization failed; command execution was not started${detail}`, "sandbox_initialization_failed"));
        return;
      }
      if (timedOut || outputExceeded || signal?.aborted) {
        finish(resolve, {
          stdout,
          stderr,
          exitCode: null,
          signal: childSignal || "SIGKILL",
          timedOut,
          outputExceeded,
          cancelled: Boolean(signal?.aborted),
        });
        return;
      }
      finish(resolve, { stdout, stderr, exitCode: Number.isInteger(code) ? code : 1, signal: childSignal || null });
    });
  });
}

module.exports = Object.freeze({
  DEFAULT_BWRAP,
  MAX_COMMAND_LENGTH,
  MAX_TMPFS_BYTES,
  resolveBubblewrap,
  resolveWorkspace,
  buildBubblewrapArgs,
  runBubblewrap,
});
