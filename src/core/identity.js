"use strict";

const crypto = require("crypto");
const dbStore = require("../db");

const PRINCIPAL_TYPES = Object.freeze(["human", "agent", "service", "automation", "system"]);
const ROLE_NAMES = Object.freeze(["owner", "administrator", "operator", "viewer", "auditor"]);
const PASSWORD_SCHEME = ["scrypt", "v1"].join("_");
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const PASSWORD_BYTES = 64;
const MIN_PASSWORD_LENGTH = 12;

function now() { return new Date().toISOString(); }
function requiredText(value, field, max = 160) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${field} is required and bounded`);
  return text;
}
function validateType(type) {
  if (!PRINCIPAL_TYPES.includes(type)) throw new Error(`Unsupported principal type: ${type}`);
  return type;
}
function validateRole(role) {
  if (!ROLE_NAMES.includes(role)) throw new Error(`Unsupported role: ${role}`);
  return role;
}
function principalId() { return `prn_${crypto.randomUUID()}`; }
function eventId() { return `ide_${crypto.randomUUID()}`; }
function parseJson(value, fallback = {}) { try { return JSON.parse(value); } catch { return fallback; } }

function passwordHash(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must contain at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, PASSWORD_BYTES, SCRYPT_OPTIONS);
  return `${PASSWORD_SCHEME}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [scheme, saltText, digestText] = encoded.split("$");
  if (scheme !== PASSWORD_SCHEME || !saltText || !digestText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

function toPrincipal(row, roles = []) {
  if (!row) return null;
  return Object.freeze({
    principal_id: row.principal_id,
    principal_type: row.principal_type,
    display_name: row.display_name,
    enabled: Boolean(row.enabled),
    created_by_principal_id: row.created_by_principal_id || null,
    metadata: parseJson(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    disabled_at: row.disabled_at || null,
    roles: [...roles],
  });
}

function getRoles(principalIdValue) {
  return dbStore.getDb().prepare("SELECT role_name FROM principal_roles WHERE principal_id = ? ORDER BY role_name").all(principalIdValue).map(row => row.role_name);
}

function audit(eventType, principalIdValue, actorPrincipalId, details = {}) {
  dbStore.getDb().prepare(`INSERT INTO identity_audit_events (event_id, event_type, principal_id, actor_principal_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(eventId(), eventType, principalIdValue || null, actorPrincipalId || null, JSON.stringify(details), now());
}

function recordAuditEvent(eventType, principalIdValue, actorPrincipalId = null, details = {}) {
  requiredText(eventType, "event_type", 120);
  audit(eventType, principalIdValue, actorPrincipalId, details);
}

function getPrincipal(id) {
  const row = dbStore.getDb().prepare("SELECT * FROM principals WHERE principal_id = ?").get(requiredText(id, "principal_id"));
  return toPrincipal(row, row ? getRoles(row.principal_id) : []);
}

function getHumanUser(id) {
  const principal = getPrincipal(id);
  if (!principal || principal.principal_type !== "human") return null;
  const row = dbStore.getDb().prepare("SELECT username FROM human_users WHERE principal_id = ?").get(principal.principal_id);
  return row ? { principal, username: row.username } : null;
}

function listPrincipals({ type, enabled, limit = 100 } = {}) {
  if (type !== undefined) validateType(type);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const clauses = [];
  const params = [];
  if (type) { clauses.push("principal_type = ?"); params.push(type); }
  if (enabled !== undefined) { clauses.push("enabled = ?"); params.push(enabled ? 1 : 0); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return dbStore.getDb().prepare(`SELECT * FROM principals ${where} ORDER BY created_at, principal_id LIMIT ?`).all(...params, boundedLimit).map(row => toPrincipal(row, getRoles(row.principal_id)));
}

function createPrincipal({ type, displayName, createdByPrincipalId = null, metadata = {}, actorPrincipalId = null } = {}) {
  validateType(type);
  const name = requiredText(displayName, "displayName");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("metadata must be an object");
  const id = principalId();
  const timestamp = now();
  const db = dbStore.getDb();
  return db.transaction(() => {
    db.prepare(`INSERT INTO principals (principal_id, principal_type, display_name, created_by_principal_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, type, name, createdByPrincipalId, JSON.stringify(metadata), timestamp, timestamp);
    audit("principal.created", id, actorPrincipalId || createdByPrincipalId, { principal_type: type });
    return getPrincipal(id);
  })();
}

function createHumanUser({ username, password, displayName, actorPrincipalId = null, metadata = {} } = {}) {
  const name = requiredText(username, "username", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(name)) throw new Error("username must be 3-80 characters and use letters, numbers, ., _, or -");
  const passwordDigest = passwordHash(password);
  const db = dbStore.getDb();
  return db.transaction(() => {
    const user = createPrincipal({ type: "human", displayName: displayName || name, metadata, actorPrincipalId });
    db.prepare("INSERT INTO human_users (principal_id, username, password_hash, password_scheme, password_changed_at) VALUES (?, ?, ?, ?, ?)").run(user.principal_id, name, passwordDigest, PASSWORD_SCHEME, now());
    audit("user.created", user.principal_id, actorPrincipalId, { username: name });
    return getPrincipal(user.principal_id);
  })();
}

function updatePrincipal(id, { displayName, metadata } = {}, actorPrincipalId = null) {
  const principal = getPrincipal(id);
  if (!principal) throw new Error("principal not found");
  const authorization = require("./authorization");
  if (!actorPrincipalId || !authorization.authorize({ principalId: actorPrincipalId, permission: "users.manage" }).ok) {
    throw new Error("Principal profile changes require users.manage");
  }
  const nextName = displayName === undefined ? principal.display_name : requiredText(displayName, "displayName");
  const nextMetadata = metadata === undefined ? principal.metadata : metadata;
  if (!nextMetadata || typeof nextMetadata !== "object" || Array.isArray(nextMetadata)) throw new Error("metadata must be an object");
  const db = dbStore.getDb();
  return db.transaction(() => {
    if (!authorization.authorize({ principalId: actorPrincipalId, permission: "users.manage" }).ok) {
      throw new Error("Principal profile changes require users.manage");
    }
    const currentPrincipal = getPrincipal(id);
    if (!currentPrincipal) throw new Error("principal not found");
    db.prepare("UPDATE principals SET display_name = ?, metadata_json = ?, updated_at = ? WHERE principal_id = ?").run(nextName, JSON.stringify(nextMetadata), now(), currentPrincipal.principal_id);
    audit("principal.updated", currentPrincipal.principal_id, actorPrincipalId, { display_name_changed: nextName !== currentPrincipal.display_name });
    return getPrincipal(currentPrincipal.principal_id);
  })();
}

function updateUsername(id, username, actorPrincipalId = null) {
  const principal = getPrincipal(id);
  if (!principal || principal.principal_type !== "human") throw new Error("human principal not found");
  const authorization = require("./authorization");
  if (!actorPrincipalId || !authorization.authorize({ principalId: actorPrincipalId, permission: "users.manage" }).ok) {
    throw new Error("Username changes require users.manage");
  }
  const name = requiredText(username, "username", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(name)) throw new Error("username must be 3-80 characters and use letters, numbers, ., _, or -");
  const db = dbStore.getDb();
  return db.transaction(() => {
    if (!authorization.authorize({ principalId: actorPrincipalId, permission: "users.manage" }).ok) {
      throw new Error("Username changes require users.manage");
    }
    const currentPrincipal = getPrincipal(id);
    if (!currentPrincipal || currentPrincipal.principal_type !== "human") throw new Error("human principal not found");
    db.prepare("UPDATE human_users SET username = ? WHERE principal_id = ?").run(name, currentPrincipal.principal_id);
    audit("user.username_changed", currentPrincipal.principal_id, actorPrincipalId, {});
    return getPrincipal(currentPrincipal.principal_id);
  })();
}

function assignRole(principalIdValue, role, actorPrincipalId = null) {
  validateRole(role);
  const principal = getPrincipal(principalIdValue);
  if (!principal) throw new Error("principal not found");
  // The legacy Dashboard bridge has two explicit onboarding cases: complete
  // first-owner setup while no Owner exists, or map the authenticated legacy
  // Basic Auth administrator to an Administrator role. Every other role
  // mutation requires current roles.manage authority.
  const firstOwnerException = role === "owner" && actorPrincipalId === principal.principal_id && canCompleteFirstOwnerSetup(principal.principal_id);
  const legacyDashboardAdminException = role === "administrator" && actorPrincipalId === principal.principal_id && canAssignLegacyDashboardAdministrator(principal.principal_id);
  const authorized = actorPrincipalId && require("./authorization").authorize({ principalId: actorPrincipalId, permission: "roles.manage" }).ok;
  if (!firstOwnerException && !legacyDashboardAdminException && !authorized) {
    throw new Error(role === "owner" ? "Owner promotion requires an authorized actor" : "Role assignment requires roles.manage");
  }
  const db = dbStore.getDb();
  db.transaction(() => {
    // Recheck onboarding exceptions inside the write transaction so they
    // cannot be replayed after bootstrap or after the legacy role is set.
    if (firstOwnerException && !canCompleteFirstOwnerSetup(principal.principal_id)) {
      throw new Error("Owner promotion requires an authorized actor");
    }
    if (legacyDashboardAdminException && !canAssignLegacyDashboardAdministrator(principal.principal_id)) {
      throw new Error("Legacy Dashboard administrator assignment is no longer available");
    }
    if (!firstOwnerException && !legacyDashboardAdminException &&
        !require("./authorization").authorize({ principalId: actorPrincipalId, permission: "roles.manage" }).ok) {
      throw new Error(role === "owner" ? "Owner promotion requires an authorized actor" : "Role assignment requires roles.manage");
    }
    db.prepare("INSERT INTO principal_roles (principal_id, role_name, assigned_by_principal_id, assigned_at) VALUES (?, ?, ?, ?)").run(principal.principal_id, role, actorPrincipalId, now());
    audit("role.assigned", principal.principal_id, actorPrincipalId, {
      role,
      ...(legacyDashboardAdminException ? { authority: "legacy_dashboard_basic_auth_onboarding" } : {}),
    });
  })();
  return getPrincipal(principal.principal_id);
}

function canCompleteFirstOwnerSetup(principalIdValue) {
  const principal = getPrincipal(principalIdValue);
  if (!principal || principal.principal_type !== "human" || principal.metadata?.adopted_legacy_dashboard !== true) return false;
  const db = dbStore.getDb();
  if (db.prepare("SELECT 1 FROM identity_bootstrap WHERE singleton_id = 1").get()) return false;
  return !db.prepare("SELECT 1 FROM principal_roles WHERE role_name = 'owner' LIMIT 1").get();
}

function canAssignLegacyDashboardAdministrator(principalIdValue) {
  const principal = getPrincipal(principalIdValue);
  if (!principal || principal.principal_type !== "human" || principal.roles.length > 0 ||
      principal.metadata?.adopted_legacy_dashboard !== true ||
      typeof principal.metadata?.legacy_dashboard_username !== "string" ||
      !principal.metadata.legacy_dashboard_username.trim()) return false;
  const db = dbStore.getDb();
  return Boolean(db.prepare("SELECT 1 FROM principal_roles WHERE role_name = 'owner' LIMIT 1").get());
}

function grantPrincipalPermission(principalIdValue, permission, actorIdentity) {
  const targetId = requiredText(principalIdValue, "principal_id");
  const actorPrincipalId = typeof actorIdentity === "string" ? actorIdentity : actorIdentity?.principal_id;
  const authorization = require("./authorization");
  const authority = { principalId: actorPrincipalId, ...(Array.isArray(actorIdentity?.scopes) ? { credentialScopes: actorIdentity.scopes } : {}), delegationId: actorIdentity?.delegation_id || null };
  if (!actorPrincipalId || !authorization.authorize({ ...authority, permission: "roles.manage" }).ok) {
    throw new Error("Permission grants require roles.manage");
  }
  if (!authorization.knownPermission(permission)) throw new Error(`Unknown permission: ${permission}`);
  if (!authorization.authorize({ ...authority, permission }).ok) throw new Error(`Actor lacks permission: ${permission}`);
  const db = dbStore.getDb();
  db.transaction(() => {
    const principal = getPrincipal(targetId);
    if (!principal || principal.principal_type !== "service") throw new Error("service principal not found");
    if (!authorization.authorize({ ...authority, permission: "roles.manage" }).ok) throw new Error("Permission grants require roles.manage");
    if (!authorization.authorize({ ...authority, permission }).ok) throw new Error(`Actor lacks permission: ${permission}`);
    db.prepare(`INSERT OR IGNORE INTO identity_principal_permissions (principal_id, permission, assigned_by_principal_id, assigned_at)
      VALUES (?, ?, ?, ?)`).run(principal.principal_id, permission, actorPrincipalId, now());
    audit("principal.permission_granted", principal.principal_id, actorPrincipalId, { permission });
  })();
  return getPrincipalPermissions(targetId);
}

function revokePrincipalPermission(principalIdValue, permission, actorIdentity) {
  const targetId = requiredText(principalIdValue, "principal_id");
  const actorPrincipalId = typeof actorIdentity === "string" ? actorIdentity : actorIdentity?.principal_id;
  const authorization = require("./authorization");
  const authority = {
    principalId: actorPrincipalId,
    ...(Array.isArray(actorIdentity?.scopes) ? { credentialScopes: actorIdentity.scopes } : {}),
    delegationId: actorIdentity?.delegation_id || null,
  };
  if (!actorPrincipalId || !authorization.authorize({ ...authority, permission: "roles.manage" }).ok) {
    throw new Error("Permission changes require roles.manage");
  }
  const db = dbStore.getDb();
  db.transaction(() => {
    const principal = getPrincipal(targetId);
    if (!principal || principal.principal_type !== "service") throw new Error("service principal not found");
    if (!authorization.authorize({ ...authority, permission: "roles.manage" }).ok) throw new Error("Permission changes require roles.manage");
    db.prepare("DELETE FROM identity_principal_permissions WHERE principal_id = ? AND permission = ?").run(principal.principal_id, permission);
    audit("principal.permission_revoked", principal.principal_id, actorPrincipalId, { permission });
  })();
  return getPrincipalPermissions(targetId);
}

function getPrincipalPermissions(principalIdValue) {
  return dbStore.getDb().prepare("SELECT permission FROM identity_principal_permissions WHERE principal_id = ? ORDER BY permission")
    .all(requiredText(principalIdValue, "principal_id")).map(row => row.permission);
}

function removeRole(principalIdValue, role, actorPrincipalId = null) {
  validateRole(role);
  const principal = getPrincipal(principalIdValue);
  if (!principal) throw new Error("principal not found");
  if (!actorPrincipalId || !require("./authorization").authorize({ principalId: actorPrincipalId, permission: "roles.manage" }).ok) {
    throw new Error(role === "owner" ? "Owner demotion requires roles.manage" : "Role removal requires roles.manage");
  }
  const db = dbStore.getDb();
  db.transaction(() => {
    if (!require("./authorization").authorize({ principalId: actorPrincipalId, permission: "roles.manage" }).ok) {
      throw new Error(role === "owner" ? "Owner demotion requires roles.manage" : "Role removal requires roles.manage");
    }
    if (role === "owner") {
      const remaining = db.prepare(`SELECT COUNT(*) AS count FROM principal_roles pr JOIN principals p ON p.principal_id = pr.principal_id WHERE pr.role_name = 'owner' AND p.enabled = 1 AND pr.principal_id <> ?`).get(principal.principal_id).count;
      if (remaining < 1) throw new Error("cannot remove the final usable Owner");
    }
    db.prepare("DELETE FROM principal_roles WHERE principal_id = ? AND role_name = ?").run(principal.principal_id, role);
    audit("role.removed", principal.principal_id, actorPrincipalId, { role });
  })();
  return getPrincipal(principal.principal_id);
}

function bootstrapOwner({ username, password, displayName, metadata = {} } = {}) {
  const db = dbStore.getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM identity_bootstrap WHERE singleton_id = 1").get()) throw new Error("Owner bootstrap has already been completed");
    if (db.prepare("SELECT 1 FROM principal_roles WHERE role_name = 'owner' LIMIT 1").get()) throw new Error("Owner already exists");
    const user = createHumanUser({ username, password, displayName, metadata });
    db.prepare("INSERT INTO principal_roles (principal_id, role_name, assigned_at) VALUES (?, 'owner', ?)").run(user.principal_id, now());
    db.prepare("INSERT INTO identity_bootstrap (singleton_id, owner_principal_id, completed_at) VALUES (1, ?, ?)").run(user.principal_id, now());
    audit("bootstrap.owner_completed", user.principal_id, user.principal_id, { username });
    db.exec("COMMIT");
    return getPrincipal(user.principal_id);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function setPrincipalEnabled(id, enabled, actorPrincipalId = null) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  const principal = getPrincipal(id);
  if (!principal) throw new Error("principal not found");
  const authorization = require("./authorization");
  if (!actorPrincipalId || !authorization.authorize({ principalId: actorPrincipalId, permission: "principals.manage" }).ok) {
    throw new Error("Principal state changes require principals.manage");
  }
  const timestamp = now();
  const db = dbStore.getDb();
  return db.transaction(() => {
    if (!authorization.authorize({ principalId: actorPrincipalId, permission: "principals.manage" }).ok) {
      throw new Error("Principal state changes require principals.manage");
    }
    const currentPrincipal = getPrincipal(id);
    if (!currentPrincipal) throw new Error("principal not found");
    if (!enabled && currentPrincipal.roles.includes("owner")) {
      const remaining = db.prepare(`SELECT COUNT(*) AS count FROM principal_roles pr JOIN principals p ON p.principal_id = pr.principal_id WHERE pr.role_name = 'owner' AND p.enabled = 1 AND pr.principal_id <> ?`).get(currentPrincipal.principal_id).count;
      if (remaining < 1) throw new Error("cannot disable the final usable Owner");
    }
    db.prepare("UPDATE principals SET enabled = ?, disabled_at = ?, updated_at = ? WHERE principal_id = ?").run(enabled ? 1 : 0, enabled ? null : timestamp, timestamp, currentPrincipal.principal_id);
    if (!enabled) db.prepare("UPDATE identity_sessions SET invalidated_at = ? WHERE principal_id = ? AND invalidated_at IS NULL").run(timestamp, currentPrincipal.principal_id);
    audit(enabled ? "principal.enabled" : "principal.disabled", currentPrincipal.principal_id, actorPrincipalId, {});
    return getPrincipal(currentPrincipal.principal_id);
  })();
}

function changePassword(id, password, actorPrincipalId = null) {
  const principal = getPrincipal(id);
  if (!principal || principal.principal_type !== "human") throw new Error("human principal not found");
  const authorization = require("./authorization");
  const actor = actorPrincipalId ? getPrincipal(actorPrincipalId) : null;
  const isEnabledSelfChange = actor?.principal_id === principal.principal_id && actor.enabled;
  if (!isEnabledSelfChange && (!actorPrincipalId || !authorization.authorize({ principalId: actorPrincipalId, permission: "users.manage" }).ok)) {
    throw new Error("Password changes require the current user or users.manage");
  }
  const digest = passwordHash(password);
  const timestamp = now();
  const db = dbStore.getDb();
  return db.transaction(() => {
    const currentActor = actorPrincipalId ? getPrincipal(actorPrincipalId) : null;
    const currentTarget = getPrincipal(id);
    if (!currentTarget || currentTarget.principal_type !== "human") throw new Error("human principal not found");
    const stillSelfChange = currentActor?.principal_id === currentTarget.principal_id && currentActor.enabled;
    if (!stillSelfChange && (!actorPrincipalId || !authorization.authorize({ principalId: actorPrincipalId, permission: "users.manage" }).ok)) {
      throw new Error("Password changes require the current user or users.manage");
    }
    db.prepare("UPDATE human_users SET password_hash = ?, password_changed_at = ?, last_login_at = NULL WHERE principal_id = ?").run(digest, timestamp, currentTarget.principal_id);
    db.prepare("UPDATE identity_sessions SET invalidated_at = ? WHERE principal_id = ? AND invalidated_at IS NULL").run(timestamp, currentTarget.principal_id);
    audit("user.password_changed", currentTarget.principal_id, actorPrincipalId, {});
    return getPrincipal(currentTarget.principal_id);
  })();
}

function verifyUserPassword(username, password) {
  const row = dbStore.getDb().prepare("SELECT p.*, h.password_hash FROM principals p JOIN human_users h ON h.principal_id = p.principal_id WHERE h.username = ?").get(requiredText(username, "username", 80));
  if (!row || !row.enabled || !verifyPassword(password, row.password_hash)) return null;
  const db = dbStore.getDb();
  db.transaction(() => {
    db.prepare("UPDATE human_users SET last_login_at = ? WHERE principal_id = ?").run(now(), row.principal_id);
    audit("user.login_succeeded", row.principal_id, row.principal_id, {});
  })();
  return getPrincipal(row.principal_id);
}

module.exports = Object.freeze({ PRINCIPAL_TYPES, ROLE_NAMES, PASSWORD_SCHEME, MIN_PASSWORD_LENGTH, passwordHash, verifyPassword, getPrincipal, getHumanUser, listPrincipals, createPrincipal, createHumanUser, updatePrincipal, updateUsername, assignRole, canCompleteFirstOwnerSetup, canAssignLegacyDashboardAdministrator, removeRole, grantPrincipalPermission, revokePrincipalPermission, getPrincipalPermissions, bootstrapOwner, setPrincipalEnabled, changePassword, verifyUserPassword, recordAuditEvent });
