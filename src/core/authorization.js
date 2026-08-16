"use strict";

const crypto = require("crypto");
const dbStore = require("../db");
const identity = require("./identity");

const PERMISSION_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const RISK_ORDER = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function text(value, field, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be a bounded string`);
  return value.trim();
}
function permissionName(permission) {
  const value = text(permission, "permission");
  if (!PERMISSION_RE.test(value)) throw new Error("permission has an invalid namespace");
  return value;
}

function knownPermission(permission) {
  const name = permissionName(permission);
  return dbStore.getDb().prepare("SELECT permission, description, risk FROM identity_permissions WHERE permission = ?").get(name) || null;
}

function rolePermissions(principalId) {
  const rows = dbStore.getDb().prepare(`
    SELECT DISTINCT rp.permission
    FROM principal_roles pr
    JOIN identity_role_permissions rp ON rp.role_name = pr.role_name
    WHERE pr.principal_id = ?
  `).all(text(principalId, "principal_id"));
  return new Set(rows.map(row => row.permission));
}

function activeDelegation(delegationId, delegatePrincipalId) {
  if (!delegationId) return null;
  const row = dbStore.getDb().prepare(`SELECT * FROM identity_delegations WHERE delegation_id = ? AND delegate_principal_id = ? AND revoked_at IS NULL`).get(delegationId, delegatePrincipalId);
  if (!row || (row.expires_at && row.expires_at <= now())) return null;
  return { ...row, permissions: parseJson(row.permissions_json, []) };
}

function effectivePermissions(principalId, { delegationId = null, credentialScopes = null } = {}) {
  const principal = identity.getPrincipal(principalId);
  if (!principal) return { ok: false, code: "principal-not-found", permissions: new Set() };
  if (!principal.enabled) return { ok: false, code: "principal-disabled", permissions: new Set() };
  const permissions = rolePermissions(principal.principal_id);
  let delegation = null;
  if (delegationId) {
    delegation = activeDelegation(delegationId, principal.principal_id);
    if (!delegation) return { ok: false, code: "delegation-revoked-or-expired", permissions: new Set() };
    // Delegated authority is the intersection of the explicit grant and the
    // delegator's current authority. A delegate need not hold the permission
    // in its own role bundle, but the delegator must still hold it now.
    const delegatorPermissions = rolePermissions(delegation.delegator_principal_id);
    const granted = new Set(delegation.permissions);
    permissions.clear();
    for (const permission of granted) if (delegatorPermissions.has(permission)) permissions.add(permission);
  }
  if (Array.isArray(credentialScopes) && credentialScopes.length) {
    const scopes = new Set(credentialScopes.map(scope => String(scope).trim()));
    for (const permission of [...permissions]) if (!scopes.has("*") && !scopes.has(permission)) permissions.delete(permission);
  }
  return { ok: true, permissions, delegation };
}

function authorize({ principalId, permission, credentialScopes = null, delegationId = null, resource = null } = {}) {
  let requested;
  try { requested = knownPermission(permission); } catch { return { ok: false, code: "unknown-permission", permission: String(permission || "") }; }
  if (!requested) return { ok: false, code: "unknown-permission", permission: String(permission || "") };
  if (!principalId) return { ok: false, code: "unauthenticated", permission: requested.permission };
  const effective = effectivePermissions(principalId, { delegationId, credentialScopes });
  if (!effective.ok) return { ok: false, code: effective.code, permission: requested.permission };
  const allowed = effective.permissions.has(requested.permission);
  const result = { ok: allowed, code: allowed ? "allowed" : "forbidden", permission: requested.permission, risk: requested.risk, resource: resource || null };
  if (effective.delegation) result.delegation_id = effective.delegation.delegation_id;
  return result;
}

function createDelegation({ delegatorPrincipalId, delegatePrincipalId, permissions, expiresAt = null, actorPrincipalId = null } = {}) {
  const delegator = identity.getPrincipal(text(delegatorPrincipalId, "delegator_principal_id"));
  const delegate = identity.getPrincipal(text(delegatePrincipalId, "delegate_principal_id"));
  if (!delegator || !delegate) throw new Error("delegator and delegate principals are required");
  if (!delegator.enabled || !delegate.enabled) throw new Error("disabled principals cannot delegate");
  if (delegator.principal_id === delegate.principal_id) throw new Error("a principal cannot delegate to itself");
  if (!Array.isArray(permissions) || permissions.length === 0) throw new Error("delegation permissions are required");
  const unique = [...new Set(permissions.map(permissionName))];
  for (const permission of unique) {
    if (!knownPermission(permission)) throw new Error(`Unknown permission: ${permission}`);
    const check = authorize({ principalId: delegator.principal_id, permission });
    if (!check.ok) throw new Error(`Delegator lacks permission: ${permission}`);
  }
  const expiry = expiresAt == null ? null : new Date(expiresAt).toISOString();
  if (expiry && expiry <= now()) throw new Error("expires_at must be in the future");
  const delegationId = id("dlg");
  dbStore.getDb().prepare(`INSERT INTO identity_delegations (delegation_id, delegator_principal_id, delegate_principal_id, permissions_json, created_at, expires_at, created_by_principal_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(delegationId, delegator.principal_id, delegate.principal_id, JSON.stringify(unique), now(), expiry, actorPrincipalId || delegator.principal_id);
  identity.recordAuditEvent("delegation.created", delegate.principal_id, actorPrincipalId || delegator.principal_id, { delegation_id: delegationId, delegator_principal_id: delegator.principal_id, permissions: unique, expires_at: expiry });
  return getDelegation(delegationId);
}

function getDelegation(delegationId) {
  const row = dbStore.getDb().prepare("SELECT * FROM identity_delegations WHERE delegation_id = ?").get(text(delegationId, "delegation_id"));
  if (!row) return null;
  return Object.freeze({ delegation_id: row.delegation_id, delegator_principal_id: row.delegator_principal_id, delegate_principal_id: row.delegate_principal_id, permissions: parseJson(row.permissions_json, []), created_at: row.created_at, expires_at: row.expires_at || null, revoked_at: row.revoked_at || null, created_by_principal_id: row.created_by_principal_id || null });
}

function revokeDelegation(delegationId, actorPrincipalId = null) {
  const delegation = getDelegation(delegationId);
  if (!delegation) throw new Error("delegation not found");
  if (delegation.revoked_at) return delegation;
  const actor = actorPrincipalId || delegation.delegator_principal_id;
  if (actor !== delegation.delegator_principal_id && !authorize({ principalId: actor, permission: "principals.manage" }).ok) throw new Error("only the delegator or an authorized administrator may revoke delegation");
  dbStore.getDb().prepare("UPDATE identity_delegations SET revoked_at = ? WHERE delegation_id = ? AND revoked_at IS NULL").run(now(), delegation.delegation_id);
  identity.recordAuditEvent("delegation.revoked", delegation.delegate_principal_id, actor, { delegation_id: delegation.delegation_id });
  return getDelegation(delegation.delegation_id);
}

module.exports = Object.freeze({ RISK_ORDER, knownPermission, rolePermissions, effectivePermissions, authorize, createDelegation, getDelegation, revokeDelegation });
