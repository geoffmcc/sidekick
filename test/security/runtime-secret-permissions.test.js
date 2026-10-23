"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { readSecret } = require("../../src/core/runtime-secrets");
const { verifyRequiredRuntimeSecrets } = require("../../scripts/verify-runtime-secrets");

const fixtureRoot = process.env.SIDEKICK_TEST_FILESYSTEM_ROOT;
assert.ok(fixtureRoot, "test runner must provide an owned filesystem fixture");

test("runtime secret reader and deploy preflight reject world-readable credentials", t => {
  if (process.platform === "win32") {
    t.skip("POSIX mode-bit checks do not validate Windows ACLs");
    return;
  }

  const secretDirectory = path.join(fixtureRoot, "runtime-secret-permissions");
  fs.mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  const apiKeyPath = path.join(secretDirectory, "sidekick_api_key");
  const agentProxyKeyPath = path.join(secretDirectory, "sidekick_agent_proxy_key");
  fs.writeFileSync(apiKeyPath, "synthetic-api-key\n", { mode: 0o600 });
  fs.writeFileSync(agentProxyKeyPath, "synthetic-agent-proxy-key\n", { mode: 0o600 });
  fs.chmodSync(secretDirectory, 0o700);
  fs.chmodSync(apiKeyPath, 0o600);
  fs.chmodSync(agentProxyKeyPath, 0o600);

  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    SIDEKICK_SECRET_DIR: process.env.SIDEKICK_SECRET_DIR,
    SIDEKICK_API_KEY_FILE: process.env.SIDEKICK_API_KEY_FILE,
  };
  process.env.NODE_ENV = "production";
  process.env.SIDEKICK_SECRET_DIR = secretDirectory;
  delete process.env.SIDEKICK_API_KEY_FILE;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  assert.equal(readSecret("SIDEKICK_API_KEY"), "synthetic-api-key");
  assert.equal(verifyRequiredRuntimeSecrets(secretDirectory), true);

  // A dedicated service group may read a secret, but unrelated users may not.
  fs.chmodSync(apiKeyPath, 0o640);
  assert.equal(readSecret("SIDEKICK_API_KEY"), "synthetic-api-key");
  assert.equal(verifyRequiredRuntimeSecrets(secretDirectory), true);

  fs.chmodSync(apiKeyPath, 0o644);
  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /secret file is readable by other users/);
  assert.throws(() => verifyRequiredRuntimeSecrets(secretDirectory), /SIDEKICK_API_KEY secret file is readable by other users/);
});
