"use strict";

// Encrypted-secrets JSON store, moved verbatim from src/tools-legacy.js (B-6)
// so the secret and github families can share it without a legacy import.
// Values are encrypted by callers via src/core/secret-cipher.js before they
// reach this store; the store itself never sees or logs plaintext beyond what
// callers pass. Wire format unchanged, so existing secrets.enc keeps working.
// DATA_DIR is re-based for src/core/. Deliberately NOT exported through the
// src/tools facade — secrets access stays scoped to its consumers.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRETS_FILE = path.join(DATA_DIR, "secrets.enc");
const PACK_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SECRET_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

// One loud log per distinct failure per process: loadSecrets is called on hot
// paths (every github/connector credential resolution), so a corrupt store
// must be visible without producing a log line per call.
const reportedLoadFailures = new Set();

function existingRegularSecretsFile() {
  try {
    const stat = fs.lstatSync(SECRETS_FILE);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("encrypted secret store must be a regular file");
    return stat;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function loadSecrets() {
  // Missing file is the normal empty-store case. A corrupt, unreadable, or
  // linked file is an error: mapping it to empty would let a later write
  // silently replace the only copy of stored credentials.
  if (!existingRegularSecretsFile()) return {};
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const data = fs.readFileSync(SECRETS_FILE, { encoding: "utf-8", flag: fs.constants.O_RDONLY | noFollow });
    const secrets = JSON.parse(data);
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) throw new Error("secret store root must be an object");
    return secrets;
  } catch (error) {
    const message = String(error.message || error);
    if (!reportedLoadFailures.has(message)) {
      reportedLoadFailures.add(message);
      console.error(
        `[SecretsStore] FAILED to load existing secrets file ${SECRETS_FILE} ` +
        `(corrupt or unreadable, NOT missing): ${message}. ` +
        `Refusing secret reads and writes until this is fixed.`
      );
    }
    throw new Error("encrypted secret store is corrupt or unavailable", { cause: error });
  }
}

function saveSecrets(secrets) {
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) throw new Error("secret store root must be an object");
  existingRegularSecretsFile();
  const tempFile = `${SECRETS_FILE}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tempFile, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(secrets, null, 2), "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempFile, SECRETS_FILE);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tempFile); } catch {}
    throw error;
  }
}

function packSecretKey(packName, key) {
  if (!PACK_NAME_RE.test(String(packName || ""))) throw new Error("invalid capability pack name");
  if (!SECRET_KEY_RE.test(String(key || ""))) throw new Error("invalid pack secret name");
  return `pack:${packName}:${key}`;
}

function loadPackSecrets(packName) {
  const prefix = `pack:${packName}:`;
  const all = loadSecrets();
  return Object.fromEntries(Object.entries(all)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value]));
}

function savePackSecret(packName, key, value) {
  const all = loadSecrets();
  all[packSecretKey(packName, key)] = value;
  saveSecrets(all);
}

function deletePackSecret(packName, key) {
  const all = loadSecrets();
  const namespaced = packSecretKey(packName, key);
  const existed = Object.prototype.hasOwnProperty.call(all, namespaced);
  delete all[namespaced];
  if (existed) saveSecrets(all);
  return existed;
}

module.exports = {
  SECRETS_FILE,
  loadSecrets,
  saveSecrets,
  packSecretKey,
  loadPackSecrets,
  savePackSecret,
  deletePackSecret,
};
