"use strict";

const assert = require("assert");
const os = require("os");
const path = require("path");

process.env.SIDEKICK_DATA_DIR = path.join(os.tmpdir(), `sidekick-knowledge-promotion-${process.pid}`);
delete process.env.SIDEKICK_DB_FILE;

const dbStore = require("../src/db");
const { sidekick_knowledge } = require("../src/tools/families/knowledge");
const { sidekick_teach } = require("../src/tools/families/teach");

async function main() {
  dbStore.runPendingMigrations();

  const taught = await sidekick_teach({
    action: "teach_procedure",
    name: "knowledge-promotion-regression",
    description: "A procedure used to verify governed knowledge promotion",
    steps: [{ tool: "get", args: { key: "api_token", token: "super-secret-value" } }],
  });
  assert.match(taught.content[0].text, /Taught procedure/);

  const promoted = await sidekick_knowledge({
    action: "promote",
    source: "procedure",
    source_id: "knowledge-promotion-regression",
    category: "development",
    title: "Governed knowledge promotion regression",
    approver: "test-operator",
  });
  const promotedPayload = JSON.parse(promoted.content[0].text);
  assert.strictEqual(promotedPayload.promoted, true);

  const row = dbStore.getDb().prepare(
    "SELECT source_type, source_id, source_version, approved_by, content FROM knowledge WHERE id = ?"
  ).get(promotedPayload.id);
  assert.strictEqual(row.source_type, "procedure");
  assert.strictEqual(row.source_id, "knowledge-promotion-regression");
  assert.strictEqual(row.approved_by, "test-operator");
  assert.ok(!row.content.includes("super-secret-value"), "promoted content must redact sensitive values");

  const duplicate = await sidekick_knowledge({
    action: "promote",
    source: "procedure",
    source_id: "knowledge-promotion-regression",
    category: "development",
    approver: "test-operator",
  });
  assert.ok(JSON.parse(duplicate.content[0].text).existing_id, "promotion must be idempotent");

  const search = await sidekick_knowledge({
    action: "search",
    query: "governed knowledge promotion",
    category: "development",
  });
  const rows = JSON.parse(search.content[0].text);
  assert.ok(rows.some(item => item.id === promotedPayload.id), "promoted knowledge must be FTS-searchable");

  console.log("Knowledge promotion tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
