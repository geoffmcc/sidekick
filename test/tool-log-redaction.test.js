#!/usr/bin/env node

/**
 * Tool-log and auto-memory credential redaction (issue #147).
 *
 * tool_logs and bounded auto-memory persist tool arguments and result
 * summaries, and recalled memories flow into LLM prompts. Pattern redaction
 * cannot recognize an arbitrary credential value (a generic password, random
 * hex), so the persistence path must (a) redact by key name before composing
 * `key=value`, and (b) never store the secret tool's argument values or
 * result summaries.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-tool-log-redaction-"));
process.env.SIDEKICK_DATA_DIR = tempDir;
process.env.SIDEKICK_AUTO_MEMORY = "1";

const dbStore = require("../src/db");
dbStore.runPendingMigrations();

const { isSensitiveKey, redactSensitiveKeysDeep } = require("../src/redact");
const { logToolCall } = require("../src/tools-legacy");
const { loadContext, recordToolCallMemory, recordAgentTaskMemory } = require("../src/memory");

// Fixture credentials are assembled at runtime so secret scanners
// (GitGuardian, GitHub push protection) do not flag this file: a literal
// `password: "..."` pair is indistinguishable from a real hardcoded secret.
const join = (...parts) => parts.join("");
const FAKE_PASSWORD = join("hunter2", "abc");
const FAKE_NESTED_PASSWORD = join("nested", "pw12");
const FAKE_API_KEY = join("zzzz", "9999xx");
const FAKE_SECRET_RESULT = join("raw-credential-", "value-123");
const FAKE_ROTATED_HEX = join("abcdef", "0123456789");
const FAKE_STORE_VALUE = join("plain-text-", "pw-1");
const FAKE_AGENT_SECRET = join("raw-agent-", "secret-1");
const FAKE_STORE_VALUE_2 = join("store-", "plain-99");
const FAKE_ENV_PASSWORD = join("env", "pw5678");

console.log("Running Tool Log Redaction Tests...\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

function lastLogRow() {
  return dbStore.getDb().prepare("SELECT * FROM tool_logs ORDER BY id DESC LIMIT 1").get();
}

console.log("TLR.1: sensitive key names are recognized in any spelling");
test("credential key names match, ordinary keys do not", () => {
  for (const key of ["password", "PASSWORD", "passwd", "passphrase", "secret",
    "token", "api_key", "apiKey", "API-KEY", "x-api-key", "authorization",
    "cookie", "private_key", "privateKey", "credential", "credentials",
    "github_token", "db_password"]) {
    assert.ok(isSensitiveKey(key), `${key} should be sensitive`);
  }
  for (const key of ["command", "project", "url", "query", "action", "name", "file_path"]) {
    assert.ok(!isSensitiveKey(key), `${key} should not be sensitive`);
  }
});

test("normalization cannot be bypassed with unicode spellings", () => {
  assert.ok(isSensitiveKey("Ｐａｓｓｗｏｒｄ"), "fullwidth spelling folds to ascii");
  assert.ok(isSensitiveKey("pwd"), "pwd matches");
  assert.ok(isSensitiveKey("bearer_token"), "bearer matches");
  assert.ok(isSensitiveKey("aws_access_key"), "access_key matches");
});

test("deep sanitizer redacts nested and array-borne credentials", () => {
  const out = redactSensitiveKeysDeep({
    config: { password: FAKE_PASSWORD, host: "db.local" },
    list: [{ api_key: FAKE_API_KEY }],
    command: "echo hi"
  });
  assert.equal(out.config.password, "[REDACTED]");
  assert.equal(out.config.host, "db.local", "benign nested values survive");
  assert.equal(out.list[0].api_key, "[REDACTED]");
  assert.equal(out.command, "echo hi");
});

console.log("\nTLR.2: args under sensitive key names never reach tool_logs");
test("a generic password value is redacted by key, not by shape", () => {
  logToolCall("bash", { command: "echo hi", password: FAKE_PASSWORD }, 5, true, "ok");
  const row = lastLogRow();
  assert.ok(row.args_summary.includes("password=[REDACTED]"), "key is redacted");
  assert.ok(!row.args_summary.includes(FAKE_PASSWORD), "value absent from args_summary");
  assert.ok(!row.entry_json.includes(FAKE_PASSWORD), "value absent from entry_json");
});

test("credentials nested inside object args are redacted with key context", () => {
  logToolCall("teach", { name: "proc", steps: { config: { password: FAKE_NESTED_PASSWORD } } }, 5, true, "ok");
  const row = lastLogRow();
  assert.ok(!row.entry_json.includes(FAKE_NESTED_PASSWORD), "nested value absent from entry_json");
  assert.ok(row.args_summary.includes("[REDACTED]"), "nested key redacted in args_summary");
});

console.log("\nTLR.3: the secret tool's values never reach tool_logs");
test("secret get result summary is scrubbed", () => {
  logToolCall("secret", { action: "get", key: "svc_token_name" }, 5, true, FAKE_SECRET_RESULT);
  const row = lastLogRow();
  assert.equal(row.summary, "(sensitive value withheld)");
  assert.ok(!row.entry_json.includes(FAKE_SECRET_RESULT), "raw value absent from entry_json");
  assert.ok(!String(row.result_summary).includes(FAKE_SECRET_RESULT), "raw value absent from result_summary");
});

test("legacy-prefixed secret rotate summary is scrubbed identically", () => {
  logToolCall("sidekick_secret", { action: "rotate", key: "k", generate: "16" }, 5, true,
    "Rotated: k\nNew value: " + FAKE_ROTATED_HEX);
  const row = lastLogRow();
  assert.equal(row.summary, "(sensitive value withheld)");
  assert.ok(!row.entry_json.includes(FAKE_ROTATED_HEX), "new value absent from entry_json");
});

test("secret store argument value is scrubbed, benign summary is kept", () => {
  logToolCall("secret", { action: "store", key: "k", value: FAKE_STORE_VALUE }, 5, true, "Stored: k");
  const row = lastLogRow();
  assert.ok(row.args_summary.includes("value=[REDACTED]"), "value arg is redacted");
  assert.ok(!row.entry_json.includes(FAKE_STORE_VALUE), "plaintext absent from entry_json");
  assert.ok(row.summary.includes("Stored"), "non-credential summary preserved");
});

test("secret failure summaries stay useful", () => {
  logToolCall("secret", { action: "get", key: "nope" }, 5, false, "Secret not found: nope");
  const row = lastLogRow();
  assert.ok(row.summary.includes("not found"), "error text preserved for diagnostics");
});

console.log("\nTLR.4: auto-memory never captures the secret tool and redacts by key");
test("secret calls are excluded from auto-memory", () => {
  assert.equal(recordToolCallMemory({
    name: "secret", args: { action: "get", key: "k" }, duration: 5, success: true,
    summary: FAKE_SECRET_RESULT, source: "mcp"
  }), null, "canonical secret is not remembered");
  assert.equal(recordToolCallMemory({
    name: "sidekick_secret", args: { action: "get", key: "k" }, duration: 5, success: true,
    summary: FAKE_SECRET_RESULT, source: "mcp"
  }), null, "legacy-prefixed secret is not remembered");
});

test("remembered args redact sensitive keys before composing key=value", () => {
  const memory = recordToolCallMemory({
    name: "bash", args: { command: "run migration", db_password: FAKE_PASSWORD },
    duration: 5, success: true, summary: "done", source: "mcp"
  });
  assert.ok(memory, "bash call is remembered");
  assert.ok(memory.args.includes("db_password=[REDACTED]"), "sensitive key redacted");
  assert.ok(!memory.args.includes(FAKE_PASSWORD), "value absent from memory args");
});

test("agent-task steps are sanitized before persistence and extraction", () => {
  const result = recordAgentTaskMemory({
    goal: "rotate the service credential",
    taskId: "task-tlr-1",
    status: "completed",
    steps: [
      { type: "tool", tool: "secret", args: { action: "get", key: "svc" }, result: FAKE_AGENT_SECRET },
      { type: "tool", tool: "secret", args: { action: "store", key: "svc2", value: FAKE_STORE_VALUE_2 }, result: "Stored: svc2" },
      { type: "tool", tool: "bash", args: { command: "deploy", env: { DB_PASSWORD: FAKE_ENV_PASSWORD } }, result: "deployed ok" },
      { type: "done", text: "rotated" }
    ]
  });
  assert.ok(result, "agent task memory is stored");
  const serialized = JSON.stringify(loadContext());
  assert.ok(!serialized.includes(FAKE_AGENT_SECRET), "secret result absent from context");
  assert.ok(!serialized.includes(FAKE_STORE_VALUE_2), "secret store value absent from context");
  assert.ok(!serialized.includes(FAKE_ENV_PASSWORD), "nested env credential absent from context");
});

test("no credential value survives anywhere in the stored context", () => {
  const serialized = JSON.stringify(loadContext());
  for (const leaked of [FAKE_PASSWORD, FAKE_SECRET_RESULT, FAKE_STORE_VALUE, FAKE_ROTATED_HEX]) {
    assert.ok(!serialized.includes(leaked), `${leaked} must not appear in stored context`);
  }
});

console.log("\nTool Log Redaction tests: " + passed + " passed, " + failed + " failed\n");
fs.rmSync(tempDir, { recursive: true, force: true });
if (failed > 0) process.exit(1);
