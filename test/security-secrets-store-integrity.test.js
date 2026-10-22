"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-secrets-integrity-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/core/secrets-store")];
const store = require("../src/core/secrets-store");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("secret writes replace atomically and create a private file", () => {
  store.saveSecrets({ synthetic: { encrypted: "ciphertext-only" } });
  assert.deepEqual(store.loadSecrets(), { synthetic: { encrypted: "ciphertext-only" } });
  if (process.platform !== "win32") assert.equal(fs.statSync(store.SECRETS_FILE).mode & 0o777, 0o600);

  const original = fs.readFileSync(store.SECRETS_FILE, "utf-8");
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (...args) {
    if (typeof args[0] === "number") throw new Error("synthetic temp write failure");
    return realWrite.apply(this, args);
  };
  try { assert.throws(() => store.saveSecrets({ replacement: true }), /synthetic temp write failure/); }
  finally { fs.writeFileSync = realWrite; }
  assert.equal(fs.readFileSync(store.SECRETS_FILE, "utf-8"), original, "failed temp writes preserve the existing secret file");

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error("synthetic rename failure"); };
  try { assert.throws(() => store.saveSecrets({ replacement: true }), /synthetic rename failure/); }
  finally { fs.renameSync = realRename; }
  assert.equal(fs.readFileSync(store.SECRETS_FILE, "utf-8"), original, "failed atomic replacement preserves the existing secret file");
});

test("corrupt secret stores fail closed and cannot be overwritten through pack helpers", () => {
  const corrupt = "{ truncated synthetic secret store";
  fs.writeFileSync(store.SECRETS_FILE, corrupt, { mode: 0o600 });
  assert.throws(() => store.loadSecrets(), /encrypted secret store is corrupt or unavailable/);
  assert.throws(() => store.savePackSecret("developer", "api-token", "synthetic"), /encrypted secret store is corrupt or unavailable/);
  assert.equal(fs.readFileSync(store.SECRETS_FILE, "utf-8"), corrupt, "a failed parse must never become an empty-store overwrite");
});

test("secret store reads and writes reject symlinked secret files", { skip: process.platform === "win32" }, () => {
  fs.rmSync(store.SECRETS_FILE, { force: true });
  const target = path.join(dataDir, "outside-secret-target.json");
  const content = JSON.stringify({ preserved: "synthetic" });
  fs.writeFileSync(target, content, { mode: 0o600 });
  fs.symlinkSync(target, store.SECRETS_FILE);
  assert.throws(() => store.loadSecrets(), /regular file/);
  assert.throws(() => store.saveSecrets({ overwritten: true }), /regular file/);
  assert.equal(fs.readFileSync(target, "utf-8"), content);
});
