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

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRETS_FILE = path.join(DATA_DIR, "secrets.enc");
const PACK_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SECRET_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

// One loud log per distinct failure per process: loadSecrets is called on hot
// paths (every github/connector credential resolution), so a corrupt store
// must be visible without producing a log line per call.
const reportedLoadFailures = new Set();

function loadSecrets() {
  // Missing file is the normal empty-store case: silent, no error.
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    const data = fs.readFileSync(SECRETS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    // The file EXISTS but cannot be read/parsed. Returning {} keeps boot and
    // callers alive (their fallbacks apply), but silently mapping corruption
    // onto "no secrets" hid real credential loss from the operator — so say
    // so, loudly, distinguishing corrupt-existing from merely-missing.
    const message = String(error.message || error);
    if (!reportedLoadFailures.has(message)) {
      reportedLoadFailures.add(message);
      console.error(
        `[SecretsStore] FAILED to load existing secrets file ${SECRETS_FILE} ` +
        `(corrupt or unreadable, NOT missing): ${message}. ` +
        `Treating the store as empty for this call; stored credentials are NOT gone from disk, but they are unavailable until this is fixed.`
      );
    }
    return {};
  }
}

function saveSecrets(secrets) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
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
