"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-secret-resolution-scope-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_SECRET_KEY = "synthetic-secret-resolution-test-key";
process.env.NODE_ENV = "test";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");
const { encryptSecret } = require("../src/core/secret-cipher");
const { loadSecrets, saveSecrets } = require("../src/core/secrets-store");
const { runWithContext } = require("../src/tools/context");
const { resolveSecretRef } = require("../src/connectors/resolve");
const providerRegistry = require("../src/compute/provider-registry");
const { resolveProviderApiKey } = require("../src/compute/provider-credentials");
const inferenceService = require("../src/compute/inference-service");

const owner = identity.bootstrapOwner({
  username: `secret_resolution_owner_${process.pid}`,
  password: "synthetic-owner-password-123",
  displayName: "Synthetic secret resolution owner",
});
const operator = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Synthetic secret resolution operator" });
identity.assignRole(operator.principal_id, "operator", owner);
const delegation = authorization.createDelegation({
  delegatorPrincipalId: owner.principal_id,
  delegatePrincipalId: operator.principal_id,
  permissions: ["workflows.execute"],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  actorContext: owner,
});

const secretValue = "synthetic-provider-credential-never-real";
const secrets = loadSecrets();
secrets.synthetic_provider_credential = { ...encryptSecret(secretValue), created: "test", updated: "test" };
saveSecrets(secrets);
const provider = providerRegistry.createProvider({
  providerType: "openai-compatible",
  displayName: "Synthetic test provider",
  endpoint: "https://provider.invalid/v1",
  authSecretKey: "synthetic_provider_credential",
});

function executionContext(authIdentity) {
  return { source: "test", authIdentity };
}

after(() => {
  try { db.getDb().close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.SIDEKICK_DATA_DIR;
  delete process.env.SIDEKICK_SECRET_KEY;
  delete process.env.NODE_ENV;
});

test("connector secret resolution applies explicit credential scopes", () => {
  const context = executionContext({ principal_id: operator.principal_id, scopes: ["workflows.execute"] });
  assert.throws(
    () => resolveSecretRef("secret:synthetic_provider_credential", { context }),
    error => error.code === "forbidden",
  );
});

test("connector secret resolution denies missing authenticated principal", () => {
  assert.throws(
    () => resolveSecretRef("secret:synthetic_provider_credential", { context: { source: "internal" } }),
    error => error.code === "unauthenticated",
  );
});

test("connector secret resolution preserves delegated permission limits", () => {
  const context = executionContext({ principal_id: operator.principal_id, delegation_id: delegation.delegation_id });
  assert.throws(
    () => resolveSecretRef("secret:synthetic_provider_credential", { context }),
    error => error.code === "forbidden",
  );
});

test("provider credential resolution applies explicit credential scopes", () => {
  const context = executionContext({ principal_id: operator.principal_id, scopes: ["workflows.execute"] });
  assert.throws(
    () => runWithContext(context, () => resolveProviderApiKey(provider)),
    error => error.code === "forbidden",
  );
});

test("provider credential resolution denies missing authenticated principal", () => {
  assert.throws(
    () => resolveProviderApiKey(provider),
    error => error.code === "unauthenticated",
  );
});

test("provider credential resolution preserves delegated permission limits", () => {
  const context = executionContext({ principal_id: operator.principal_id, delegation_id: delegation.delegation_id });
  assert.throws(
    () => runWithContext(context, () => resolveProviderApiKey(provider)),
    error => error.code === "forbidden",
  );
});

test("provider secret use revalidates a long-lived credential after scope reduction", () => {
  const principal = identity.createPrincipal({
    type: "service",
    displayName: "Synthetic provider secret client",
    createdByPrincipalId: owner.principal_id,
    actorIdentity: owner,
  });
  identity.grantPrincipalPermission(principal.principal_id, "secrets.use", owner);
  const credential = authentication.createCredential({
    principalId: principal.principal_id,
    displayName: "Synthetic provider secret credential",
    scopes: ["secrets.use"],
    createdByPrincipalId: owner.principal_id,
    actorContext: owner,
  });
  const capturedIdentity = authentication.authenticateBearerIdentity(credential.token);

  db.getDb().prepare("UPDATE identity_credentials SET scopes_json = ? WHERE credential_id = ?")
    .run(JSON.stringify([]), credential.credential.credential_id);
  assert.throws(
    () => runWithContext(executionContext(capturedIdentity), () => resolveProviderApiKey(provider)),
    error => error.code === "forbidden",
  );
});

test("provider adapters do not cache decrypted credentials across authorization contexts", () => {
  const service = inferenceService;
  const ownerContext = executionContext({ principal_id: owner.principal_id });
  const authorizedAdapter = runWithContext(ownerContext, () => service._getAdapter(provider));
  assert.ok(authorizedAdapter, "authorized call can construct the provider adapter");
  assert.equal(service._adapterCache.has(`${provider.providerId}:${provider.endpoint}`), false, "secret-bearing adapter is not retained in the shared cache");

  const restrictedContext = executionContext({ principal_id: operator.principal_id, scopes: ["workflows.execute"] });
  assert.throws(
    () => runWithContext(restrictedContext, () => service._getAdapter(provider)),
    error => error.code === "forbidden",
  );
});

test("an authorized principal can still use a configured connector secret", () => {
  const context = executionContext({ principal_id: owner.principal_id });
  assert.equal(resolveSecretRef("secret:synthetic_provider_credential", { context }), secretValue);
  assert.equal(runWithContext(context, () => resolveProviderApiKey(provider)), secretValue);
});
