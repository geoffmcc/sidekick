const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "test-data-capability-catalog");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_SECRET_KEY = "capability-catalog-test-secret-key";

require("../src/db").runPendingMigrations();
const { project } = require("../src/capabilities/catalog");
const { callInternalTool } = require("../src/tools/dispatcher");
const { createAgentCatalog } = require("../src/agent/catalog");

(async () => {
  const direct = project({ source: "agent", kind: "tool", limit: 3 });
  assert.strictEqual(direct.ok, true);
  assert.strictEqual(direct.entries.length, 3);
  assert.strictEqual(direct.limit, 3);
  assert.strictEqual(direct.entries.every(entry => entry.kind === "tool"), true);
  assert.ok(direct.entries.every(entry => entry.owner && entry.availability && entry.policy));

  const filtered = project({ source: "agent", kind: "tool", query: "status", limit: 10 });
  assert.ok(filtered.entries.some(entry => entry.name === "status"));
  assert.ok(filtered.entries.every(entry => /status/i.test(`${entry.name} ${entry.description}`)));

  const page = project({ source: "agent", kind: "tool", offset: 2, limit: 2 });
  assert.strictEqual(page.offset, 2);
  assert.strictEqual(page.entries.length, 2);
  assert.strictEqual(page.entries[0].name, direct.entries[2].name);

  const dispatched = await callInternalTool("capability", { action: "catalog", source: "agent", kind: "workflow", limit: 5 });
  assert.strictEqual(dispatched.isError, undefined);
  const dispatchedPayload = JSON.parse(dispatched.content[0].text);
  assert.strictEqual(dispatchedPayload.ok, true);
  assert.ok(Array.isArray(dispatchedPayload.entries));

  const agentCatalog = createAgentCatalog({
    getToolDefsForSource: () => [],
    getBuiltinRegistry: () => ({ get: () => null }),
    crypto,
  }).getLiveAgentCapabilityCatalog({ limit: 2 });
  assert.strictEqual(agentCatalog.source, "agent");
  assert.ok(agentCatalog.entries.every(entry => entry.kind === "tool"));
  console.log("Capability catalog tests passed");
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
