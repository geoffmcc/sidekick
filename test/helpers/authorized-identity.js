"use strict";

const crypto = require("crypto");

function authorizedActor(identity, permission) {
  const authorization = require("../../src/core/authorization");
  const candidates = identity.listPrincipals({ enabled: true, limit: 500 });
  for (const principal of candidates) {
    if (authorization.authorize({ principalId: principal.principal_id, permission }).ok) return principal;
  }
  const db = require("../../src/db");
  const bootstrap = db.getDb().prepare("SELECT 1 FROM identity_bootstrap WHERE singleton_id = 1").get();
  if (!bootstrap) {
    return identity.bootstrapOwner({
      username: `test-owner-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
      password: crypto.randomBytes(24).toString("base64url"),
    });
  }
  throw new Error(`Test fixture has no enabled principal authorized for ${permission}`);
}

function actorContext(identity, options, permission, suppliedActor) {
  if (suppliedActor && typeof suppliedActor === "object") return suppliedActor;
  if (options.actorIdentity && typeof options.actorIdentity === "object") return options.actorIdentity;
  if (options.actorPrincipalId) {
    const principal = identity.getPrincipal(options.actorPrincipalId);
    if (principal) return principal;
  }
  return authorizedActor(identity, permission);
}

function createPrincipal(identity, options, suppliedActor = null) {
  const { actorIdentity: _actorIdentity, actorPrincipalId: _actorPrincipalId, ...fields } = options;
  return identity.createPrincipal({ ...fields, actorIdentity: actorContext(identity, options, "principals.manage", suppliedActor) });
}

function createHumanUser(identity, options, suppliedActor = null) {
  const { actorIdentity: _actorIdentity, actorPrincipalId: _actorPrincipalId, ...fields } = options;
  return identity.createHumanUser({ ...fields, actorIdentity: actorContext(identity, options, "users.manage", suppliedActor) });
}

module.exports = Object.freeze({ createPrincipal, createHumanUser });
