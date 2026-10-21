"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const testDataDir = process.env.SIDEKICK_TEST_DATA_DIR || path.join(__dirname, `test-data-evolve-boundary-${process.pid}`);
process.env.SIDEKICK_DATA_DIR = testDataDir;
process.env.SIDEKICK_DB_FILE = process.env.SIDEKICK_TEST_DB_FILE || path.join(testDataDir, "sidekick.db");
delete require.cache[require.resolve("../src/db")];
require("../src/db").runPendingMigrations();

const { sidekick_evolve } = require("../src/tools/families/evolve");
const { runWithContext } = require("../src/tools/context");

test("direct evolve operations cannot inspect or change capability state without identity", async () => {
  const result = await runWithContext({ source: "agent", authIdentity: null }, () =>
    sidekick_evolve({ action: "list" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "unauthenticated");
});
