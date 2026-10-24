"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const testDataDir = process.env.SIDEKICK_TEST_DATA_DIR || path.join(__dirname, `test-data-comms-boundary-${process.pid}`);
process.env.SIDEKICK_DATA_DIR = testDataDir;
process.env.SIDEKICK_DB_FILE = process.env.SIDEKICK_TEST_DB_FILE || path.join(testDataDir, "sidekick.db");
delete require.cache[require.resolve("../src/db")];
require("../src/db").runPendingMigrations();

const { sidekick_notify, sidekick_webhook, descriptors, notificationEndpointFailure } = require("../src/tools/families/comms");
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

test("webhook error responses are drained but never reflected to the caller", () => {
  const secretUrl = "https://hooks.slack.com/services/T000/B000/synthetic-webhook-token";
  let drained = false;
  const result = notificationEndpointFailure(502, { resume() { drained = true; }, body: secretUrl });
  assert.equal(drained, true, "the response stream must be drained");
  assert.deepEqual(result.content, [{ type: "text", text: "Notification endpoint returned HTTP 502" }]);
  assert.equal(result.isError, true);
  assert.equal(result.code, "notification_endpoint_rejected");
  assert.ok(!JSON.stringify(result).includes(secretUrl));
});
