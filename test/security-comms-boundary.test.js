"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const testDataDir = process.env.SIDEKICK_TEST_DATA_DIR || path.join(__dirname, `test-data-comms-boundary-${process.pid}`);
process.env.SIDEKICK_DATA_DIR = testDataDir;
process.env.SIDEKICK_DB_FILE = process.env.SIDEKICK_TEST_DB_FILE || path.join(testDataDir, "sidekick.db");
delete require.cache[require.resolve("../src/db")];
require("../src/db").runPendingMigrations();

const { sidekick_notify, sidekick_webhook, descriptors } = require("../src/tools/families/comms");
const { runWithContext } = require("../src/tools/context");

test("outbound notifications require an authenticated canonical high-risk grant", async () => {
  const result = await runWithContext({ source: "agent", authIdentity: null }, () =>
    sidekick_notify({ channel: "webhook", webhook_url: "https://example.invalid/hook", message: "synthetic" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "unauthenticated");
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
