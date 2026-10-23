"use strict";

const toolContext = require("./context");

function requireCanonicalInvocation(expectedToolName) {
  const context = toolContext.getExecutionContext();
  const remoteAuthorization = context.nodeAuthorization;
  const remoteInvocation = remoteAuthorization?.resource?.tool === expectedToolName &&
    typeof remoteAuthorization.permission === "string" && remoteAuthorization.permission.length > 0;
  const canonicalInvocation = remoteInvocation ||
    require("./dispatcher").consumeCanonicalInvocation(context, expectedToolName);
  if (canonicalInvocation) return null;
  return {
    content: [{ type: "text", text: "Privileged handler requires canonical dispatch" }],
    isError: true,
    code: "canonical_dispatch_required",
  };
}

function requireToolExecution(resource, permission = "tools.execute", expectedToolName = null) {
  const context = toolContext.getExecutionContext();
  const authIdentity = context.authIdentity || null;
  const decision = require("../core/authorization").authorize({
    principalId: authIdentity?.principal_id || null,
    permission,
    credentialScopes: authIdentity?.scopes,
    delegationId: authIdentity?.delegation_id || null,
    resource: resource || null,
  });
  // Remote node work carries a server-created tool/permission projection from
  // canonical dispatch. The worker rechecks its local identity grant; Core
  // revalidates the projection at claim, renewal and result publication.
  // Core-local calls instead need the dispatcher's private one-shot capability.
  const remoteAuthorization = context.nodeAuthorization;
  const remoteInvocation = remoteAuthorization?.resource?.tool === expectedToolName &&
    remoteAuthorization.permission === permission;
  const canonicalInvocation = remoteInvocation ||
    require("./dispatcher").consumeCanonicalInvocation(context, expectedToolName);
  if (decision.ok && canonicalInvocation) return null;
  const unauthenticated = !decision.ok && decision.code === "unauthenticated";
  const code = !decision.ok
    ? (unauthenticated ? "unauthenticated" : "forbidden")
    : "canonical_dispatch_required";
  return {
    content: [{ type: "text", text: unauthenticated ? "Authentication required" : canonicalInvocation ? "Tool execution permission denied" : "Privileged handler requires canonical dispatch" }],
    isError: true,
    code,
  };
}

function requirePermission(permission, resource = null) {
  const context = toolContext.getExecutionContext();
  const authIdentity = context.authIdentity || null;
  const decision = require("../core/authorization").authorize({
    principalId: authIdentity?.principal_id || null,
    permission,
    credentialScopes: authIdentity?.scopes,
    delegationId: authIdentity?.delegation_id || authIdentity?.delegationId || null,
    resource,
  });
  if (decision.ok) return null;
  const unauthenticated = decision.code === "unauthenticated";
  return {
    content: [{ type: "text", text: unauthenticated ? "Authentication required" : "Required permission denied" }],
    isError: true,
    code: unauthenticated ? "unauthenticated" : "forbidden",
  };
}

module.exports = Object.freeze({ requireCanonicalInvocation, requireToolExecution, requirePermission });
