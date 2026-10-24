"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { parsePolicyList, sourceEnvName } = require("./policy-env");
const pathPolicy = require("../tools/path-policy");

const DEFAULT_BWRAP = "/usr/bin/bwrap";
const MAX_COMMAND_LENGTH = 65536;
const MAX_TMPFS_BYTES = 256 * 1024 * 1024;
const DEFAULT_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BUFFER_BYTES = 50 * 1024 * 1024;
const COMMAND_LIMITS = Object.freeze({
  cpuSeconds: 300,
  // Bound virtual address space per process while leaving room for Node/V8,
  // JVM and ordinary build tools. This is a per-process ceiling; aggregate
  // cgroup accounting remains a separate deployment-level control.
  addressSpaceBytes: 8 * 1024 * 1024 * 1024,
  processes: 64,
  openFiles: 1024,
  fileBytes: 256 * 1024 * 1024,
});
const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SYSTEM_MOUNTS = ["/usr", "/bin", "/lib", "/lib64", "/sbin"];
const PRLIMIT = "/usr/bin/prlimit";

function normalizeOutputBufferLimit(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_OUTPUT_BUFFER_BYTES;
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_OUTPUT_BUFFER_BYTES));
}

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
  if (![DEFAULT_BWRAP, PRLIMIT].includes(resolved) || !hasSingleUnprivilegedUidMap()) return false;
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

function hasProtectedAncestors(resolved, fsImpl = fs) {
  let current = path.dirname(resolved);
  for (;;) {
    let stat;
    try { stat = fsImpl.statSync(current); } catch { return false; }
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
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
  const trustedPath = hasProtectedAncestors(resolved) || (stat.uid === 65534 && isImmutableRootSystemPath(resolved));
  if (!stat.isFile() || !trustedOwner || !trustedPath || (stat.mode & 0o022) !== 0) {
    throw isolationError("The bubblewrap executable and its parent directories must be root-owned and non-writable; command execution was not started", "isolation_configuration_invalid");
  }
  return resolved;
}

function resolvePrlimit() {
  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(PRLIMIT);
    stat = fs.statSync(resolved);
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    throw isolationError("The required Linux resource-limit utility is unavailable; command execution was not started");
  }
  const trustedOwner = stat.uid === 0 || (stat.uid === 65534 && isImmutableRootSystemPath(resolved));
  const trustedPath = hasProtectedAncestors(resolved) || (stat.uid === 65534 && isImmutableRootSystemPath(resolved));
  if (!stat.isFile() || !trustedOwner || !trustedPath || (stat.mode & 0o022) !== 0) {
    throw isolationError("The Linux resource-limit utility and its parent directories must be root-owned and non-writable; command execution was not started", "isolation_configuration_invalid");
  }
  return resolved;
}

function getDeniedRoots(source) {
  return [
    ...parsePolicyList(process.env.SIDEKICK_DENIED_PATHS),
    ...parsePolicyList(process.env[sourceEnvName(source, "DENIED_PATHS")]),
  ];
}

function openAuthorizedWorkspace(workspace, source = "mcp") {
  if (workspace === undefined || workspace === null || workspace === "") return null;
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    throw isolationError("workspace_path must be an absolute path", "workspace_invalid");
  }

  let fd;
  try {
    const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;
    fd = fs.openSync(workspace, directoryFlags);
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) throw new Error("workspace is not a directory");

    // Resolve and authorize the object held by the descriptor, not the caller's
    // path. Bubblewrap receives this same open descriptor below, so replacing
    // a path component after authorization cannot redirect the mount.
    const canonical = fs.realpathSync(`/proc/self/fd/${fd}`);
    const decision = pathPolicy.getPathPolicyDecision(canonical, "execute", source);
    if (!decision.allowed) {
      throw isolationError(`Workspace is not authorized for shell execution: ${decision.reason}`, "workspace_denied");
    }

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
    return { path: canonical, fd };
  } catch (error) {
    if (Number.isInteger(fd)) {
      try { fs.closeSync(fd); } catch {}
    }
    if (error && ["workspace_denied", "workspace_invalid"].includes(error.code)) throw error;
    throw isolationError("workspace_path must name an existing authorized directory", "workspace_invalid");
  }
}

function resolveWorkspace(workspace, source = "mcp") {
  const binding = openAuthorizedWorkspace(workspace, source);
  if (!binding) return null;
  try { return binding.path; }
  finally { fs.closeSync(binding.fd); }
}

function validateCommand(command) {
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
    throw isolationError("command must be a non-empty string within the shell command size limit", "command_invalid");
  }
}

function buildPrlimitArgs(command) {
  validateCommand(command);
  return [
    `--cpu=${COMMAND_LIMITS.cpuSeconds}:${COMMAND_LIMITS.cpuSeconds}`,
    `--as=${COMMAND_LIMITS.addressSpaceBytes}:${COMMAND_LIMITS.addressSpaceBytes}`,
    `--nproc=${COMMAND_LIMITS.processes}:${COMMAND_LIMITS.processes}`,
    `--nofile=${COMMAND_LIMITS.openFiles}:${COMMAND_LIMITS.openFiles}`,
    `--fsize=${COMMAND_LIMITS.fileBytes}:${COMMAND_LIMITS.fileBytes}`,
    "--core=0:0",
    "--", "/bin/sh", "-c", command,
  ];
}

function buildBubblewrapArgs({ command, workspace = null, workspaceFd = null, source = "mcp", binaryPath = DEFAULT_BWRAP } = {}) {
  validateCommand(command);
  const executable = resolveBubblewrap(binaryPath);
  resolvePrlimit();
  const canonicalWorkspace = resolveWorkspace(workspace, source);
  if (canonicalWorkspace && workspaceFd !== 4) {
    throw isolationError("An authorized open workspace descriptor is required; command execution was not started", "workspace_invalid");
  }
  return composeBubblewrapArgs({ command, canonicalWorkspace, workspaceFd, executable });
}

function composeBubblewrapArgs({ command, canonicalWorkspace, workspaceFd, executable }) {
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
  if (canonicalWorkspace) args.push("--bind-fd", String(workspaceFd), "/workspace");
  else args.push("--dir", "/workspace");
  args.push(
    "--chdir", "/workspace", "--", PRLIMIT,
    ...buildPrlimitArgs(command),
  );
  return { executable, args, workspace: canonicalWorkspace };
}

async function runBubblewrap({ command, workspace = null, source = "mcp", timeoutMs, signal, maxBuffer = DEFAULT_OUTPUT_BUFFER_BYTES } = {}) {
  validateCommand(command);
  const outputBufferLimit = normalizeOutputBufferLimit(maxBuffer);
  const executable = resolveBubblewrap();
  resolvePrlimit();
  const workspaceBinding = openAuthorizedWorkspace(workspace, source);
  let invocation;
  try {
    invocation = composeBubblewrapArgs({
      command,
      canonicalWorkspace: workspaceBinding?.path || null,
      workspaceFd: workspaceBinding ? 4 : null,
      executable,
    });
  } catch (error) {
    if (workspaceBinding) fs.closeSync(workspaceBinding.fd);
    throw error;
  }
  const timeout = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 3600000) : 60000;
  const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
  return new Promise((resolve, reject) => {
    let child;
    try {
      const stdio = ["ignore", "pipe", "pipe", "pipe"];
      if (workspaceBinding) stdio.push(workspaceBinding.fd);
      child = spawn(invocation.executable, invocation.args, {
        env,
        stdio,
        windowsHide: true,
      });
    } catch {
      if (workspaceBinding) fs.closeSync(workspaceBinding.fd);
      reject(isolationError("The required bubblewrap executable could not be started; command execution was not started"));
      return;
    }
    if (workspaceBinding) fs.closeSync(workspaceBinding.fd);

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
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
      if (outputBytes + chunk.length > outputBufferLimit) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return current;
      }
      outputBytes += chunk.length;
      const combined = current + chunk.toString("utf8");
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
  DEFAULT_OUTPUT_BUFFER_BYTES,
  MAX_OUTPUT_BUFFER_BYTES,
  COMMAND_LIMITS,
  buildPrlimitArgs,
  composeBubblewrapArgs,
  normalizeOutputBufferLimit,
  hasProtectedAncestors,
  resolveBubblewrap,
  resolvePrlimit,
  resolveWorkspace,
  buildBubblewrapArgs,
  runBubblewrap,
});
