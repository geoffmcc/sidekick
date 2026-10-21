"use strict";

const toolContext = require("../context");
const { canonicalizeProjectName } = require("../../core/project-identity");
const projectAccess = require("../../core/project-access");

function contextProject() {
  const project = toolContext.getExecutionContext().project;
  return project ? canonicalizeProjectName(project) : null;
}

function authenticatedPrincipal() {
  return toolContext.getExecutionContext().authIdentity?.principal_id || null;
}

function currentContext() { return toolContext.getExecutionContext(); }

function credentialScopes() { return currentContext().authIdentity?.scopes; }
function delegationId() { return currentContext().authIdentity?.delegation_id || currentContext().authIdentity?.delegationId || null; }

function assertProjectAccess(principalId, project, access) {
  if (!projectAccess.hasProjectAccess(principalId, project, access, credentialScopes(), delegationId())) throw new Error("memory project scope denied");
}

function scopedProject(requested, access = "read") {
  const context = currentContext();
  const bound = contextProject();
  const asked = requested ? canonicalizeProjectName(requested) : null;
  if (bound && asked && bound !== asked) throw new Error("memory project scope denied");
  const effective = bound || asked || null;
  const principalId = authenticatedPrincipal();
  if (principalId) {
    if (projectAccess.hasGlobalMemoryAccess(principalId, access, credentialScopes(), delegationId())) return effective;
    if (!effective) throw new Error("an authorized project scope is required for memory access");
    assertProjectAccess(principalId, effective, access);
    return effective;
  }
  if (context.authIdentity || ["dashboard", "mcp", "agent"].includes(context.source)) {
    throw new Error("an authenticated principal with project access is required for memory access");
  }
  return effective;
}

function inScope(memory, access = "read", requestedProject = null) {
  const context = currentContext();
  const bound = contextProject();
  const asked = requestedProject ? canonicalizeProjectName(requestedProject) : null;
  if (bound && asked && bound !== asked) return false;
  const effective = bound || asked;
  const principalId = authenticatedPrincipal();
  if (principalId) {
    if (projectAccess.hasGlobalMemoryAccess(principalId, access, credentialScopes(), delegationId()) && !effective) return true;
    const project = effective || memory?.project;
    if (!project || !projectAccess.hasProjectAccess(principalId, project, access, credentialScopes(), delegationId())) return false;
    return Boolean(memory?.project && canonicalizeProjectName(memory.project) === canonicalizeProjectName(project));
  }
  if (context.authIdentity || ["dashboard", "mcp", "agent"].includes(context.source)) return false;
  if (!effective) return true;
  return Boolean(memory && memory.project && canonicalizeProjectName(memory.project) === effective);
}

function assertInScope(memory, access = "read", requestedProject = null) {
  if (!inScope(memory, access, requestedProject)) throw new Error("memory project scope denied");
  return memory;
}

module.exports = { contextProject, scopedProject, inScope, assertInScope };
