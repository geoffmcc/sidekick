"use strict";

const crypto = require("crypto");
const net = require("node:net");
const dbStore = require("../db");
const identity = require("./identity");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS_PER_PRINCIPAL = 64;
const SESSION_CLEANUP_BATCH_SIZE = 500;
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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
function credentialActorContext(actorContext) {
  const principalId = actorContext?.principal_id || actorContext?.principalId;
  if (typeof principalId !== "string" || !principalId.trim()) throw new Error("credential mutations require an authenticated identity context");
  const rawScopes = actorContext.scopes ?? actorContext.credentialScopes;
  if (rawScopes !== undefined && rawScopes !== null && !Array.isArray(rawScopes)) throw new Error("credential authority scopes are invalid");
  return {
    principalId: principalId.trim(),
    credentialScopes: Array.isArray(rawScopes) ? rawScopes : null,
    delegationId: actorContext.delegation_id || actorContext.delegationId || null,
  };
}
function assertCredentialActor(actorContext, permission) {
  const context = credentialActorContext(actorContext);
  const authorization = require("./authorization");
  if (!authorization.authorize({ ...context, permission }).ok) throw new Error(`Credential mutation requires ${permission}`);
  return { context, authorization };
}
function assertCredentialSubject(context, authorization, targetPrincipalId, { scopes = [], allowCrossPrincipal = true } = {}) {
  const target = identity.getPrincipal(targetPrincipalId);
  if (!target || !target.enabled) throw new Error("credential target must be an enabled principal");
  if (context.principalId !== target.principal_id) {
    if (!allowCrossPrincipal || !["agent", "service"].includes(target.principal_type)) {
      throw new Error("credentials for another human principal cannot be managed by this operation");
    }
    for (const permission of ["principals.manage", "roles.manage"]) {
      if (!authorization.authorize({ ...context, permission }).ok) throw new Error(`Cross-principal credential management requires ${permission}`);
    }
  }
  for (const scope of scopes) {
    if (!authorization.authorize({ ...context, permission: scope }).ok) throw new Error(`Credential scope exceeds the actor's authority: ${scope}`);
  }
  return target;
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
  const retainedSince = new Date(timestamp - SESSION_RETENTION_MS).toISOString();
  const safeUserAgent = typeof userAgent === "string" ? userAgent.replace(/[^\x20-\x7E]/g, "?").slice(0, 256) : null;
  const safeIpAddress = typeof ipAddress === "string" && net.isIP(ipAddress) ? ipAddress : null;
  const db = dbStore.getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM identity_sessions WHERE session_id_hash IN (
      SELECT session_id_hash FROM identity_sessions
      WHERE expires_at <= ? OR (invalidated_at IS NOT NULL AND invalidated_at <= ?)
      ORDER BY expires_at ASC LIMIT ?
    )`).run(createdAt, retainedSince, SESSION_CLEANUP_BATCH_SIZE);
    const evicted = db.prepare(`UPDATE identity_sessions SET invalidated_at = ?
      WHERE session_id_hash IN (
        SELECT session_id_hash FROM identity_sessions
        WHERE principal_id = ? AND invalidated_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT -1 OFFSET ?
      )`).run(createdAt, principalId, createdAt, MAX_ACTIVE_SESSIONS_PER_PRINCIPAL - 1);
    if (evicted.changes > 0) {
      identity.recordAuditEvent("session.evicted", principalId, principalId, {
        reason: "active_session_limit",
        count: evicted.changes,
        limit: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
      });
    }
    db.prepare(`INSERT INTO identity_sessions
      (session_id_hash, principal_id, created_at, expires_at, last_seen_at, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(hash(raw), principalId, createdAt, expiresAt, createdAt, safeUserAgent, safeIpAddress);
    identity.recordAuditEvent("session.created", principalId, principalId, { expires_at: expiresAt });
  })();
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

function isSessionActive(sessionId) {
  if (typeof sessionId !== "string" || !/^[a-f0-9]{64}$/.test(sessionId)) return false;
  const row = dbStore.getDb().prepare(`SELECT 1 AS active
    FROM identity_sessions s JOIN principals p ON p.principal_id = s.principal_id
    WHERE s.session_id_hash = ? AND s.invalidated_at IS NULL
      AND s.expires_at > ? AND p.enabled = 1`).get(sessionId, now());
  return Boolean(row);
}

function invalidateSession(token, actorPrincipalId = null) {
  if (typeof token !== "string" || !token) return false;
  const db = dbStore.getDb();
  return db.transaction(() => {
    const sessionHash = hash(token);
    const session = db.prepare("SELECT principal_id FROM identity_sessions WHERE session_id_hash = ?").get(sessionHash);
    const result = db.prepare("UPDATE identity_sessions SET invalidated_at = ? WHERE session_id_hash = ? AND invalidated_at IS NULL").run(now(), sessionHash);
    if (result.changes === 1) identity.recordAuditEvent("session.revoked", session?.principal_id, actorPrincipalId || session?.principal_id || null, {});
    return result.changes === 1;
  })();
}

function invalidatePrincipalSessions(principalId, actorPrincipalId = null) {
  const idValue = requiredText(principalId, "principal_id");
  const db = dbStore.getDb();
  return db.transaction(() => {
    const result = db.prepare("UPDATE identity_sessions SET invalidated_at = ? WHERE principal_id = ? AND invalidated_at IS NULL").run(now(), idValue);
    if (result.changes > 0) identity.recordAuditEvent("principal.sessions_revoked", idValue, actorPrincipalId, { count: result.changes });
    return result.changes;
  })();
}

function createCredential({ principalId, displayName, scopes = [], expiresAt = null, createdByPrincipalId = null, actorContext = null } = {}) {
  const targetId = requiredText(principalId, "principal_id");
  const name = requiredText(displayName, "displayName");
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== "string" || !scope.trim() || scope.length > 160)) throw new Error("scopes must be a bounded string array");
  const uniqueScopes = [...new Set(scopes.map(scope => scope.trim()))];
  const expiry = validFutureDate(expiresAt, "expires_at");
  const credentialId = id("cred");
  const secret = crypto.randomBytes(CREDENTIAL_BYTES).toString("base64url");
  const token = `skc_${credentialId}_${secret}`;
  const timestamp = now();
  const db = dbStore.getDb();
  db.transaction(() => {
    const { context, authorization } = assertCredentialActor(actorContext, "credentials.create");
    if (createdByPrincipalId && createdByPrincipalId !== context.principalId) throw new Error("credential audit actor must match the authenticated identity context");
    const target = assertCredentialSubject(context, authorization, targetId, { scopes: uniqueScopes });
    db.prepare(`INSERT INTO identity_credentials
      (credential_id, principal_id, display_name, verifier_hash, token_prefix, scopes_json, created_at, expires_at, created_by_principal_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(credentialId, target.principal_id, name, hash(secret), token.slice(0, 16), JSON.stringify(uniqueScopes), timestamp, expiry, context.principalId);
    identity.recordAuditEvent("credential.created", target.principal_id, context.principalId, { credential_id: credentialId, scopes: uniqueScopes, expires_at: expiry });
  })();
  return { token, credential: getCredential(credentialId) };
}

function getCredential(credentialId) {
  const row = dbStore.getDb().prepare("SELECT * FROM identity_credentials WHERE credential_id = ?").get(requiredText(credentialId, "credential_id"));
  return row ? safeCredential(row) : null;
}

// Revalidate a credential-backed identity at each execution boundary. The
// scopes on an identity are a snapshot from task creation, so intersect them
// with the current credential instead of allowing later scope additions to
// expand an already-running task.
function refreshCredentialIdentity(authIdentity) {
  if (!authIdentity || !authIdentity.credential_id || !Array.isArray(authIdentity.scopes)) return null;
  const credential = getCredential(authIdentity.credential_id);
  if (!credential
      || credential.credential_id !== authIdentity.credential_id
      || credential.principal_id !== authIdentity.principal_id
      || credential.revoked_at
      || (credential.expires_at && (!Number.isFinite(Date.parse(credential.expires_at)) || Date.parse(credential.expires_at) <= Date.now()))
      || !Array.isArray(credential.scopes)) return null;
  const principal = identity.getPrincipal(credential.principal_id);
  if (!principal || !principal.enabled) return null;
  const currentScopes = new Set(credential.scopes.map(String));
  const scopes = [...new Set(authIdentity.scopes.map(String))].filter(scope => currentScopes.has("*") || currentScopes.has(scope));
  return { ...authIdentity, scopes };
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

// Normalize the two supported principal-bearing HTTP bearer forms. Browser
// session tokens remain opaque and revocable: getSession checks current expiry,
// invalidation, and principal state on every request. The legacy installation
// API key is intentionally handled separately by its compatibility middleware
// because it does not identify a principal.
function authenticateBearerIdentity(token) {
  const credential = authenticateCredential(token);
  if (credential) {
    return {
      principal_id: credential.principal_id,
      principal_type: credential.principal_type,
      scopes: credential.scopes,
      credential_id: credential.credential_id,
      authentication_method: "scoped_credential",
    };
  }
  const session = getSession(token);
  if (!session) return null;
  return {
    principal_id: session.principal_id,
    principal_type: session.principal_type,
    scopes: null,
    authentication_method: "browser_session",
  };
}

function revokeCredential(credentialId, actorContext = null) {
  const idValue = requiredText(credentialId, "credential_id");
  const db = dbStore.getDb();
  return db.transaction(() => {
    const { context, authorization } = assertCredentialActor(actorContext, "credentials.revoke");
    const credential = db.prepare("SELECT principal_id, scopes_json FROM identity_credentials WHERE credential_id = ?").get(idValue);
    if (!credential) return false;
    assertCredentialSubject(context, authorization, credential.principal_id, { allowCrossPrincipal: true });
    const result = db.prepare("UPDATE identity_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL").run(now(), idValue);
    if (result.changes === 1) identity.recordAuditEvent("credential.revoked", credential.principal_id, context.principalId, { credential_id: idValue });
    return result.changes === 1;
  })();
}

function createOwnerRecoveryToken(ownerPrincipalId, ttlMs = RECOVERY_TTL_MS) {
  const owner = identity.getPrincipal(ownerPrincipalId);
  if (!owner || owner.principal_type !== "human" || !owner.roles.includes("owner")) throw new Error("usable Owner principal required");
  const token = crypto.randomBytes(RECOVERY_BYTES).toString("base64url");
  const createdAt = now();
  const expiresAt = new Date(Date.now() + Math.max(60_000, Number(ttlMs) || RECOVERY_TTL_MS)).toISOString();
  const db = dbStore.getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO identity_recovery_tokens (token_hash, owner_principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hash(token), owner.principal_id, createdAt, expiresAt);
    identity.recordAuditEvent("owner.recovery_token_created", owner.principal_id, owner.principal_id, { expires_at: expiresAt });
  })();
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
    identity.changePassword(owner.principal_id, newPassword, owner);
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

function rotateCredential(credentialId, actorContext = null) {
  const idValue = requiredText(credentialId, "credential_id");
  const db = dbStore.getDb();
  return db.transaction(() => {
    const { context, authorization } = assertCredentialActor(actorContext, "credentials.revoke");
    if (!authorization.authorize({ ...context, permission: "credentials.create" }).ok) throw new Error("Credential rotation requires credentials.create");
    const row = db.prepare("SELECT * FROM identity_credentials WHERE credential_id = ? AND revoked_at IS NULL").get(idValue);
    if (!row) throw new Error("credential not found or already revoked");
    const current = safeCredential(row);
    assertCredentialSubject(context, authorization, current.principal_id, { scopes: current.scopes, allowCrossPrincipal: true });
    const replacement = createCredential({
      principalId: current.principal_id,
      displayName: current.display_name,
      scopes: current.scopes,
      expiresAt: current.expires_at,
      createdByPrincipalId: context.principalId,
      actorContext,
    });
    const result = db.prepare("UPDATE identity_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL").run(now(), current.credential_id);
    if (result.changes !== 1) throw new Error("credential changed during rotation");
    return replacement;
  })();
}

module.exports = Object.freeze({ MAX_ACTIVE_SESSIONS_PER_PRINCIPAL, SESSION_TTL_MS, RECOVERY_TTL_MS, createSession, getSession, isSessionActive, invalidateSession, invalidatePrincipalSessions, createCredential, getCredential, refreshCredentialIdentity, listCredentials, authenticateCredential, authenticateBearerIdentity, revokeCredential, rotateCredential, createOwnerRecoveryToken, recoverOwnerPassword });
