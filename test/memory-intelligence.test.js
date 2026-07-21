#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-memory-intel-test-"));
process.env.SIDEKICK_DATA_DIR = tempDir;
process.env.SIDEKICK_AUTO_MEMORY = "1";
process.env.SIDEKICK_EMBEDDINGS = "0";

const dbStore = require("../src/db");
const { TOOLS } = require("../src/tools");

dbStore.runPendingMigrations();

(async () => {
  console.log("Test memory intelligence handoff/session APIs");

  const handoffContent = [
    "Fact: host sidekick-vm runs service sidekick-mcp on port 4097.",
    "Decision: keep SQLite as the durable memory source because it works without Qdrant.",
    "Completed: added dashboard memory evidence display.",
    "Failed: using raw tool logs as durable memory created noisy recall.",
    "Open problem: SMB direct-path verification remains unresolved.",
    "Next step: run memory-intelligence validation tests.",
    "password=super-secret-value"
  ].join("\n");

  const create = await TOOLS.handoff({
    action: "create",
    key: "sidekick-handoff-test",
    project: "sidekick",
    title: "Memory Intelligence Test Handoff",
    content: handoffContent,
    source: "test"
  });
  assert.ok(!create.isError, "handoff create should succeed");
  const createData = JSON.parse(create.content[0].text);
  assert.ok(createData.handoff.id, "handoff should have an id");
  assert.ok(createData.handoff.content.includes("super-secret-value"), "full handoff artifact should be preserved");
  assert.ok(!createData.memories.some(memory => JSON.stringify(memory).includes("super-secret-value")), "secret-looking value should not be extracted into memory payload");
  assert.ok(createData.memories.some(memory => memory.type === "decision"), "decision memory should be extracted");
  assert.ok(createData.memories.some(memory => memory.type === "negative"), "negative memory should be extracted");
  assert.ok(createData.memories.some(memory => memory.type === "open_thread"), "open thread should be extracted");
  const handoffEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.handoff_processed' AND subject_id = ?").get(createData.handoff.id);
  assert.ok(handoffEvent, "handoff processing should emit a platform memory event");

  const inspect = await TOOLS.handoff({ action: "inspect", id: createData.handoff.id });
  const inspectData = JSON.parse(inspect.content[0].text);
  assert.ok(inspectData.extracted_memories.length >= createData.memories.length, "inspect should link extracted memories");
  assert.ok(inspectData.extracted_memories.every(memory => memory.source_ref === createData.handoff.id), "extracted memories should link to handoff source");

  const beforeCount = dbStore.searchMemories({ project: "sidekick", includeDisabled: true, limit: 100 }).length;
  await TOOLS.handoff({ action: "reprocess", id: createData.handoff.id });
  const afterCount = dbStore.searchMemories({ project: "sidekick", includeDisabled: true, limit: 100 }).length;
  assert.strictEqual(afterCount, beforeCount, "reprocessing same handoff version should be idempotent");

  const begin = await TOOLS.session({
    action: "begin",
    goal: "Investigate SMB direct-path verification for project sidekick",
    project: "sidekick",
    source: "test",
    repository: "geoffmcc/sidekick",
    branch: "feat/memory-intelligence-system"
  });
  const beginData = JSON.parse(begin.content[0].text);
  assert.ok(beginData.session.id, "session begin should create a session");
  assert.ok(beginData.memory_brief.selected.some(item => /SMB|raw tool logs|SQLite|sidekick-mcp/i.test(item.summary)), "brief should recall relevant handoff-derived memory");
  const beginEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.session_started' AND subject_id = ?").get(beginData.session.id);
  assert.ok(beginEvent, "session begin should emit a platform memory event");

  const otherProjectRecall = await TOOLS.memory({ action: "query", query: "sidekick-mcp port", project: "other_project" });
  const otherData = JSON.parse(otherProjectRecall.content[0].text);
  assert.ok(!otherData.memories.some(memory => memory.project === "sidekick"), "unrelated project recall should exclude sidekick-scoped memories");

  const end = await TOOLS.session({
    action: "end",
    id: beginData.session.id,
    outcome: "success",
    final_summary: "Memory intelligence session completed",
    acceptance_state: "accepted",
    verified_facts: ["Project sidekick memory intelligence tests passed in temp DB"],
    decisions: ["Use explicit sidekick_handoff ingestion for mutable handoffs"],
    failed_approaches: ["Do not promote raw tool-log adjacency as durable memory"],
    follow_ups: ["Add model-assisted extraction after deterministic redaction"]
  });
  const endData = JSON.parse(end.content[0].text);
  assert.ok(endData.memories_created >= 4, "ending session should create supported memories");
  const endEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.session_completed' AND subject_id = ?").get(beginData.session.id);
  assert.ok(endEvent, "session end should emit a platform memory event");

  const wrong = await TOOLS.memory({ action: "remember", project: "sidekick", type: "fact", content: "Sidekick dashboard runs on port 9999", evidence: "test wrong fact" });
  const wrongId = JSON.parse(wrong.content[0].text).memory.id;
  const correction = await TOOLS.memory({ action: "correct", id: wrongId, correct_to: "Sidekick dashboard runs on port 4098", reason: "test correction" });
  const correctionData = JSON.parse(correction.content[0].text);
  assert.ok(correctionData.replacement.id, "correction should create replacement memory");
  const rememberEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.remembered' AND subject_id = ?").get(wrongId);
  assert.ok(rememberEvent, "explicit remember should emit a platform memory event");
  const correctEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.corrected' AND subject_id = ?").get(correctionData.replacement.id);
  assert.ok(correctEvent, "memory correction should emit a platform memory event");
  const old = dbStore.getMemoryById(wrongId, { includeDisabled: true });
  assert.strictEqual(old.state, "deleted", "corrected old memory should be excluded from current recall");

  const explain = await TOOLS.memory({ action: "explain", id: correctionData.replacement.id });
  const explainData = JSON.parse(explain.content[0].text);
  assert.ok(explainData.evidence.length >= 1, "explain should return evidence rows");

  const health = await TOOLS.memory({ action: "health" });
  const healthData = JSON.parse(health.content[0].text);
  assert.ok(healthData.stats.stored_handoffs >= 1, "health should count stored handoffs");
  assert.ok(healthData.stats.durable_active >= 1, "health should count durable active memories");

  const getByNoSelector = await TOOLS.handoff({ action: "get" });
  assert.ok(getByNoSelector.isError, "handoff get with no selector should be an error");
  assert.ok(getByNoSelector.content[0].text.includes("requires id or key"), "error message should state id or key is required");

  const getByProjectOnly = await TOOLS.handoff({ action: "get", project: "sidekick" });
  assert.ok(getByProjectOnly.isError, "handoff get with only project should be an error");
  assert.ok(getByProjectOnly.content[0].text.includes("requires id or key"), "error message should state id or key is required");

  const inspectByNoSelector = await TOOLS.handoff({ action: "inspect" });
  assert.ok(inspectByNoSelector.isError, "handoff inspect with no selector should be an error");
  assert.ok(inspectByNoSelector.content[0].text.includes("requires id or key"), "inspect error message should state id or key is required");

  const inspectByProjectOnly = await TOOLS.handoff({ action: "inspect", project: "sidekick" });
  assert.ok(inspectByProjectOnly.isError, "handoff inspect with only project should be an error");
  assert.ok(inspectByProjectOnly.content[0].text.includes("requires id or key"), "inspect error message should state id or key is required");

  const getById = await TOOLS.handoff({ action: "get", id: createData.handoff.id });
  assert.ok(!getById.isError, "handoff get by id should still work");
  const getByIdData = JSON.parse(getById.content[0].text);
  assert.strictEqual(getByIdData.handoff.id, createData.handoff.id, "get by id should return the correct handoff");

  const getByUnknownId = await TOOLS.handoff({ action: "get", id: "nonexistent_id" });
  assert.ok(getByUnknownId.isError, "handoff get by unknown id should be an error");
  assert.ok(getByUnknownId.content[0].text.includes("Handoff not found"), "unknown id should return Handoff not found");

  console.log("✅ Memory intelligence tests passed");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
