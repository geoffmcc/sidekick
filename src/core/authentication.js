"use strict";

const crypto = require("crypto");
const dbStore = require("../db");
const identity = require("./identity");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CREDENTIAL_BYTES = 32;
const SESSION_BYTES = 32;
const RECOVERY_BYTES = 32;
const RECOVERY_TTL_MS = 15 * 60 * 1000;

function now() { return new Date().toISOString(); }
function hash(value) { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function requiredText(value, field, max = 160) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${field} is required and bounded`);
  return text;
}
function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function validFutureDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error(`${field} must be a future timestamp`);
  return date.toISOString();
}
function safeCredential(row) {
  return {
    credential_id: row.credential_id,
    principal_id: row.principal_id,
    display_name: row.display_name,
    token_prefix: row.token_prefix,
    scopes: parseJson(row.scopes_json, []),
    created_at: row.created_at,
    expires_at: row.expires_at || null,
    revoked_at: row.revoked_at || null,
    last_used_at: row.last_used_at || null,
    created_by_principal_id: row.created_by_principal_id || null,
  };
}

function createSession(principalId, { userAgent = null, ipAddress = null, ttlMs = SESSION_TTL_MS } = {}) {
  requiredText(principalId, "principal_id");
  const raw = crypto.randomBytes(SESSION_BYTES).toString("base64url");
  const timestamp = Date.now();
  const createdAt = new Date(timestamp).toISOString();
  const expiresAt = new Date(timestamp + Math.max(60_000, Number(ttlMs) || SESSION_TTL_MS)).toISOString();
  dbStore.getDb().prepare(`INSERT INTO identity_sessions
    (session_id_hash, principal_id, created_at, expires_at, last_seen_at, user_agent, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(hash(raw), principalId, createdAt, expiresAt, createdAt, userAgent, ipAddress);
  identity.recordAuditEvent("session.created", principalId, principalId, { expires_at: expiresAt });
  return { token: raw, expires_at: expiresAt };
}

function getSession(token) {
  if (typeof token !== "string" || token.length < 40 || token.length > 256) return null;
  const row = dbStore.getDb().prepare(`SELECT s.*, p.principal_type, p.display_name, p.enabled
    FROM identity_sessions s JOIN principals p ON p.principal_id = s.principal_id
    WHERE s.session_id_hash = ?`).get(hash(token));
  if (!row || row.invalidated_at || !row.enabled || new Date(row.expires_at).getTime() <= Date.now()) return null;
  const seen = now();
  dbStore.getDb().prepare("UPDATE identity_sessions SET last_seen_at = ? WHERE session_id_hash = ? AND invalidated_at IS NULL").run(seen, hash(token));
  return {
    session_id: row.session_id_hash,
    principal_id: row.principal_id,
    principal_type: row.principal_type,
    display_name: row.display_name,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_seen_at: seen,
  };
}

function invalidateSession(token) {
  if (typeof token !== "string" || !token) return false;
  const result = dbStore.getDb().prepare("UPDATE identity_sessions SET invalidated_at = ? WHERE session_id_hash = ? AND invalidated_at IS NULL").run(now(), hash(token));
  return result.changes === 1;
}

function invalidatePrincipalSessions(principalId) {
  const result = dbStore.getDb().prepare("UPDATE identity_sessions SET invalidated_at = ? WHERE principal_id = ? AND invalidated_at IS NULL").run(now(), requiredText(principalId, "principal_id"));
  return result.changes;
}

function createCredential({ principalId, displayName, scopes = [], expiresAt = null, createdByPrincipalId = null } = {}) {
  requiredText(principalId, "principal_id");
  const name = requiredText(displayName, "displayName");
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== "string" || !scope.trim() || scope.length > 160)) throw new Error("scopes must be a bounded string array");
  const expiry = validFutureDate(expiresAt, "expires_at");
  const credentialId = id("cred");
  const secret = crypto.randomBytes(CREDENTIAL_BYTES).toString("base64url");
  const token = `skc_${credentialId}_${secret}`;
  const timestamp = now();
  dbStore.getDb().prepare(`INSERT INTO identity_credentials
    (credential_id, principal_id, display_name, verifier_hash, token_prefix, scopes_json, created_at, expires_at, created_by_principal_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(credentialId, principalId, name, hash(secret), token.slice(0, 16), JSON.stringify([...new Set(scopes.map(scope => scope.trim()))]), timestamp, expiry, createdByPrincipalId);
  identity.recordAuditEvent("credential.created", principalId, createdByPrincipalId, { credential_id: credentialId, scopes: [...new Set(scopes.map(scope => scope.trim()))], expires_at: expiry });
  return { token, credential: getCredential(credentialId) };
}

function getCredential(credentialId) {
  const row = dbStore.getDb().prepare("SELECT * FROM identity_credentials WHERE credential_id = ?").get(requiredText(credentialId, "credential_id"));
  return row ? safeCredential(row) : null;
}

function listCredentials(principalId = null) {
  const rows = principalId
    ? dbStore.getDb().prepare("SELECT * FROM identity_credentials WHERE principal_id = ? ORDER BY created_at DESC").all(requiredText(principalId, "principal_id"))
    : dbStore.getDb().prepare("SELECT * FROM identity_credentials ORDER BY created_at DESC").all();
  return rows.map(safeCredential);
}

function authenticateCredential(token) {
  if (typeof token !== "string" || token.length < 50 || token.length > 512) return null;
  const match = token.match(/^skc_(cred_[0-9a-f-]+)_(.+)$/);
  if (!match) return null;
  const row = dbStore.getDb().prepare(`SELECT c.*, p.principal_type, p.display_name, p.enabled
    FROM identity_credentials c JOIN principals p ON p.principal_id = c.principal_id
    WHERE c.credential_id = ?`).get(match[1]);
  if (!row || row.revoked_at || !row.enabled || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) return null;
  const expected = Buffer.from(row.verifier_hash, "hex");
  const actual = Buffer.from(hash(match[2]), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  const lastUsed = now();
  dbStore.getDb().prepare("UPDATE identity_credentials SET last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL").run(lastUsed, row.credential_id);
  return { ...safeCredential(row), principal_type: row.principal_type, principal_display_name: row.display_name, last_used_at: lastUsed };
}

function revokeCredential(credentialId) {
  const idValue = requiredText(credentialId, "credential_id");
  const principal = dbStore.getDb().prepare("SELECT principal_id FROM identity_credentials WHERE credential_id = ?").get(idValue);
  const result = dbStore.getDb().prepare("UPDATE identity_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL").run(now(), idValue);
  if (result.changes === 1) identity.recordAuditEvent("credential.revoked", principal?.principal_id, null, { credential_id: idValue });
  return result.changes === 1;
}

function createOwnerRecoveryToken(ownerPrincipalId, ttlMs = RECOVERY_TTL_MS) {
  const owner = identity.getPrincipal(ownerPrincipalId);
  if (!owner || owner.principal_type !== "human" || !owner.roles.includes("owner")) throw new Error("usable Owner principal required");
  const token = crypto.randomBytes(RECOVERY_BYTES).toString("base64url");
  const createdAt = now();
  const expiresAt = new Date(Date.now() + Math.max(60_000, Number(ttlMs) || RECOVERY_TTL_MS)).toISOString();
  dbStore.getDb().prepare("INSERT INTO identity_recovery_tokens (token_hash, owner_principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hash(token), owner.principal_id, createdAt, expiresAt);
  identity.recordAuditEvent("owner.recovery_token_created", owner.principal_id, owner.principal_id, { expires_at: expiresAt });
  return { token, expires_at: expiresAt };
}

function recoverOwnerPassword(token, newPassword) {
  if (typeof token !== "string" || token.length < 40) throw new Error("recovery token is invalid");
  const db = dbStore.getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM identity_recovery_tokens WHERE token_hash = ? AND used_at IS NULL").get(hash(token));
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) throw new Error("recovery token is invalid or expired");
    const owner = identity.getPrincipal(row.owner_principal_id);
    if (!owner || !owner.enabled || !owner.roles.includes("owner")) throw new Error("Owner recovery is unavailable");
    identity.changePassword(owner.principal_id, newPassword, owner.principal_id);
    invalidatePrincipalSessions(owner.principal_id);
    db.prepare("UPDATE identity_recovery_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").run(now(), row.token_hash);
    identity.recordAuditEvent("owner.recovered", owner.principal_id, owner.principal_id, {});
    db.exec("COMMIT");
    return owner;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function rotateCredential(credentialId, createdByPrincipalId = null) {
  const current = getCredential(credentialId);
  if (!current || current.revoked_at) throw new Error("credential not found or already revoked");
  const db = dbStore.getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const replacement = createCredential({
      principalId: current.principal_id,
      displayName: current.display_name,
      scopes: current.scopes,
      expiresAt: current.expires_at,
      createdByPrincipalId,
    });
    db.prepare("UPDATE identity_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL").run(now(), current.credential_id);
    db.exec("COMMIT");
    return replacement;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

module.exports = Object.freeze({ SESSION_TTL_MS, RECOVERY_TTL_MS, createSession, getSession, invalidateSession, invalidatePrincipalSessions, createCredential, getCredential, listCredentials, authenticateCredential, revokeCredential, rotateCredential, createOwnerRecoveryToken, recoverOwnerPassword });
