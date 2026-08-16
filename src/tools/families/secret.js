"use strict";

// Secret tool family: secret.
//
// Extracted from src/tools-legacy.js. Depends only on Node crypto, zod, the
// encrypted-secrets store, and the shared AES-256-GCM cipher — never on
// tools-legacy.js. Values are encrypted before hitting disk and never echoed
// in full; wire format unchanged so existing secrets.enc keeps decrypting.
// `secret` is `high` risk, preserved from src/tools/metadata.js.

const crypto = require("crypto");
const { z } = require("zod");
const { loadSecrets, saveSecrets } = require("../../core/secrets-store");
const { getSecretKey, encryptSecret, decryptSecret } = require("../../core/secret-cipher");

async function sidekick_secret({ action, key, value, generate }) {
  const now = new Date().toISOString();

  try {
    getSecretKey();
  } catch (e) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }

  const secrets = loadSecrets();

  if (action === "store") {
    if (!key || !value) {
      return { content: [{ type: "text", text: "key and value required" }], isError: true };
    }

    const encrypted = encryptSecret(value);
    secrets[key] = {
      ...encrypted,
      created: now,
      updated: now
    };
    saveSecrets(secrets);

    return { content: [{ type: "text", text: `Stored secret: ${key}` }] };
  }

  if (action === "get") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }

    const secret = secrets[key];
    if (!secret) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }

    try {
      const decrypted = decryptSecret(secret);
      return { content: [{ type: "text", text: decrypted }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Decryption failed: ${e.message}` }], isError: true };
    }
  }

  if (action === "delete") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }

    if (!secrets[key]) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }

    delete secrets[key];
    saveSecrets(secrets);

    return { content: [{ type: "text", text: `Deleted secret: ${key}` }] };
  }

  if (action === "list") {
    const keys = Object.keys(secrets);
    let output = `# Stored Secrets (${keys.length})\n\n`;
    for (const k of keys) {
      const s = secrets[k];
      output += `- **${k}** (created: ${s.created}, updated: ${s.updated})\n`;
    }
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "rotate") {
    if (!key) {
      return { content: [{ type: "text", text: "key required" }], isError: true };
    }

    const secret = secrets[key];
    if (!secret) {
      return { content: [{ type: "text", text: `Secret not found: ${key}` }], isError: true };
    }

    let newValue;
    if (generate) {
      const length = parseInt(generate);
      if (isNaN(length) || length < 8) {
        return { content: [{ type: "text", text: "generate must be a number >= 8" }], isError: true };
      }
      newValue = crypto.randomBytes(length).toString("hex").substring(0, length);
    } else {
      return { content: [{ type: "text", text: "generate parameter required for rotation" }], isError: true };
    }

    const encrypted = encryptSecret(newValue);
    secrets[key] = {
      ...encrypted,
      created: secret.created,
      updated: now
    };
    saveSecrets(secrets);

    return { content: [{ type: "text", text: `Rotated secret: ${key}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: store, get, delete, list, rotate" }], isError: true };
}

const SCHEMAS = {
  secret: z.object({
    action: z.enum(["store", "get", "delete", "list", "rotate"]).describe("Secret action: store (save encrypted), get (retrieve), delete (remove), list (show names), rotate (generate new)"),
    key: z.string().optional().describe("Secret name/key"),
    value: z.string().optional().describe("Secret value (for store action)"),
    generate: z.string().optional().describe("Length for rotation (e.g. '32' for 32-char random hex)")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "secret",
    description: "Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env)",
    schema: SCHEMAS.secret,
    args: { action: "string (store|get|delete|list|rotate)", key: "string (secret name)", value: "string (optional, for store)", generate: "string (optional, length for rotate, e.g. '32')" },
    risk: "high",
    category: "Security",
    source: "builtin",
    family: "secret",
    handler: sidekick_secret,
  }),
]);

module.exports = { descriptors, sidekick_secret };
