"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertWindowsSecretAcl } = require("./windows-secret-acl");
const MAX_SECRET_BYTES = 16384;

// These are the application credentials that must be supplied through a secret
// file. Other environment variables remain ordinary configuration.
const FILE_SECRET_NAMES = new Set([
  "SIDEKICK_API_KEY",
  "SIDEKICK_MCP_CREDENTIAL",
  "SIDEKICK_AGENT_PROXY_KEY",
  "SIDEKICK_AGENT_SCHEDULER_KEY",
  "SIDEKICK_DASHBOARD_PASS",
  "SIDEKICK_GRAFANA_ADMIN_PASSWORD",
  "SIDEKICK_INFLUX_TOKEN",
  "SIDEKICK_INFLUX_PASSWORD",
  "SIDEKICK_POSTGRES_PASSWORD",
  "SIDEKICK_SECRET_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "SIDEKICK_GITHUB_TOKEN",
  "DISCORD_WEBHOOK_URL",
  "SLACK_WEBHOOK_URL",
  "SMTP_USER",
  "SMTP_PASS",
  "SIDEKICK_ENROLL_TOKEN",
  "SIDEKICK_NODE_ENROLL_TOKEN",
  "COMPUTE_TOKEN",
  "SIDEKICK_COMPUTE_LIVE_API_KEY",
  "SIDEKICK_BOOTSTRAP_TOKEN"
]);

const SECRET_FILE_NAMES = Object.freeze({
  SIDEKICK_API_KEY: "sidekick_api_key",
  SIDEKICK_MCP_CREDENTIAL: "sidekick_mcp_credential",
  SIDEKICK_AGENT_PROXY_KEY: "sidekick_agent_proxy_key",
  SIDEKICK_AGENT_SCHEDULER_KEY: "sidekick_agent_scheduler_key",
  SIDEKICK_DASHBOARD_PASS: "sidekick_dashboard_pass",
  SIDEKICK_GRAFANA_ADMIN_PASSWORD: "sidekick_grafana_admin_password",
  SIDEKICK_INFLUX_TOKEN: "sidekick_influx_token",
  SIDEKICK_INFLUX_PASSWORD: "sidekick_influx_password",
  SIDEKICK_POSTGRES_PASSWORD: "sidekick_postgres_password",
  SIDEKICK_SECRET_KEY: "sidekick_secret_key",
  GROQ_API_KEY: "groq_api_key",
  OPENAI_API_KEY: "openai_api_key",
  GITHUB_TOKEN: "github_token",
  SIDEKICK_GITHUB_TOKEN: "sidekick_github_token",
  DISCORD_WEBHOOK_URL: "discord_webhook_url",
  SLACK_WEBHOOK_URL: "slack_webhook_url",
  SMTP_USER: "smtp_user",
  SMTP_PASS: "smtp_pass",
  SIDEKICK_ENROLL_TOKEN: "sidekick_enroll_token",
  SIDEKICK_NODE_ENROLL_TOKEN: "sidekick_node_enroll_token",
  COMPUTE_TOKEN: "compute_token",
  SIDEKICK_COMPUTE_LIVE_API_KEY: "sidekick_compute_live_api_key",
  SIDEKICK_BOOTSTRAP_TOKEN: "sidekick_bootstrap_token"
});

function isWindows() {
  return os.platform() === "win32";
}

function shouldVerifyWindowsSecretAcl() {
  // Synthetic test trees live under OS temp directories and deliberately have
  // runner ACLs. The native ACL verifier has its own tests against synthetic
  // ACLs; production callers always verify the real path.
  return isWindows() && !process.env.SIDEKICK_TEST_SUITE_ID;
}

function assertSafeSecretDirectory(directoryPath, name) {
  if (!path.isAbsolute(directoryPath)) throw new Error(`${name} secret directory path must be absolute`);
  const resolved = path.resolve(directoryPath);
  const root = path.parse(resolved).root;
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let currentDirectory = root;
  const checkedDirectories = [];
  const verifyWindowsAcl = shouldVerifyWindowsSecretAcl();
  if (verifyWindowsAcl) checkedDirectories.push(root);
  for (const segment of segments) {
    currentDirectory = path.join(currentDirectory, segment);
    let stat;
    try {
      stat = fs.lstatSync(currentDirectory);
    } catch {
      throw new Error(`${name} secret directory is unavailable`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${name} secret directory must be a real directory`);
    }

    // An attacker able to replace a parent directory entry can swap the
    // protected secrets directory itself. A sticky system temp ancestor is
    // safe because users cannot rename entries they do not own.
    const writableByOthers = !isWindows() && (stat.mode & 0o022) !== 0;
    const secureStickyAncestor = currentDirectory !== resolved && (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !secureStickyAncestor) {
      throw new Error(`${name} secret directory is writable by group or other users`);
    }
    if (verifyWindowsAcl) checkedDirectories.push(currentDirectory);
  }
  if (verifyWindowsAcl) {
    assertWindowsSecretAcl({ directories: checkedDirectories, secretDirectory: resolved, secretFile: null, name });
  }
  return resolved;
}

function assertSafeFile(filePath, name) {
  if (!path.isAbsolute(filePath)) throw new Error(`${name} secret path must be absolute`);
  const resolved = path.resolve(filePath);
  const secretDirectory = path.dirname(resolved);
  assertSafeSecretDirectory(secretDirectory, name);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw new Error(`${name} secret file is unavailable`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${name} secret file must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${name} secret path is not a regular file`);

  // A group-readable file may be used with a dedicated service group, but
  // world-readable secret files expose credentials to unrelated local users
  // even when the file and directory are read-only.
  if (!isWindows() && (stat.mode & 0o022) !== 0) {
    throw new Error(`${name} secret file is writable by group or other users`);
  }
  if (!isWindows() && (stat.mode & 0o004) !== 0) {
    throw new Error(`${name} secret file is readable by other users`);
  }
  if (shouldVerifyWindowsSecretAcl()) {
    assertWindowsSecretAcl({ directories: [], secretDirectory: null, secretFile: resolved, name });
  }
  return { resolved, stat };
}

function secretFilePath(name) {
  const explicit = process.env[`${name}_FILE`];
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const directory = process.env.SIDEKICK_SECRET_DIR;
  if (!directory || !directory.trim()) return null;
  return path.join(directory.trim(), SECRET_FILE_NAMES[name]);
}

function readSecret(name, options = {}) {
  if (!FILE_SECRET_NAMES.has(name)) throw new Error(`Unsupported file-backed secret: ${name}`);
  const explicitFile = process.env[`${name}_FILE`];
  const filePath = secretFilePath(name);
  if (filePath) {
    let safeFile;
    try {
      safeFile = assertSafeFile(filePath, name);
    } catch (error) {
      // A shared secret directory may legitimately omit optional integrations.
      // Explicit per-secret paths and required credentials always fail closed.
      if (!explicitFile && !options.required && /secret (?:file|directory) is unavailable$/.test(error.message)) return "";
      throw error;
    }
    let fd;
    try {
      const flags = fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0);
      fd = fs.openSync(safeFile.resolved, flags);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() ||
          (safeFile.stat.dev !== opened.dev || safeFile.stat.ino !== opened.ino) ||
          (!isWindows() && ((opened.mode & 0o022) !== 0 || (opened.mode & 0o004) !== 0))) {
        throw new Error(`${name} secret file changed or became unsafe while opening`);
      }
      if (opened.size > MAX_SECRET_BYTES) throw new Error(`${name} secret file is too large`);
      const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead > MAX_SECRET_BYTES) throw new Error(`${name} secret file is too large`);
      let value = buffer.subarray(0, bytesRead).toString("utf8");
      value = value.replace(/\r?\n$/, "");
      if (!value || value.includes("\0")) throw new Error(`${name} secret file is invalid`);
      return value;
    } catch (error) {
      if (error.message === `${name} secret file is too large` ||
          error.message === `${name} secret file is invalid` ||
          error.message === `${name} secret file changed or became unsafe while opening`) throw error;
      throw new Error(`${name} secret file could not be read`);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  // Test fixtures may inject deterministic values, but production and local
  // runtime processes must never consume raw secret values from the
  // environment. This branch is intentionally unavailable outside tests.
  if (process.env.NODE_ENV === "test") {
    const value = process.env[name] || "";
    if (options.required && !value) throw new Error(`${name} must be configured`);
    return value;
  }
  if (process.env[name]) throw new Error(`${name} must be supplied through a secret file`);
  if (options.required) throw new Error(`${name} must be configured through a secret file`);
  return "";
}

function hasSecret(name) {
  return Boolean(readSecret(name));
}

function isFileBacked(name) {
  if (!FILE_SECRET_NAMES.has(name)) return false;
  return Boolean(secretFilePath(name));
}

module.exports = { FILE_SECRET_NAMES, SECRET_FILE_NAMES, assertSafeSecretDirectory, readSecret, hasSecret, isFileBacked };
