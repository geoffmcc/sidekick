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

function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    const data = fs.readFileSync(SECRETS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveSecrets(secrets) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

module.exports = { SECRETS_FILE, loadSecrets, saveSecrets };
