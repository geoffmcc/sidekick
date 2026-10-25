"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.SIDEKICK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-knowledge-promotion-"));
delete process.env.SIDEKICK_DB_FILE;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "strict";
process.env.SIDEKICK_SECRET_KEY = "synthetic-knowledge-promotion-test-key";

const dbStore = require("../src/db");
const { callMcpTool } = require("../src/tools");
const { executeApprovedTool } = require("../src/tools/dispatcher");
const { createOwnerContext } = require("./helpers/authorized-context");
const owner = createOwnerContext({ project: "knowledge-promotion-test" });
const procedureStore = require("../src/core/procedures-store");

function promote(args) {
  return callMcpTool("knowledge", args, owner);
}

async function main() {
  dbStore.runPendingMigrations();

  procedureStore.saveProcedures({
    ...procedureStore.loadProcedures(),
    "knowledge-promotion-regression": {
      name: "knowledge-promotion-regression",
      title: "Governed knowledge promotion regression",
      description: "Synthetic procedure for governed promotion testing",
      parameters: {},
      steps: [{ tool: "get", args: { key: "api_token", token: "synthetic-secret-canary" } }],
      createdAt: new Date().toISOString(),
    },
  });

  const forged = await promote({
    action: "promote",
    source: "procedure",
    source_id: "knowledge-promotion-regression",
    category: "development",
    approver: "forged-operator",
  });
  assert.strictEqual(forged.isError, true, "caller-supplied approver labels cannot authorize promotion");
  assert.strictEqual(forged.code, "approval_required");
  const approved = await executeApprovedTool({
    approvalId: forged.approvalId,
    reviewer: "test-reviewer",
    reviewerPrincipalId: owner.authIdentity.principal_id,
    reviewerAuthIdentity: owner.authIdentity,
    source: "test",
  });
  assert.notStrictEqual(approved.isError, true, approved.content?.[0]?.text);
  const promoted = dbStore.getDb().prepare(
    "SELECT approved_by, provenance_json FROM knowledge WHERE source_type = 'procedure' AND source_id = ? AND enabled = 1"
  ).get("knowledge-promotion-regression");
  assert.strictEqual(promoted.approved_by, owner.authIdentity.principal_id, "promoted knowledge must record the authenticated approving principal");
  assert.strictEqual(JSON.parse(promoted.provenance_json).approved_by, owner.authIdentity.principal_id);

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
  ).get("knowledge-promotion-regression").count, 1, "a separately approved promotion persists exactly once");

  const search = await promote({
    action: "search",
    query: "governed knowledge promotion",
    category: "development",
  });
  const rows = JSON.parse(search.content[0].text);
  assert.ok(rows.some(item => item.title === "Governed knowledge promotion regression"), "approved knowledge promotion should be searchable");

  console.log("Knowledge promotion tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
