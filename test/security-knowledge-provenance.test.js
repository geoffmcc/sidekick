"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-knowledge-provenance-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete process.env.SIDEKICK_DB_FILE;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const dbStore = require("../src/db");
const { callMcpTool } = require("../src/tools");
const { createOwnerContext } = require("./helpers/authorized-context");

test("knowledge mutations retain authenticated actor and bounded approval provenance", async () => {
  dbStore.runPendingMigrations();
  const context = createOwnerContext({ source: "test", project: "knowledge-provenance-test" });
  const added = await callMcpTool("knowledge", {
    action: "add",
    category: "security-test",
    title: "Provenance canary",
    content: "Synthetic test content",
    approver: "forged-approver",
    approval_id: "forged-approval",
    provenance_json: "{\"actor_principal_id\":\"forged\"}",
  }, context);
  assert.equal(added.isError, undefined);
  const id = Number(added.content[0].text.match(/id: (\d+)/)?.[1]);
  assert.ok(id > 0);

  const row = () => dbStore.getDb().prepare("SELECT enabled, provenance_json FROM knowledge WHERE id = ?").get(id);
  const first = row();
  const firstHistory = JSON.parse(first.provenance_json).mutation_history;
  assert.equal(firstHistory.length, 1);
  assert.deepEqual(firstHistory[0], {
    action: "add",
    actor_principal_id: context.authIdentity.principal_id,
    approval_id: null,
    approved_by_principal_id: null,
    at: firstHistory[0].at,
    source: "mcp",
    context_project: "knowledge-provenance-test",
  });
  assert.notEqual(firstHistory[0].actor_principal_id, "forged");

  const updated = await callMcpTool("knowledge", {
    action: "update", id, content: "Updated synthetic test content", approved_by: "forged-approver",
  }, context);
  assert.equal(updated.isError, undefined);
  const secondHistory = JSON.parse(row().provenance_json).mutation_history;
  assert.equal(secondHistory.length, 2);
  assert.equal(secondHistory[1].action, "update");
  assert.equal(secondHistory[1].actor_principal_id, context.authIdentity.principal_id);
  assert.equal(secondHistory[1].approval_id, null);

  const deleted = await callMcpTool("knowledge", { action: "delete", id }, context);
  assert.equal(deleted.isError, undefined);
  const final = row();
  assert.equal(final.enabled, 0);
  const finalHistory = JSON.parse(final.provenance_json).mutation_history;
  assert.equal(finalHistory.length, 3);
  assert.equal(finalHistory[2].action, "delete");
  assert.equal(finalHistory[2].actor_principal_id, context.authIdentity.principal_id);

  const boundedAdd = await callMcpTool("knowledge", {
    action: "add", category: "security-test", title: "Bounded provenance", content: "Before update",
  }, context);
  const boundedId = Number(boundedAdd.content[0].text.match(/id: (\d+)/)?.[1]);
  const legacyEvents = Array.from({ length: 25 }, (_, index) => ({ legacy_event: index }));
  dbStore.getDb().prepare("UPDATE knowledge SET provenance_json = ? WHERE id = ?")
    .run(JSON.stringify({ mutation_history: legacyEvents }), boundedId);
  const boundedUpdate = await callMcpTool("knowledge", {
    action: "update", id: boundedId, content: "After update",
  }, context);
  assert.equal(boundedUpdate.isError, undefined);
  const boundedRow = dbStore.getDb().prepare("SELECT content, provenance_json FROM knowledge WHERE id = ?").get(boundedId);
  const boundedHistory = JSON.parse(boundedRow.provenance_json).mutation_history;
  assert.equal(boundedHistory.length, 20);
  assert.equal(boundedHistory[0].legacy_event, 6);
  assert.equal(boundedHistory[19].action, "update");

  dbStore.getDb().prepare("UPDATE knowledge SET provenance_json = ? WHERE id = ?")
    .run("x".repeat(16 * 1024 + 1), boundedId);
  const corrupt = await callMcpTool("knowledge", {
    action: "update", id: boundedId, content: "Must not overwrite malformed provenance",
  }, context);
  assert.equal(corrupt.isError, true);
  assert.match(corrupt.content[0].text, /provenance exceeds its storage limit/);
  assert.equal(dbStore.getDb().prepare("SELECT content FROM knowledge WHERE id = ?").get(boundedId).content, "After update");
});

test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
