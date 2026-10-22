"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-wireguard-keygen-"));
process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.NODE_ENV = "test";
process.env.SIDEKICK_SECRET_KEY = "synthetic-wireguard-test-encryption-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const toolContext = require("../src/tools/context");
const dispatcher = require("../src/tools/dispatcher");
const networking = require("../src/tools/families/networking");
const secretsStore = require("../src/core/secrets-store");
const { decryptSecret } = require("../src/core/secret-cipher");

const owner = identity.bootstrapOwner({ username: "wireguard_key_owner", password: "synthetic sufficiently long password" });
const wireguardOnly = identity.createPrincipal({ type: "service", displayName: "WireGuard-only test service", actorPrincipalId: owner.principal_id });
db.getDb().prepare(`INSERT INTO identity_principal_permissions (principal_id, permission, assigned_by_principal_id, assigned_at) VALUES (?, 'tools.execute_high', ?, datetime('now'))`).run(wireguardOnly.principal_id, owner.principal_id);
const privateKey = "SYNTHETIC_PRIVATE_KEY_MUST_NOT_LEAK";
const publicKey = "SYNTHETIC_PUBLIC_KEY";
const invocationLog = path.join(fixture, "wg-invocations.log");

test.after(() => {
  db.closeDatabase();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("WireGuard private-key storage enforces secrets.manage and encrypts its value", async () => {
  const toolContext = require("../src/tools/context");
  const networking = require("../src/tools/families/networking");
  const privateKeyFixture = "SYNTHETIC_PRIVATE_KEY_FOR_STORAGE_TEST";
  const denied = await toolContext.runWithContext(
    toolContext.createTestExecutionContext({ authIdentity: { principal_id: wireguardOnly.principal_id, principal_type: "service" } }),
    () => networking.storeWireGuardPrivateKey(privateKeyFixture),
  );
  assert.deepEqual(denied, { ok: false, code: "forbidden" });
  assert.deepEqual(secretsStore.loadSecrets(), {});

  const stored = await toolContext.runWithContext(
    toolContext.createTestExecutionContext({ authIdentity: { principal_id: owner.principal_id, principal_type: "human" } }),
    () => networking.storeWireGuardPrivateKey(privateKeyFixture),
  );
  assert.equal(stored.ok, true);
  assert.match(stored.key, /^wireguard:[0-9a-f-]+$/);
  const encrypted = secretsStore.loadSecrets()[stored.key];
  assert.ok(encrypted?.data);
  assert.notEqual(encrypted.data, privateKeyFixture);
  assert.equal(decryptSecret(encrypted), privateKeyFixture);
  assert.equal(fs.readFileSync(secretsStore.SECRETS_FILE, "utf8").includes(privateKeyFixture), false);
});

test("WireGuard handler never places private key material in its result", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/tools/families/networking.js"), "utf8");
  assert.match(source, /const permission = wireGuardSecretPermission\(\);[\s\S]*?safeExecFileSync\("wg", \["genkey"\]/);
  assert.match(source, /key_name: stored\.key, public_key: publicKey/);
  assert.doesNotMatch(source, /private_key: privateKey/);
});

test("WireGuard key generation stores private material and returns only a secret reference", { skip: process.platform === "win32" }, async () => {
  const bin = path.join(fixture, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const wg = path.join(bin, "wg");
  fs.writeFileSync(wg, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${invocationLog}'\nif [ "$1" = genkey ]; then printf '%s\\n' '${privateKey}'; else IFS= read -r supplied; [ "$supplied" = '${privateKey}' ] || exit 9; printf '%s\\n' '${publicKey}'; fi\n`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath || ""}`;
  try {
    const result = await dispatcher.dispatchTestTool({
      descriptor: networking.descriptors.find((descriptor) => descriptor.name === "wireguard"),
      args: { action: "generate_keypair" },
      context: { authIdentity: { principal_id: owner.principal_id, principal_type: "human" } },
    });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.public_key, publicKey);
    assert.match(payload.key_name, /^wireguard:[0-9a-f-]+$/);
    assert.equal("private_key" in payload, false);
    assert.equal(result.content[0].text.includes(privateKey), false);

    const stored = secretsStore.loadSecrets()[payload.key_name];
    assert.ok(stored?.data, "private key is persisted as encrypted secret data");
    assert.equal(decryptSecret(stored), privateKey);
    assert.equal(fs.readFileSync(secretsStore.SECRETS_FILE, "utf8").includes(privateKey), false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("WireGuard key generation requires secrets.manage before invoking wg", { skip: process.platform === "win32" }, async () => {
  const before = Object.keys(secretsStore.loadSecrets());
  const invocationsBefore = fs.readFileSync(invocationLog, "utf8");
  const result = await dispatcher.dispatchTestTool({
    descriptor: networking.descriptors.find((descriptor) => descriptor.name === "wireguard"),
    args: { action: "generate_keypair" },
    context: { authIdentity: { principal_id: wireguardOnly.principal_id, principal_type: "service" } },
  });
  assert.equal(result.isError, true);
  assert.equal(result.code, "forbidden");
  assert.match(result.content[0].text, /secrets\.manage/);
  assert.deepEqual(Object.keys(secretsStore.loadSecrets()), before);
  assert.equal(fs.readFileSync(invocationLog, "utf8"), invocationsBefore, "denied generation must not invoke wg");
});
