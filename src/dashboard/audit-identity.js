"use strict";

const { redactSensitiveKeysDeep } = require("../redact");

function principalForRequest(req) {
  const principal = req?.authPrincipal;
  if (principal && typeof principal.principal_id === "string" && principal.principal_id) {
    return principal;
  }
  if (typeof req?.authPrincipalId === "string" && req.authPrincipalId) {
    return {
      principal_id: req.authPrincipalId,
      principal_type: null,
      display_name: typeof req.authUser === "string" ? req.authUser : null,
    };
  }
  return null;
}

function dashboardActor(req) {
  const principal = principalForRequest(req);
  if (principal) return principal.principal_id;
  return typeof req?.authUser === "string" && req.authUser ? req.authUser : "anonymous";
}

function createDashboardAuditEntry(req, action, details, actor = null, timestamp = new Date().toISOString()) {
  const principal = principalForRequest(req);
  const displayName = typeof actor === "string" && actor
    ? actor
    : (typeof principal?.display_name === "string" && principal.display_name)
      || (typeof req?.authUser === "string" && req.authUser)
      || (principal?.principal_id || "anonymous");
  return redactSensitiveKeysDeep({
    timestamp,
    action,
    key: req?.params?.key || null,
    ip: req?.ip || null,
    user: displayName,
    principal_id: principal?.principal_id || null,
    principal_type: principal?.principal_type || null,
    details,
  });
}

module.exports = { principalForRequest, dashboardActor, createDashboardAuditEntry };
