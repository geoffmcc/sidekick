"use strict";

const PROJECT = "agent_certification";
const EXECUTION_SCOPES = Object.freeze([
  "tools.execute",
  "tools.execute_high",
  "memory.read",
  "memory.write",
  "principals.manage",
  "network_scopes.read",
]);
const PROJECT_ADMIN_SCOPE = "projects.access.manage";

function createCertificationIdentity() {
  const db = require("../db");
  db.runPendingMigrations();
  const identity = require("../core/identity");
  const kernel = require("../platform/kernel");
  const projectAccess = require("../core/project-access");
  const principal = identity.createPrincipal({
    type: "service",
    displayName: "Ephemeral certification runner",
    metadata: { service: "certification", ephemeral: true },
  });
  identity.assignRole(principal.principal_id, "administrator");

  let accessGranted = false;
  try {
    if (!kernel.getProject(PROJECT)) {
      kernel.registerProject({ project_id: PROJECT, display_name: "Isolated certification", source: "certification" });
    }
    const project = kernel.getProject(PROJECT);
    if (!project || project.state !== "active") throw new Error("Certification project is unavailable or inactive");
    projectAccess.grantProjectAccess({
      actorPrincipalId: principal.principal_id,
      credentialScopes: [PROJECT_ADMIN_SCOPE],
      principalId: principal.principal_id,
      project: PROJECT,
      accessLevel: "write",
    });
    accessGranted = true;
  } catch (error) {
    try { identity.setPrincipalEnabled(principal.principal_id, false, principal.principal_id); } catch {}
    throw error;
  }

  let closed = false;
  return Object.freeze({
    project: PROJECT,
    authIdentity: Object.freeze({
      principal_id: principal.principal_id,
      principal_type: "service",
      scopes: EXECUTION_SCOPES,
      authentication_method: "bounded_ephemeral_service",
    }),
    close() {
      if (closed) return;
      closed = true;
      let cleanupError = null;
      try {
        if (accessGranted) projectAccess.revokeProjectAccess({
          actorPrincipalId: principal.principal_id,
          credentialScopes: [PROJECT_ADMIN_SCOPE],
          principalId: principal.principal_id,
          project: PROJECT,
        });
        // Retain the audit-visible project row; do not delete persistent data.
        // It has no owner and no certification principal retains membership.
      } catch (error) { cleanupError = error; }
      try { identity.setPrincipalEnabled(principal.principal_id, false, principal.principal_id); }
      catch (error) { cleanupError ||= error; }
      if (cleanupError) throw new Error("Certification service identity cleanup failed", { cause: cleanupError });
    },
  });
}

module.exports = Object.freeze({ PROJECT, EXECUTION_SCOPES, createCertificationIdentity });
