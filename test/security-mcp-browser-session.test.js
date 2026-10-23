"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const previousDataDir = process.env.SIDEKICK_DATA_DIR;
const previousDbFile = process.env.SIDEKICK_DB_FILE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-mcp-browser-session-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");

test.after(() => {
  db.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.SIDEKICK_DATA_DIR;
  else process.env.SIDEKICK_DATA_DIR = previousDataDir;
  if (previousDbFile === undefined) delete process.env.SIDEKICK_DB_FILE;
  else process.env.SIDEKICK_DB_FILE = previousDbFile;
});

test("MCP bearer auth resolves current browser sessions and scoped credentials without widening", () => {
  const owner = identity.bootstrapOwner({ username: "mcp_session_owner", password: "synthetic owner password", displayName: "MCP Session Owner" });
  const ownerContext = { principal_id: owner.principal_id };
  const liveSession = authentication.createSession(owner.principal_id);
  const sessionIdentity = authentication.authenticateBearerIdentity(liveSession.token);
  assert.deepEqual(sessionIdentity, {
    principal_id: owner.principal_id,
    principal_type: "human",
    scopes: null,
    authentication_method: "browser_session",
  });
  assert.equal(authorization.authorize({ principalId: sessionIdentity.principal_id, permission: "tools.execute", credentialScopes: sessionIdentity.scopes }).ok, true);

  const service = identity.createPrincipal({
    type: "service",
    displayName: "MCP browser-session test service",
    actorIdentity: { ...ownerContext, scopes: ["principals.manage"] },
  });
  identity.grantPrincipalPermission(service.principal_id, "packs.read", { ...ownerContext, scopes: ["roles.manage", "packs.read"] });
  const restricted = authentication.createCredential({
    principalId: service.principal_id,
    displayName: "restricted pack reader",
    scopes: ["packs.read"],
    actorContext: { ...ownerContext, scopes: ["credentials.create", "principals.manage", "roles.manage", "packs.read"] },
  });
  const credentialIdentity = authentication.authenticateBearerIdentity(restricted.token);
  assert.equal(credentialIdentity.authentication_method, "scoped_credential");
  assert.deepEqual(credentialIdentity.scopes, ["packs.read"]);
  assert.equal(authorization.authorize({ principalId: service.principal_id, permission: "packs.read", credentialScopes: credentialIdentity.scopes }).ok, true);
  assert.equal(authorization.authorize({ principalId: service.principal_id, permission: "packs.manage", credentialScopes: credentialIdentity.scopes }).ok, false);

  assert.equal(authentication.invalidateSession(liveSession.token, owner.principal_id), true);
  assert.equal(authentication.authenticateBearerIdentity(liveSession.token), null, "revoked browser session cannot authenticate MCP requests");

  const expiredSession = authentication.createSession(owner.principal_id);
  db.getDb().prepare("UPDATE identity_sessions SET expires_at = ? WHERE session_id_hash = ?")
    .run(new Date(Date.now() - 1000).toISOString(), authentication.getSession(expiredSession.token).session_id);
  assert.equal(authentication.authenticateBearerIdentity(expiredSession.token), null, "expired browser session cannot authenticate MCP requests");

  const viewer = identity.createHumanUser({
    username: "mcp_session_viewer",
    password: "synthetic viewer password",
    actorIdentity: ownerContext,
  });
  const disabledSession = authentication.createSession(viewer.principal_id);
  identity.setPrincipalEnabled(viewer.principal_id, false, ownerContext);
  assert.equal(authentication.authenticateBearerIdentity(disabledSession.token), null, "disabled principal session cannot authenticate MCP requests");
  assert.equal(authentication.authenticateBearerIdentity("not-a-valid-token"), null);
});

test("MCP request, health, and readiness routes share the principal-bearing bearer authenticator", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
  assert.equal((source.match(/authenticateBearerIdentity\(token\)/g) || []).length, 3,
    "health disclosure, readiness disclosure, and protected routes must use the same current identity validation");
});
