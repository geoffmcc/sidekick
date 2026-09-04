"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-proving-runner-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "proving-runner-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const bundled = require("../src/packs/bundled");
const lifecycle = require("../src/packs/lifecycle");
const { runRecipe, executableCases } = require("../src/proving/runner");

test("proving recognizes only explicit server-approved executable cases", () => {
  assert.equal(executableCases({ single_pack: [{ capability: "api_contract_check", dispatch: "canonical" }] }).length, 0);
  assert.equal(executableCases({ single_pack: [{ tool: "api_contract_check", args: { url: "https://example.test" } }] }).length, 1);
});

test("proving does not pass a recipe whose capability cases are declarative only", async () => {
  const installed = bundled.installBundledPack("api-engineering");
  lifecycle.enable(installed.pack.name);
  const result = await runRecipe(installed.pack.name, { project: "proving-test", actor: "proving-test" });
  assert.notEqual(result.status, "passed", JSON.stringify(result));
});
