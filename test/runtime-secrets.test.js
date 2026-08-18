"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readSecret, hasSecret, isFileBacked } = require("../src/core/runtime-secrets");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-secrets-"));
const saved = {
  SIDEKICK_SECRET_DIR: process.env.SIDEKICK_SECRET_DIR,
  SIDEKICK_API_KEY: process.env.SIDEKICK_API_KEY,
  SIDEKICK_API_KEY_FILE: process.env.SIDEKICK_API_KEY_FILE
};

try {
  delete process.env.SIDEKICK_SECRET_DIR;
  delete process.env.SIDEKICK_API_KEY_FILE;
  process.env.SIDEKICK_API_KEY = "environment-value";
  assert.strictEqual(readSecret("SIDEKICK_API_KEY"), "environment-value");

  fs.writeFileSync(path.join(tempDir, "sidekick_api_key"), "file-value\n", { mode: 0o600 });
  process.env.SIDEKICK_SECRET_DIR = tempDir;
  assert.strictEqual(readSecret("SIDEKICK_API_KEY"), "file-value");
  assert.strictEqual(isFileBacked("SIDEKICK_API_KEY"), true);
  assert.strictEqual(hasSecret("SIDEKICK_API_KEY"), true);

  fs.writeFileSync(path.join(tempDir, "sidekick_api_key"), "", { mode: 0o600 });
  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /secret file is invalid/);

  process.env.SIDEKICK_SECRET_DIR = "relative-secrets";
  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /secret path must be absolute/);
  process.env.SIDEKICK_SECRET_DIR = tempDir;

  process.env.SIDEKICK_API_KEY_FILE = path.join(tempDir, "missing");
  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /secret file is unavailable/);
  console.log("runtime secret tests passed");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}
