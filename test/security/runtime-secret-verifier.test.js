"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { readSecret } = require("../../src/core/runtime-secrets");
const { verifyRequiredRuntimeSecrets } = require("../../scripts/verify-runtime-secrets");

const fixtureRoot = process.env.SIDEKICK_TEST_FILESYSTEM_ROOT;
assert.ok(fixtureRoot, "test runner must provide an owned filesystem fixture");

test("runtime and deployment secret readers reject multiply linked secret files", t => {
  if (process.platform === "win32") {
    t.skip("hard-link permission behavior is validated on POSIX deployment hosts");
    return;
  }
  const directory = path.join(fixtureRoot, "runtime-secret-hardlink-verification");
  const externalPath = path.join(fixtureRoot, "runtime-secret-hardlink-target");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(externalPath, "synthetic-api-key\n", { mode: 0o600 });
  fs.linkSync(externalPath, path.join(directory, "sidekick_api_key"));
  fs.writeFileSync(path.join(directory, "sidekick_agent_proxy_key"), "synthetic-proxy-key\n", { mode: 0o600 });

  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    SIDEKICK_SECRET_DIR: process.env.SIDEKICK_SECRET_DIR,
  };
  process.env.NODE_ENV = "production";
  process.env.SIDEKICK_SECRET_DIR = directory;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /exactly one link/);
  assert.throws(() => verifyRequiredRuntimeSecrets(directory), /exactly one link/);
  assert.equal(fs.readFileSync(externalPath, "utf8"), "synthetic-api-key\n");
});

test("deployment secret verifier rejects secret-file symlinks", t => {
  if (process.platform === "win32") {
    t.skip("symlink permission behavior is validated on POSIX deployment hosts");
    return;
  }
  const directory = path.join(fixtureRoot, "runtime-secret-symlink-verification");
  const externalPath = path.join(fixtureRoot, "runtime-secret-symlink-target");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(externalPath, "synthetic-api-key\n", { mode: 0o600 });
  fs.symlinkSync(externalPath, path.join(directory, "sidekick_api_key"));
  fs.writeFileSync(path.join(directory, "sidekick_agent_proxy_key"), "synthetic-proxy-key\n", { mode: 0o600 });

  assert.throws(() => verifyRequiredRuntimeSecrets(directory), /must not be a symlink/);
  assert.equal(fs.readFileSync(externalPath, "utf8"), "synthetic-api-key\n");
});
