"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const testDataDir = process.env.SIDEKICK_TEST_DATA_DIR || path.join(__dirname, `test-data-comms-boundary-${process.pid}`);
process.env.SIDEKICK_DATA_DIR = testDataDir;
process.env.SIDEKICK_DB_FILE = process.env.SIDEKICK_TEST_DB_FILE || path.join(testDataDir, "sidekick.db");
delete require.cache[require.resolve("../src/db")];
require("../src/db").runPendingMigrations();

const { sidekick_notify, sidekick_webhook, descriptors, readBoundedNotificationError } = require("../src/tools/families/comms");
const { runWithContext } = require("../src/tools/context");
const { dispatchTestTool } = require("../src/tools/dispatcher");
const { createOwnerContext } = require("./helpers/authorized-context");

test("outbound notifications require an authenticated canonical high-risk grant", async () => {
  const result = await runWithContext({ source: "agent", authIdentity: null }, () =>
    sidekick_notify({ channel: "webhook", webhook_url: "https://example.invalid/hook", message: "synthetic" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "unauthenticated");
});

test("configured notification credentials require secrets.use in addition to tool execution", async () => {
  const descriptor = descriptors.find(item => item.name === "notify");
  const ownerContext = createOwnerContext();
  const identity = require("../src/core/identity");
  const limited = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Synthetic notify-only principal" });
  identity.grantPrincipalPermission(limited.principal_id, "tools.execute", ownerContext.authIdentity);
  identity.grantPrincipalPermission(limited.principal_id, "tools.execute_high", ownerContext.authIdentity);
  const context = { source: "test", authIdentity: { principal_id: limited.principal_id } };
  const result = await dispatchTestTool({ descriptor, args: { channel: "slack", message: "synthetic" }, context });
  assert.equal(result.isError, true);
  assert.equal(result.code, "forbidden", JSON.stringify(result));
});

test("webhook storage access cannot bypass canonical dispatch", async () => {
  const result = await runWithContext({ source: "agent", authIdentity: null }, () =>
    sidekick_webhook({ action: "list" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("webhook operations are classified as high risk for dispatcher policy", () => {
  assert.equal(descriptors.find(item => item.name === "webhook").risk, "high");
});

test("notification error bodies are retained only up to the configured byte limit", async () => {
  const response = new EventEmitter();
  response.destroy = () => response.emit("close");
  const pending = readBoundedNotificationError(response, 5);
  response.emit("data", Buffer.from("0123456789"));
  assert.equal(await pending, "01234 [truncated: response exceeded 5 bytes]");
});

test("notification error bodies preserve a complete response within the byte limit", async () => {
  const response = new EventEmitter();
  const pending = readBoundedNotificationError(response, 16);
  response.emit("data", Buffer.from("remote error"));
  response.emit("end");
  assert.equal(await pending, "remote error");
});
