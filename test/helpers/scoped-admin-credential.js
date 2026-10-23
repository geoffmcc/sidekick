"use strict";

function createScopedOwnerCredential(dataDir, displayName = "HTTP integration administrator") {
  process.env.SIDEKICK_DATA_DIR = dataDir;
  const db = require("../../src/db");
  db.runPendingMigrations();
  const identity = require("../../src/core/identity");
  const authentication = require("../../src/core/authentication");
  const owner = identity.bootstrapOwner({ username: `test-owner-${process.pid}`, password: "integration-owner-password-123" });
  const scopes = [
    "compute.nodes.read",
    "compute.nodes.manage",
    "compute.jobs.create",
    "compute.jobs.read",
    "compute.jobs.cancel",
    "compute.jobs.manage",
    "compute.jobs.recover",
    "projects.access.manage",
  ];
  return authentication.createCredential({ principalId: owner.principal_id, displayName, scopes, createdByPrincipalId: owner.principal_id, actorContext: owner }).token;
}

module.exports = { createScopedOwnerCredential };
