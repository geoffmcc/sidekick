"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.SIDEKICK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-knowledge-promotion-"));
delete process.env.SIDEKICK_DB_FILE;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "required";

const dbStore = require("../src/db");
const { callMcpTool } = require("../src/tools");
const { createOwnerContext } = require("./helpers/authorized-context");
const owner = createOwnerContext({ project: "knowledge-promotion-test" });

function promote(args) {
  return callMcpTool("knowledge", args, owner);
}

async function main() {
  dbStore.runPendingMigrations();

  const taught = await callMcpTool("teach", {
    action: "teach_procedure",
    name: "knowledge-promotion-regression",
    description: "A procedure used to verify governed knowledge promotion",
    steps: [{ tool: "get", args: { key: "api_token", token: "super-secret-value" } }],
  }, owner);
  assert.match(taught.content[0].text, /Taught procedure/);

  const forged = await promote({
    action: "promote",
    source: "procedure",
    source_id: "knowledge-promotion-regression",
    category: "development",
    approver: "forged-operator",
  });
  assert.strictEqual(forged.isError, true, "caller-supplied approver labels cannot authorize promotion");

  const unapproved = await promote({
    action: "promote",
    source: "procedure",
    source_id: "knowledge-promotion-regression",
    category: "development",
    approver: owner.authIdentity.principal_id,
  });
  assert.strictEqual(unapproved.isError, true, "promotion requires a separate dispatcher approval");
  assert.strictEqual(unapproved.code, "approval_required");
  assert.strictEqual(dbStore.getDb().prepare(
    "SELECT COUNT(*) AS count FROM knowledge WHERE source_type = 'procedure' AND source_id = ? AND enabled = 1"
  ).get("knowledge-promotion-regression").count, 0, "denied promotion must not persist content");

  const search = await promote({
    action: "search",
    query: "governed knowledge promotion",
    category: "development",
  });
  const rows = JSON.parse(search.content[0].text);
  assert.ok(!rows.some(item => item.title === "Governed knowledge promotion regression"), "denied promotion must remain absent from knowledge search");

  console.log("Knowledge promotion tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
