"use strict";

/**
 * AES-256-GCM value cipher, keyed by SIDEKICK_SECRET_KEY.
 *
 * Relocated here from `src/tools-legacy.js` so that modules which must not
 * require `tools-legacy` at top level — the approval-continuation storage layer
 * in particular — can encrypt at rest without forming a require cycle through
 * the dispatcher. `tools-legacy.js` consumes this module rather than defining
 * its own copy; the wire format is unchanged, so existing ciphertext keeps
 * decrypting.
 *
 * The key is derived by SHA-256 over the configured value, so any key length is
 * accepted. Absence of SIDEKICK_SECRET_KEY throws rather than silently
 * degrading to plaintext: callers are expected to fail closed.
 */

const crypto = require("crypto");
const { readSecret } = require("./runtime-secrets");

function getSecretKey() {
  const key = readSecret("SIDEKICK_SECRET_KEY");
  if (!key) {
    throw new Error("SIDEKICK_SECRET_KEY not set in .env");
  }
  return crypto.createHash("sha256").update(key).digest();
}

function hasSecretKey() {
  return Boolean(readSecret("SIDEKICK_SECRET_KEY"));
}

function encryptSecret(value) {
  const key = getSecretKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return { iv: iv.toString("hex"), data: encrypted, authTag };
}

function decryptSecret(encrypted) {
  const key = getSecretKey();
  const iv = Buffer.from(encrypted.iv, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));
  let decrypted = decipher.update(encrypted.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Column helpers. The continuation schema stores ciphertext in TEXT columns, so
 * the {iv,data,authTag} envelope is serialized as JSON. `decryptColumn`
 * distinguishes "column was NULL" (returns null) from "column was unreadable"
 * (throws), because §7.3 routes those to different recovery branches.
 */
function encryptColumn(plaintext) {
  if (plaintext == null) return null;
  return JSON.stringify(encryptSecret(String(plaintext)));
}

function decryptColumn(column) {
  if (column == null) return null;
  const envelope = JSON.parse(column);
  return decryptSecret(envelope);
}

module.exports = {
  getSecretKey,
  hasSecretKey,
  encryptSecret,
  decryptSecret,
  encryptColumn,
  decryptColumn,
};
