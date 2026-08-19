"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "test-data-phase-03-auth", String(process.pid));
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_SECRET_KEY = "phase-03-auth-test-key";

delete require.cache[require.resolve("../src/db")];
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");

try {
  const owner = identity.bootstrapOwner({
    username: "phase3-owner",
    password: "correct horse battery staple",
    displayName: "Phase 3 Owner"
  });
  const operator = identity.createHumanUser({
    username: "phase3-operator",
    password: "another correct password",
    displayName: "Phase 3 Operator"
  });
  identity.assignRole(operator.principal_id, "operator", owner.principal_id);

  const scoped = authentication.createCredential({
    principalId: operator.principal_id,
    displayName: "Phase 3 scoped credential",
    scopes: ["workflows.execute"]
  });
  assert.strictEqual(
    authorization.authorize({
      principalId: operator.principal_id,
      permission: "users.manage",
      credentialScopes: scoped.credential.scopes
    }).code,
    "forbidden",
    "scoped credentials must not gain role permissions outside their scope"
  );
  assert.strictEqual(authentication.authenticateCredential(scoped.token).principal_id, operator.principal_id);

  identity.setPrincipalEnabled(operator.principal_id, false, owner.principal_id);
  assert.strictEqual(authentication.authenticateCredential(scoped.token), null);
  assert.strictEqual(
    authorization.authorize({ principalId: operator.principal_id, permission: "workflows.execute" }).code,
    "principal-disabled"
  );

  const source = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.js"), "utf8");
  assert.ok(source.includes('code: "bootstrap-required"'), "dashboard must fail closed before owner bootstrap");
  assert.ok(source.includes('requireIdentityPermission(req, res, "principals.manage")'), "principal mutations need authorization");
  assert.ok(source.includes('requireIdentityPermission(req, res, "roles.manage")'), "role mutations need authorization");
  assert.ok(source.includes("authRateLimiter"), "dashboard authentication must use brute-force throttling");
  assert.ok(source.includes('code: "auth_rate_limited"'), "throttled authentication must fail with an explicit safe code");

  const artifact = fs.readFileSync(path.join(__dirname, "..", "docs", "security-phase-03-auth-authorization.md"), "utf8");
  for (const marker of ["Authentication mechanisms are intentionally separate from authorization", "Route matrix", "F3-01", "Residual risk"]) {
    assert.ok(artifact.includes(marker), `Phase 3 artifact is missing ${marker}`);
  }

  console.log("Phase 3 authentication/authorization checks passed.");
} finally {
  try { db.close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
}
