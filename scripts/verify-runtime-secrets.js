"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assertSafeSecretDirectory } = require("../src/core/runtime-secrets");

const REQUIRED_SECRETS = Object.freeze({
  SIDEKICK_API_KEY: "sidekick_api_key",
  SIDEKICK_AGENT_PROXY_KEY: "sidekick_agent_proxy_key"
});

function readRequiredSecret(directory, variableName, fileName) {
  const filePath = path.join(directory, fileName);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${variableName} is missing at ${filePath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${variableName} must be a regular, non-symlink secret file`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error(`${variableName} secret file is writable by group or other users`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o004) !== 0) {
    throw new Error(`${variableName} secret file is readable by other users`);
  }

  let value;
  try {
    value = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`${variableName} secret file could not be read`);
  }
  if (Buffer.byteLength(value, "utf8") > 16384) {
    throw new Error(`${variableName} secret file is too large`);
  }
  value = value.replace(/\r?\n$/, "");
  if (!value || value.includes("\0")) {
    throw new Error(`${variableName} secret file is empty or invalid`);
  }
  if (variableName === "SIDEKICK_API_KEY" && ["sk-sidekick-local-dev", "sk-your-key-here"].includes(value)) {
    throw new Error(`${variableName} must not use a placeholder value`);
  }
  return value;
}

function verifyRequiredRuntimeSecrets(directory) {
  if (!path.isAbsolute(directory)) throw new Error("SIDEKICK_SECRET_DIR must be an absolute path");
  const resolved = assertSafeSecretDirectory(directory, "SIDEKICK_SECRET_DIR");

  const values = Object.entries(REQUIRED_SECRETS).map(([name, file]) =>
    readRequiredSecret(resolved, name, file));
  if (values[0] === values[1]) {
    throw new Error("SIDEKICK_AGENT_PROXY_KEY must differ from SIDEKICK_API_KEY");
  }
  return true;
}

if (require.main === module) {
  try {
    verifyRequiredRuntimeSecrets(process.argv[2] || process.env.SIDEKICK_SECRET_DIR || "/etc/sidekick/secrets");
    process.stdout.write("Required runtime secret files are present and valid.\n");
  } catch (error) {
    process.stderr.write(`Runtime secret preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyRequiredRuntimeSecrets };
