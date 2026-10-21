"use strict";

function createServiceContext({ role = "operator", source = "test", scopes = null, project = null } = {}) {
  const db = require("../../src/db");
  db.runPendingMigrations();
  const identity = require("../../src/core/identity");
  const principal = identity.createPrincipal({ type: "service", displayName: `Test ${role} principal` });
  identity.assignRole(principal.principal_id, role);
  if (project) require("../../src/platform/kernel").registerProject({ project_id: project, owner_actor_id: principal.principal_id, source: "test" });
  return { source, project, authIdentity: { principal_id: principal.principal_id, principal_type: "service", scopes } };
}

function createOwnerContext({ source = "test", scopes = null, project = null } = {}) {
  const db = require("../../src/db");
  db.runPendingMigrations();
  const identity = require("../../src/core/identity");
  const principal = identity.listPrincipals({ type: "human" }).find(item => item.roles.includes("owner"))
    || identity.bootstrapOwner({ username: "test-owner", password: "test-owner-password-123" });
  if (project) require("../../src/platform/kernel").registerProject({ project_id: project, owner_actor_id: principal.principal_id, source: "test" });
  return { source, project, authIdentity: { principal_id: principal.principal_id, principal_type: "human", scopes } };
}

function withOwnerToolContext(tools, { source = "test", scopes = null, project = null } = {}) {
  const { runWithContext, getExecutionContext } = require("../../src/tools/context");
  const context = createOwnerContext({ source, scopes, project });
  const wrapped = {};
  for (const key of Reflect.ownKeys(tools)) {
    const value = tools[key];
    Object.defineProperty(wrapped, key, {
      enumerable: Object.prototype.propertyIsEnumerable.call(tools, key),
      configurable: false,
      writable: false,
      value: typeof value === "function"
        ? (...args) => {
          const active = getExecutionContext();
          const merged = {
            ...context,
            ...active,
            authIdentity: active.authIdentity?.principal_id ? active.authIdentity : context.authIdentity,
            source: active.source || context.source,
            project: active.project || context.project || null,
          };
          return runWithContext(merged, () => value(...args));
        }
        : value,
    });
  }
  return Object.freeze(wrapped);
}

module.exports = { createOwnerContext, createServiceContext, withOwnerToolContext };
