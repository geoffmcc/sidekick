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
  SIDEKICK_API_KEY_FILE: process.env.SIDEKICK_API_KEY_FILE,
  SIDEKICK_MCP_CREDENTIAL: process.env.SIDEKICK_MCP_CREDENTIAL,
  SIDEKICK_MCP_CREDENTIAL_FILE: process.env.SIDEKICK_MCP_CREDENTIAL_FILE,
  SIDEKICK_AGENT_PROXY_KEY: process.env.SIDEKICK_AGENT_PROXY_KEY,
  SIDEKICK_AGENT_PROXY_KEY_FILE: process.env.SIDEKICK_AGENT_PROXY_KEY_FILE,
  SIDEKICK_AGENT_SCHEDULER_KEY: process.env.SIDEKICK_AGENT_SCHEDULER_KEY,
  SIDEKICK_AGENT_SCHEDULER_KEY_FILE: process.env.SIDEKICK_AGENT_SCHEDULER_KEY_FILE,
  NODE_ENV: process.env.NODE_ENV
};

try {
  process.env.NODE_ENV = "test";
  delete process.env.SIDEKICK_SECRET_DIR;
  delete process.env.SIDEKICK_API_KEY_FILE;
  delete process.env.SIDEKICK_MCP_CREDENTIAL_FILE;
  delete process.env.SIDEKICK_AGENT_PROXY_KEY_FILE;
  delete process.env.SIDEKICK_AGENT_SCHEDULER_KEY_FILE;
  process.env.SIDEKICK_API_KEY = "environment-value";
  assert.strictEqual(readSecret("SIDEKICK_API_KEY"), "environment-value");
  process.env.SIDEKICK_MCP_CREDENTIAL = "synthetic-stdio-credential";
  assert.strictEqual(readSecret("SIDEKICK_MCP_CREDENTIAL"), "synthetic-stdio-credential");
  process.env.SIDEKICK_AGENT_PROXY_KEY = "distinct-proxy-environment-value";
  assert.strictEqual(readSecret("SIDEKICK_AGENT_PROXY_KEY"), "distinct-proxy-environment-value");
  process.env.SIDEKICK_AGENT_SCHEDULER_KEY = "distinct-scheduler-environment-value";
  assert.strictEqual(readSecret("SIDEKICK_AGENT_SCHEDULER_KEY"), "distinct-scheduler-environment-value");

  fs.writeFileSync(path.join(tempDir, "sidekick_api_key"), "file-value\n", { mode: 0o600 });
  fs.writeFileSync(path.join(tempDir, "sidekick_mcp_credential"), "synthetic-file-credential\n", { mode: 0o600 });
  fs.writeFileSync(path.join(tempDir, "sidekick_agent_proxy_key"), "distinct-file-value\n", { mode: 0o600 });
  fs.writeFileSync(path.join(tempDir, "sidekick_agent_scheduler_key"), "distinct-scheduler-file-value\n", { mode: 0o600 });
  process.env.SIDEKICK_SECRET_DIR = tempDir;
  assert.strictEqual(readSecret("SIDEKICK_API_KEY"), "file-value");
  assert.strictEqual(readSecret("SIDEKICK_MCP_CREDENTIAL"), "synthetic-file-credential");
  assert.strictEqual(readSecret("SIDEKICK_AGENT_PROXY_KEY"), "distinct-file-value");
  assert.strictEqual(readSecret("SIDEKICK_AGENT_SCHEDULER_KEY"), "distinct-scheduler-file-value");
  assert.strictEqual(isFileBacked("SIDEKICK_API_KEY"), true);
  assert.strictEqual(isFileBacked("SIDEKICK_MCP_CREDENTIAL"), true);
  assert.strictEqual(isFileBacked("SIDEKICK_AGENT_SCHEDULER_KEY"), true);
  assert.strictEqual(hasSecret("SIDEKICK_API_KEY"), true);

  fs.writeFileSync(path.join(tempDir, "sidekick_api_key"), "", { mode: 0o600 });
  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /secret file is invalid/);

  process.env.SIDEKICK_SECRET_DIR = "relative-secrets";
  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /secret path must be absolute/);
  process.env.SIDEKICK_SECRET_DIR = tempDir;

  process.env.SIDEKICK_API_KEY_FILE = path.join(tempDir, "missing");
  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /secret file is unavailable/);

  delete process.env.SIDEKICK_API_KEY_FILE;
  delete process.env.SIDEKICK_SECRET_DIR;
  process.env.NODE_ENV = "production";
  assert.throws(() => readSecret("SIDEKICK_API_KEY"), /must be supplied through a secret file/);
  assert.throws(() => readSecret("SIDEKICK_MCP_CREDENTIAL"), /must be supplied through a secret file/);
  assert.throws(() => readSecret("SIDEKICK_AGENT_PROXY_KEY"), /must be supplied through a secret file/);
  assert.throws(() => readSecret("SIDEKICK_AGENT_SCHEDULER_KEY"), /must be supplied through a secret file/);

  process.env.SIDEKICK_SECRET_DIR = tempDir;
  assert.strictEqual(readSecret("GROQ_API_KEY"), "");
  assert.throws(() => readSecret("GROQ_API_KEY", { required: true }), /secret file is unavailable/);
  console.log("runtime secret tests passed");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}
