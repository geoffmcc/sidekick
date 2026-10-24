"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { configureSecretDirectory } = require("../../scripts/ensure-secret-config");

const fixtureRoot = process.env.SIDEKICK_TEST_FILESYSTEM_ROOT;
assert.ok(fixtureRoot, "test runner must provide an owned filesystem fixture");

function createSecretDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, "sidekick_api_key"), "synthetic-api-key\n", { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "sidekick_agent_proxy_key"), "synthetic-agent-proxy-key\n", { mode: 0o600 });
}

test("secret configuration safely updates .env and verifies required credentials", t => {
  if (process.platform === "win32") {
    t.skip("deployment secret configuration uses POSIX no-follow file opening");
    return;
  }
  const appDir = path.join(fixtureRoot, "ensure-secret-config-app");
  const secretDir = path.join(fixtureRoot, "ensure-secret-config-secrets");
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(appDir, 0o700);
  createSecretDirectory(secretDir);
  fs.writeFileSync(path.join(appDir, ".env"), "PORT=4097\nSIDEKICK_SECRET_DIR=/old/path\n", { mode: 0o644 });

  assert.equal(configureSecretDirectory(appDir, secretDir), true);
  const envPath = path.join(appDir, ".env");
  const contents = fs.readFileSync(envPath, "utf8");
  assert.match(contents, new RegExp(`^SIDEKICK_SECRET_DIR=${secretDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal(fs.lstatSync(envPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(appDir).filter(name => name.startsWith(".env.sidekick-")), [], "atomic update should clean temporary files");
});

test("secret configuration atomically creates a missing .env", t => {
  if (process.platform === "win32") {
    t.skip("deployment secret configuration uses POSIX no-follow file opening");
    return;
  }
  const appDir = path.join(fixtureRoot, "ensure-secret-config-missing-env-app");
  const secretDir = path.join(fixtureRoot, "ensure-secret-config-missing-env-secrets");
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(appDir, 0o700);
  createSecretDirectory(secretDir);

  assert.equal(configureSecretDirectory(appDir, secretDir), true);
  const envPath = path.join(appDir, ".env");
  assert.match(fs.readFileSync(envPath, "utf8"), new RegExp(`^SIDEKICK_SECRET_DIR=${secretDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal(fs.lstatSync(envPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(appDir).filter(name => name.startsWith(".env.sidekick-")), []);
});

test("secret configuration rejects a .env symlink without changing its target", t => {
  if (process.platform === "win32") {
    t.skip("deployment secret configuration uses POSIX no-follow file opening");
    return;
  }
  const appDir = path.join(fixtureRoot, "ensure-secret-config-symlink-app");
  const secretDir = path.join(fixtureRoot, "ensure-secret-config-symlink-secrets");
  const outside = path.join(fixtureRoot, "ensure-secret-config-symlink-target");
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(appDir, 0o700);
  createSecretDirectory(secretDir);
  fs.writeFileSync(outside, "outside-content\n", { mode: 0o644 });
  fs.symlinkSync(outside, path.join(appDir, ".env"));

  assert.throws(() => configureSecretDirectory(appDir, secretDir));
  assert.equal(fs.readFileSync(outside, "utf8"), "outside-content\n");
  assert.equal(fs.lstatSync(outside).mode & 0o777, 0o644);
});

test("secret configuration rejects a multiply linked .env without changing the shared file", t => {
  if (process.platform === "win32") {
    t.skip("deployment secret configuration uses POSIX no-follow file opening");
    return;
  }
  const appDir = path.join(fixtureRoot, "ensure-secret-config-hardlink-app");
  const secretDir = path.join(fixtureRoot, "ensure-secret-config-hardlink-secrets");
  const outside = path.join(fixtureRoot, "ensure-secret-config-hardlink-target");
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(appDir, 0o700);
  createSecretDirectory(secretDir);
  fs.writeFileSync(outside, "outside-content\n", { mode: 0o600 });
  fs.linkSync(outside, path.join(appDir, ".env"));

  assert.throws(() => configureSecretDirectory(appDir, secretDir), /exactly one link/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside-content\n");
});

test("secret configuration refuses populated credentials before editing .env", t => {
  if (process.platform === "win32") {
    t.skip("deployment secret configuration uses POSIX no-follow file opening");
    return;
  }
  const appDir = path.join(fixtureRoot, "ensure-secret-config-populated-app");
  const secretDir = path.join(fixtureRoot, "ensure-secret-config-populated-secrets");
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(appDir, 0o700);
  createSecretDirectory(secretDir);
  const envPath = path.join(appDir, ".env");
  const original = "SIDEKICK_API_KEY=synthetic-inline-secret\n";
  fs.writeFileSync(envPath, original, { mode: 0o600 });

  assert.throws(() => configureSecretDirectory(appDir, secretDir), /SIDEKICK_API_KEY is populated/);
  assert.equal(fs.readFileSync(envPath, "utf8"), original);
});
