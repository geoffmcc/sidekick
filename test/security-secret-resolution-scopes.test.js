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
const authorization = require("../src/core/authorization");
const { encryptSecret } = require("../src/core/secret-cipher");
const { loadSecrets, saveSecrets } = require("../src/core/secrets-store");
const { runWithContext } = require("../src/tools/context");
const { resolveSecretRef } = require("../src/connectors/resolve");
const providerRegistry = require("../src/compute/provider-registry");
const { resolveProviderApiKey } = require("../src/compute/provider-credentials");

const owner = identity.bootstrapOwner({
  username: `secret_resolution_owner_${process.pid}`,
  password: "synthetic-owner-password-123",
  displayName: "Synthetic secret resolution owner",
});
const operator = identity.createPrincipal({ type: "service", displayName: "Synthetic secret resolution operator" });
identity.assignRole(operator.principal_id, "operator", owner.principal_id);
const delegation = authorization.createDelegation({
  delegatorPrincipalId: owner.principal_id,
  delegatePrincipalId: operator.principal_id,
  permissions: ["workflows.execute"],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  actorPrincipalId: owner.principal_id,
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

test("provider credential resolution preserves delegated permission limits", () => {
  const context = executionContext({ principal_id: operator.principal_id, delegation_id: delegation.delegation_id });
  assert.throws(
    () => runWithContext(context, () => resolveProviderApiKey(provider)),
    error => error.code === "forbidden",
  );
});

test("an authorized principal can still use a configured connector secret", () => {
  const context = executionContext({ principal_id: owner.principal_id });
  assert.equal(resolveSecretRef("secret:synthetic_provider_credential", { context }), secretValue);
  assert.equal(runWithContext(context, () => resolveProviderApiKey(provider)), secretValue);
});
