"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { SECRET_FILES, provisionRuntimeSecrets } = require("../../scripts/provision-runtime-secrets");

const fixtureRoot = process.env.SIDEKICK_TEST_FILESYSTEM_ROOT;
assert.ok(fixtureRoot, "test runner must provide an owned filesystem fixture");

test("bootstrap provisions protected secrets without replacing existing values", t => {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    t.skip("bootstrap secret ownership and mode enforcement is POSIX-specific");
    return;
  }
  const directory = path.join(fixtureRoot, "bootstrap-runtime-secrets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const existing = path.join(directory, SECRET_FILES[0]);
  const existingValue = "preserve-existing-runtime-secret-value-0123456789\n";
  fs.writeFileSync(existing, existingValue, { mode: 0o640 });

  assert.equal(provisionRuntimeSecrets(directory, process.getuid()), true);
  assert.equal(fs.readFileSync(existing, "utf8"), existingValue);
  for (const name of SECRET_FILES) {
    const stat = fs.lstatSync(path.join(directory, name));
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o777, 0o600);
    assert.ok(stat.size >= 32 && stat.size <= 16384);
  }
});

test("bootstrap refuses secret-file symlinks without modifying their targets", t => {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    t.skip("bootstrap secret ownership and mode enforcement is POSIX-specific");
    return;
  }
  const directory = path.join(fixtureRoot, "bootstrap-runtime-secret-symlink");
  const outside = path.join(fixtureRoot, "bootstrap-runtime-secret-target");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(outside, "outside-value\n", { mode: 0o644 });
  const link = path.join(directory, SECRET_FILES[0]);
  fs.symlinkSync(outside, link);

  assert.throws(() => provisionRuntimeSecrets(directory, process.getuid()));
  assert.equal(fs.readFileSync(outside, "utf8"), "outside-value\n");
  assert.equal(fs.lstatSync(outside).mode & 0o777, 0o644);
});
