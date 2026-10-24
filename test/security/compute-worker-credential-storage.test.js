"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const workerCredential = require("../../src/compute/worker-credential");

test("Compute worker credential save refuses a symlinked parent without changing its target", t => {
  const root = process.env.SIDEKICK_TEST_FILESYSTEM_ROOT;
  assert.ok(root, "test runner must provide an owned filesystem fixture");
  const target = path.join(root, "shared-target");
  fs.mkdirSync(target, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  const targetMode = fs.statSync(target).mode & 0o777;
  const link = path.join(root, "credential-dir");
  try { fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip(`symlink creation unavailable: ${error.code}`);
    throw error;
  }

  assert.throws(() => workerCredential.save({
    workerId: "wk_security_test",
    credential: "wksec_synthetic_test_value",
  }, path.join(link, "worker-credential.json")), /unsafe directory/);
  assert.equal(fs.statSync(target).mode & 0o777, targetMode, "the symlink target permissions are untouched");
  assert.deepEqual(fs.readdirSync(target), [], "no credential is written through the symlink");
});
