"use strict";

const identityStore = require("../core/identity");
const authorization = require("../core/authorization");
const projectAccess = require("../core/project-access");

function taskBelongsToIdentity(identity, task) {
  if (!identity) return false;
  if (identity.principal_id) {
    // Dashboard proxy assertions are authenticated before they cross the
    // service boundary, but task reads may occur after that request context
    // was captured. Recheck principal state here as well, including unscoped
    // tasks that do not pass through projectAccess's principal check.
    const principal = identityStore.getPrincipal(identity.principal_id);
    if (!principal?.enabled) return false;
    const owner = task && (task.actor_principal_id || task.requested_by_principal_id);
    if (!owner || owner !== identity.principal_id) return false;
    if (!task.project_id) return true;
    return projectAccess.hasProjectPermission(identity.principal_id, task.project_id, "agent.tasks.read", "read", identity.scopes, identity.delegation_id || null);
  }
  return identity.service === "certification" && task?.principal_context?.service_identity === identity.service;
}

function canReviewUnownedTask(identity, task) {
  const principalId = identity && identity.principal_id;
  if (!principalId || !task) return false;
  const principal = identityStore.getPrincipal(principalId);
  if (!principal || principal.principal_type !== "human") return false;
  const scopes = identity.scopes;
  const delegationId = identity.delegation_id || null;
  if (!authorization.authorize({ principalId, permission: "approvals.grant", credentialScopes: scopes, delegationId, resource: { kind: "agent_task_review", task_id: task.task_id, project: task.project_id } }).ok) return false;
  return projectAccess.hasProjectPermission(principalId, task.project_id, "approvals.grant", "read", scopes, delegationId);
}

function isAllowedCertificationRoute(method, path) {
  const verb = String(method || "").toUpperCase();
  const route = String(path || "");
  return verb === "POST" && route === "/agent/run" ||
    verb === "GET" && /^\/agent\/tasks\/[A-Za-z0-9_.:-]{1,180}\/control-room$/.test(route) ||
    verb === "POST" && /^\/agent\/run\/[A-Za-z0-9_.:-]{1,180}\/cancel$/.test(route);
}

function isAllowedServiceRoute(service, method, path) {
  const name = String(service || "");
  const verb = String(method || "").toUpperCase();
  const route = String(path || "");
  if (name === "certification") return isAllowedCertificationRoute(verb, route);
  if (name === "scheduler") {
    return verb === "POST" && ["/delays/reload", "/watches/reload"].includes(route);
  }
  return false;
}

module.exports = Object.freeze({ taskBelongsToIdentity, canReviewUnownedTask, isAllowedCertificationRoute, isAllowedServiceRoute });
