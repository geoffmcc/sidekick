"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// These are the application credentials that must be supplied through a secret
// file. Other environment variables remain ordinary configuration.
const FILE_SECRET_NAMES = new Set([
  "SIDEKICK_API_KEY",
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
  "COMPUTE_TOKEN",
  "SIDEKICK_COMPUTE_LIVE_API_KEY",
  "SIDEKICK_BOOTSTRAP_TOKEN"
]);

const SECRET_FILE_NAMES = Object.freeze({
  SIDEKICK_API_KEY: "sidekick_api_key",
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
  COMPUTE_TOKEN: "compute_token",
  SIDEKICK_COMPUTE_LIVE_API_KEY: "sidekick_compute_live_api_key",
  SIDEKICK_BOOTSTRAP_TOKEN: "sidekick_bootstrap_token"
});

function isWindows() {
  return os.platform() === "win32";
}

function assertSafeFile(filePath, name) {
  if (!path.isAbsolute(filePath)) throw new Error(`${name} secret path must be absolute`);
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw new Error(`${name} secret file is unavailable`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${name} secret file must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${name} secret path is not a regular file`);

  // On POSIX, reject group/world-writable secret files. Readability for the
  // service account is intentionally allowed because Docker secrets commonly
  // use a read-only mount with a non-0600 mode.
  if (!isWindows() && (stat.mode & 0o022) !== 0) {
    throw new Error(`${name} secret file is writable by group or other users`);
  }
  return resolved;
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
    let resolved;
    try {
      resolved = assertSafeFile(filePath, name);
    } catch (error) {
      // A shared secret directory may legitimately omit optional integrations.
      // Explicit per-secret paths and required credentials always fail closed.
      if (!explicitFile && !options.required && /secret file is unavailable$/.test(error.message)) return "";
      throw error;
    }
    let value;
    try {
      value = fs.readFileSync(resolved, { encoding: "utf8", flag: "r" });
    } catch (error) {
      throw new Error(`${name} secret file could not be read`);
    }
    if (Buffer.byteLength(value, "utf8") > 16384) throw new Error(`${name} secret file is too large`);
    value = value.replace(/\r?\n$/, "");
    if (!value || value.includes("\0")) throw new Error(`${name} secret file is invalid`);
    return value;
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

module.exports = { FILE_SECRET_NAMES, SECRET_FILE_NAMES, readSecret, hasSecret, isFileBacked };
