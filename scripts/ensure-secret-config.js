"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { verifyRequiredRuntimeSecrets } = require("./verify-runtime-secrets");

const SECRET_ENV_NAMES = Object.freeze([
  "SIDEKICK_API_KEY", "SIDEKICK_MCP_CREDENTIAL", "SIDEKICK_AGENT_PROXY_KEY", "SIDEKICK_AGENT_SCHEDULER_KEY",
  "SIDEKICK_DASHBOARD_PASS", "SIDEKICK_GRAFANA_ADMIN_PASSWORD", "SIDEKICK_INFLUX_TOKEN", "SIDEKICK_INFLUX_PASSWORD",
  "SIDEKICK_POSTGRES_PASSWORD", "SIDEKICK_SECRET_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN",
  "SIDEKICK_GITHUB_TOKEN", "DISCORD_WEBHOOK_URL", "SLACK_WEBHOOK_URL", "SMTP_USER", "SMTP_PASS",
  "SIDEKICK_ENROLL_TOKEN", "SIDEKICK_NODE_ENROLL_TOKEN", "COMPUTE_TOKEN", "SIDEKICK_COMPUTE_LIVE_API_KEY",
  "SIDEKICK_BOOTSTRAP_TOKEN",
]);
const MAX_ENV_BYTES = 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK || 0;

function assertRealDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be a real directory, not a symlink`);
  }
  return resolved;
}

function openEnvFile(filePath) {
  if (typeof NOFOLLOW !== "number") throw new Error("no-follow file opening is unavailable on this platform");
  const commonFlags = fs.constants.O_NOFOLLOW | NONBLOCK;
  try {
    return fs.openSync(filePath, fs.constants.O_RDWR | commonFlags);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    return fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | commonFlags, 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return fs.openSync(filePath, fs.constants.O_RDWR | commonFlags);
  }
}

function writeAll(descriptor, contents) {
  let offset = 0;
  while (offset < contents.length) {
    const written = fs.writeSync(descriptor, contents, offset, contents.length - offset, offset);
    if (written <= 0) throw new Error("failed to write the protected .env configuration");
    offset += written;
  }
}

function configureSecretDirectory(appDir, secretDir) {
  if (process.platform === "win32") throw new Error("no-follow secret configuration is supported on Linux deployment hosts");
  if (!path.isAbsolute(appDir)) throw new Error("application directory must be absolute");
  if (!path.isAbsolute(secretDir)) throw new Error("SIDEKICK_SECRET_DIR must be absolute");
  if (/[\r\n\0]/.test(secretDir)) throw new Error("SIDEKICK_SECRET_DIR contains an invalid character");

  const realAppDir = assertRealDirectory(appDir, "application directory");
  const envPath = path.join(realAppDir, ".env");
  const descriptor = openEnvFile(envPath);
  let original = "";
  let writeAttempted = false;
  let modified = false;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(".env must be a regular file with exactly one link");
    if (stat.size > MAX_ENV_BYTES) throw new Error(".env exceeds the configuration size limit");
    fs.fchmodSync(descriptor, 0o600);
    original = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(original, "utf8") > MAX_ENV_BYTES) throw new Error(".env exceeds the configuration size limit");

    for (const name of SECRET_ENV_NAMES) {
      const populated = new RegExp(`^[\\t ]*${name}=[^\\t\\r\\n #].*$`, "m");
      if (populated.test(original)) {
        throw new Error(`${name} is populated in .env; migrate it to ${secretDir} before deploying`);
      }
    }

    const lines = original.split(/\r?\n/);
    let foundSecretDir = false;
    const updatedLines = lines.map(line => {
      if (!/^SIDEKICK_SECRET_DIR=/.test(line)) return line;
      foundSecretDir = true;
      return `SIDEKICK_SECRET_DIR=${secretDir}`;
    });
    let updated = updatedLines.join("\n");
    if (!foundSecretDir) updated += `${updated && !updated.endsWith("\n") ? "\n" : ""}\nSIDEKICK_SECRET_DIR=${secretDir}\n`;
    const updatedBuffer = Buffer.from(updated, "utf8");
    if (updatedBuffer.length > MAX_ENV_BYTES) throw new Error("updated .env exceeds the configuration size limit");

    writeAttempted = true;
    fs.ftruncateSync(descriptor, 0);
    writeAll(descriptor, updatedBuffer);
    fs.fchmodSync(descriptor, 0o600);
    modified = true;

    const current = fs.lstatSync(envPath);
    const final = fs.fstatSync(descriptor);
    if (current.isSymbolicLink() || current.dev !== final.dev || current.ino !== final.ino || current.nlink !== 1) {
      throw new Error(".env changed during secret configuration");
    }
  } catch (error) {
    if (writeAttempted && !modified && original) {
      try {
        fs.ftruncateSync(descriptor, 0);
        writeAll(descriptor, Buffer.from(original, "utf8"));
        fs.fchmodSync(descriptor, 0o600);
      } catch {
        // Preserve the original failure; the deployment preflight remains closed.
      }
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }

  verifyRequiredRuntimeSecrets(secretDir);
  return true;
}

if (require.main === module) {
  try {
    const appDir = process.argv[2] || "/home/sidekick/sidekick";
    const secretDir = process.argv[3] || process.env.SIDEKICK_SECRET_DIR || "/etc/sidekick/secrets";
    configureSecretDirectory(appDir, secretDir);
    process.stdout.write(`Protected secret directory configured: ${secretDir}\n`);
  } catch (error) {
    process.stderr.write(`Secret configuration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { configureSecretDirectory };
