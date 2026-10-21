"use strict";

const dbStore = require("../db");
const identity = require("./identity");
const authorization = require("./authorization");
const platformKernel = require("../platform/kernel");
const { canonicalizeProjectName } = require("./project-identity");

const ACCESS_LEVELS = Object.freeze(["read", "write"]);
const MANAGE_PERMISSION = "projects.access.manage";
const MEMORY_PERMISSIONS = Object.freeze({ read: "memory.read", write: "memory.write" });

function projectId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("project is required");
  return canonicalizeProjectName(value);
}

function hasGlobalProjectAccess(principalId, credentialScopes, delegationId = null) {
  return Boolean(principalId && authorization.authorize({ principalId, permission: MANAGE_PERMISSION, credentialScopes, delegationId }).ok);
}

function hasGlobalMemoryAccess(principalId, required = "read", credentialScopes, delegationId = null) {
  const permission = MEMORY_PERMISSIONS[required];
  if (!permission) return false;
  return Boolean(principalId
    && authorization.authorize({ principalId, permission, credentialScopes, delegationId }).ok
    && hasGlobalProjectAccess(principalId, credentialScopes, delegationId));
}

function hasProjectAccess(principalId, project, required = "read", credentialScopes, delegationId = null) {
  const permission = MEMORY_PERMISSIONS[required];
  return permission ? hasProjectPermission(principalId, project, permission, required, credentialScopes, delegationId) : false;
}

function hasProjectMembership(principalId, project, required = "read", credentialScopes, delegationId = null) {
  if (!principalId || !ACCESS_LEVELS.includes(required) || !identity.getPrincipal(principalId)?.enabled) return false;
  // Managers retain their existing global access contract, including for
  // legacy project identifiers that have not yet been registered.
  if (hasGlobalProjectAccess(principalId, credentialScopes, delegationId)) return true;
  let normalized;
  try { normalized = projectId(project); } catch { return false; }
  const projectRow = platformKernel.getProject(normalized);
  if (!projectRow || projectRow.state !== "active") return false;
  if (projectRow.owner_actor_id === principalId) return true;
  const grant = dbStore.getDb().prepare(`
    SELECT access_level FROM platform_project_principal_access
    WHERE project_id = ? AND principal_id = ? AND revoked_at IS NULL
  `).get(normalized, principalId);
  return Boolean(grant && (grant.access_level === "write" || required === "read"));
}

function hasProjectPermission(principalId, project, permission, required = "read", credentialScopes, delegationId = null) {
  if (!principalId || typeof permission !== "string" || !permission || !ACCESS_LEVELS.includes(required)) return false;
  if (!identity.getPrincipal(principalId)?.enabled) return false;
  if (!authorization.authorize({ principalId, permission, credentialScopes, delegationId }).ok) return false;
  return hasProjectMembership(principalId, project, required, credentialScopes, delegationId);
}

function listAccessibleProjects(principalId, credentialScopes, delegationId = null) {
  return listAccessibleProjectsForPermission(principalId, MEMORY_PERMISSIONS.read, credentialScopes, delegationId);
}

function listAccessibleProjectsForPermission(principalId, permission, credentialScopes, delegationId = null) {
  if (!principalId || typeof permission !== "string" || !permission) return [];
  if (!identity.getPrincipal(principalId)?.enabled) return [];
  if (!authorization.authorize({ principalId, permission, credentialScopes, delegationId }).ok) return [];
  if (hasGlobalProjectAccess(principalId, credentialScopes, delegationId)) return platformKernel.listProjects({ state: "active", limit: 1000 });
  return dbStore.getDb().prepare(`
    SELECT p.*, COALESCE(a.access_level, CASE WHEN p.owner_actor_id = ? THEN 'write' END) AS access_level
    FROM platform_projects p
    LEFT JOIN platform_project_principal_access a ON a.project_id = p.project_id
      AND a.principal_id = ? AND a.revoked_at IS NULL
    WHERE p.state = 'active' AND (a.principal_id IS NOT NULL OR p.owner_actor_id = ?)
    ORDER BY p.display_name
  `).all(principalId, principalId, principalId).map(row => ({
    project_id: row.project_id,
    display_name: row.display_name,
    description: row.description,
    state: row.state,
    access_level: row.access_level,
  }));
}

function listProjectAccess(project) {
  const normalized = projectId(project);
  return dbStore.getDb().prepare(`
    SELECT a.project_id, a.principal_id, p.display_name, p.principal_type,
           a.access_level, a.granted_by_principal_id, a.granted_at
    FROM platform_project_principal_access a
    JOIN principals p ON p.principal_id = a.principal_id
    WHERE a.project_id = ? AND a.revoked_at IS NULL
    ORDER BY p.display_name
  `).all(normalized);
}

function assertManageGrant(actorPrincipalId, credentialScopes) {
  if (!hasGlobalProjectAccess(actorPrincipalId, credentialScopes)) throw new Error("projects.access.manage is required");
}

function grantProjectAccess({ actorPrincipalId, credentialScopes, principalId, project, accessLevel } = {}) {
  assertManageGrant(actorPrincipalId, credentialScopes);
  const normalizedProject = projectId(project);
  if (!ACCESS_LEVELS.includes(accessLevel)) throw new Error("access_level must be read or write");
  const principal = identity.getPrincipal(principalId);
  if (!principal?.enabled) throw new Error("enabled principal not found");
  if (!platformKernel.getProject(normalizedProject)) throw new Error("project not found");
  const grantedAt = new Date().toISOString();
  const db = dbStore.getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO platform_project_principal_access
        (project_id, principal_id, access_level, granted_by_principal_id, granted_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(project_id, principal_id) DO UPDATE SET
        access_level = excluded.access_level,
        granted_by_principal_id = excluded.granted_by_principal_id,
        granted_at = excluded.granted_at,
        revoked_at = NULL
    `).run(normalizedProject, principal.principal_id, accessLevel, actorPrincipalId, grantedAt);
    identity.recordAuditEvent("project.access.granted", principal.principal_id, actorPrincipalId, {
      project_id: normalizedProject,
      access_level: accessLevel,
    });
  })();
  return { project_id: normalizedProject, principal_id: principal.principal_id, access_level: accessLevel, granted_by_principal_id: actorPrincipalId, granted_at: grantedAt };
}

function revokeProjectAccess({ actorPrincipalId, credentialScopes, principalId, project } = {}) {
  assertManageGrant(actorPrincipalId, credentialScopes);
  const normalizedProject = projectId(project);
  const current = dbStore.getDb().prepare(`
    SELECT access_level FROM platform_project_principal_access
    WHERE project_id = ? AND principal_id = ? AND revoked_at IS NULL
  `).get(normalizedProject, principalId);
  if (!current) return false;
  const revokedAt = new Date().toISOString();
  const db = dbStore.getDb();
  db.transaction(() => {
    db.prepare(`
      UPDATE platform_project_principal_access SET revoked_at = ?
      WHERE project_id = ? AND principal_id = ? AND revoked_at IS NULL
    `).run(revokedAt, normalizedProject, principalId);
    identity.recordAuditEvent("project.access.revoked", principalId, actorPrincipalId, { project_id: normalizedProject, access_level: current.access_level });
  })();
  return true;
}

module.exports = Object.freeze({ ACCESS_LEVELS, MANAGE_PERMISSION, MEMORY_PERMISSIONS, hasGlobalProjectAccess, hasGlobalMemoryAccess, hasProjectAccess, hasProjectPermission, hasProjectMembership, listAccessibleProjects, listAccessibleProjectsForPermission, listProjectAccess, grantProjectAccess, revokeProjectAccess });
