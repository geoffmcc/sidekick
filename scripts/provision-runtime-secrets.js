"use strict";

// Bootstrap-only provisioner for internal runtime credentials. Open secret
// files without following symlinks, then change ownership/mode through the
// open descriptor so a writable service directory cannot redirect root ops.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SECRET_FILES = Object.freeze([
  "sidekick_api_key",
  "sidekick_agent_proxy_key",
  "sidekick_agent_scheduler_key",
  "sidekick_dashboard_pass",
  "sidekick_grafana_admin_password",
  "sidekick_influx_token",
  "sidekick_influx_password",
  "sidekick_postgres_password",
  "sidekick_secret_key",
]);
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const NONBLOCK = fs.constants.O_NONBLOCK || 0;

function openSecret(directory, name) {
  return fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
}

function verifyDirectory(directory, expectedUid) {
  const absolute = path.resolve(directory);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(absolute) !== absolute) {
    throw new Error("runtime secret directory must be a real directory, not a symlink");
  }
  if (stat.uid !== expectedUid) throw new Error("runtime secret directory owner does not match the Sidekick service account");
  if ((stat.mode & 0o077) !== 0) throw new Error("runtime secret directory must not grant group or other access");
}

function provisionOne(directory, name, expectedUid, createRaces = 0) {
  const target = path.join(directory, name);
  let descriptor;
  try {
    descriptor = openSecret(directory, name);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      descriptor = fs.openSync(target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK,
        0o600);
      const contents = Buffer.from(`${crypto.randomBytes(32).toString("hex")}\n`);
      let offset = 0;
      while (offset < contents.length) offset += fs.writeSync(descriptor, contents, offset, contents.length - offset);
    } catch (createError) {
      if (createError.code === "EEXIST" && createRaces < 3) return provisionOne(directory, name, expectedUid, createRaces + 1);
      if (createError.code === "EEXIST") throw new Error(`${name} changed repeatedly during provisioning`);
      throw createError;
    }
  }

  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${name} must be a regular file with exactly one link`);
    if (stat.size > 16384) throw new Error(`${name} exceeds the runtime secret size limit`);
    if (stat.size === 0) throw new Error(`${name} is empty; refusing to replace an existing secret`);
    fs.fchownSync(descriptor, expectedUid, -1);
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }

  const finalStat = fs.lstatSync(target);
  if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.nlink !== 1 || finalStat.uid !== expectedUid || (finalStat.mode & 0o777) !== 0o600) {
    throw new Error(`${name} changed during provisioning; refusing to continue`);
  }
}

function provisionRuntimeSecrets(directory, expectedUid) {
  if (!path.isAbsolute(directory)) throw new Error("runtime secret directory must be absolute");
  if (!Number.isInteger(expectedUid) || expectedUid < 0) throw new Error("a valid Sidekick service UID is required");
  verifyDirectory(directory, expectedUid);
  for (const name of SECRET_FILES) provisionOne(directory, name, expectedUid);
  return true;
}

if (require.main === module) {
  try {
    const directory = process.argv[2];
    const uid = Number(process.argv[3]);
    provisionRuntimeSecrets(directory, uid);
    process.stdout.write("Protected runtime secrets are present and validated.\n");
  } catch (error) {
    process.stderr.write(`Runtime secret provisioning failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { SECRET_FILES, provisionRuntimeSecrets };
