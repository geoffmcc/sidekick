"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-memory-authority-"));
process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const projectAccess = require("../src/core/project-access");
const platformKernel = require("../src/platform/kernel");
const dispatcher = require("../src/tools/dispatcher");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");
const { requiresMemoryConfirmation } = require("../src/core/memory-trust");

const owner = identity.bootstrapOwner({ username: "memory_authority_owner", password: "synthetic sufficiently long password" });
const operator = require('./helpers/authorized-identity').createHumanUser(identity, { username: "memory_authority_operator", password: "synthetic sufficiently long password" });
identity.assignRole(operator.principal_id, "operator", owner);
platformKernel.registerProject({ project_id: "memory_authority_project", owner_actor_id: owner.principal_id });
projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_authority_project", accessLevel: "write" });
const registry = getCanonicalRegistry();
const memory = registry.get("memory");
const memoryManage = registry.get("memory_manage");

test.after(() => {
  db.closeDatabase();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("caller-supplied memory source cannot promote authority", async () => {
  const result = await dispatcher.dispatchTestTool({
    descriptor: memory,
    args: { action: "remember", project: "memory_authority_project", content: "synthetic unverified claim", source: "user_correction" },
    context: { authIdentity: { principal_id: operator.principal_id, principal_type: "human" }, project: "memory_authority_project" },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = JSON.parse(result.content[0].text);
  const stored = db.getMemoryById(payload.memory.id, { includeDisabled: true });
  assert.equal(stored.source, "explicit");
  assert.equal(stored.source_authority, 5);
  assert.equal(stored.metadata.requested_source, "user_correction");
});

test("Agent Bridge memory writes remain pending until authenticated confirmation", async () => {
  const result = await dispatcher.dispatchTestTool({
    descriptor: memory,
    args: { action: "remember", project: "memory_authority_project", type: "decision", content: "synthetic agent-authored decision" },
    context: { authIdentity: { principal_id: operator.principal_id, principal_type: "human" }, project: "memory_authority_project", source: "agent", taskId: "agt_memory_authority" },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = JSON.parse(result.content[0].text);
  const stored = db.getMemoryById(payload.memory.id, { includeDisabled: true });
  assert.equal(stored.source, "agent");
  assert.equal(stored.state, "pending");
  assert.equal(stored.requires_confirmation, true);
  assert.equal(stored.metadata.user_controlled, false);
  assert.equal(requiresMemoryConfirmation(stored), true);
});

test("legacy handoff and task-session memories of every type remain untrusted until confirmed", () => {
  for (const source of ["handoff", "task_session"]) {
    for (const type of ["fact", "decision", "procedure", "negative", "session", "open_thread", "observation"]) {
      assert.equal(requiresMemoryConfirmation({ source, type, state: "active", requires_confirmation: false }), true,
        `${source}/${type} legacy memory must not become trusted by omission`);
      assert.equal(requiresMemoryConfirmation({ source, type, state: "confirmed", requires_confirmation: false }), false,
        `${source}/${type} memory may enter trusted context after explicit confirmation`);
    }
  }
});

test("project write access cannot correct or confirm high-authority memory", async () => {
  const original = db.upsertMemory({ type: "fact", project: "memory_authority_project", content: "original synthetic fact", summary: "original synthetic fact", source: "explicit", source_authority: 5, requires_confirmation: true });
  assert.equal(dispatcher.requiredToolPermission(memory, { action: "correct" }), "tools.execute_critical");
  assert.equal(dispatcher.requiredToolPermission(memory, { action: "confirm" }), "tools.execute_critical");
  assert.equal(dispatcher.requiredToolPermission(memoryManage, { action: "confirm" }), "tools.execute_critical");

  const context = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" }, project: "memory_authority_project" };
  const correction = await dispatcher.dispatchTestTool({ descriptor: memory, args: { action: "correct", id: original.id, correct_to: "forged corrected fact", project: "memory_authority_project" }, context });
  const confirm = await dispatcher.dispatchTestTool({ descriptor: memory, args: { action: "confirm", id: original.id, project: "memory_authority_project", source: "forged-principal" }, context });
  const lifecycleConfirm = await dispatcher.dispatchTestTool({ descriptor: memoryManage, args: { action: "confirm", id: original.id, project: "memory_authority_project", confirmed_by: "forged-principal" }, context });

  for (const denied of [correction, confirm, lifecycleConfirm]) {
    assert.equal(denied.isError, true);
    assert.equal(denied.code, "authorization_denied");
  }
  const unchanged = db.getMemoryById(original.id, { includeDisabled: true });
  assert.equal(unchanged.state, "pending");
  assert.equal(unchanged.content, "original synthetic fact");
  assert.equal(unchanged.confirmed_by, null);
});

test("authorized confirmation records the authenticated principal, not caller text", async () => {
  const pending = db.upsertMemory({ type: "fact", project: "memory_authority_project", content: "owner reviewed synthetic claim", summary: "owner reviewed synthetic claim", source: "explicit", requires_confirmation: true });
  const result = await dispatcher.dispatchTestTool({
    descriptor: memoryManage,
    args: { action: "confirm", id: pending.id, project: "memory_authority_project", confirmed_by: "forged-principal" },
    context: { authIdentity: { principal_id: owner.principal_id, principal_type: "human" }, project: "memory_authority_project" },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(db.getMemoryById(pending.id, { includeDisabled: true }).confirmed_by, owner.principal_id);
});

test("memory imports stay untrusted and cannot rewrite trusted duplicate metadata", () => {
  const imported = db.importMemories({ memories: [{
    type: "fact",
    project: "memory_authority_project",
    content: "synthetic imported instruction claim",
    summary: "synthetic imported instruction claim",
    state: "confirmed",
    requires_confirmation: false,
    last_confirmed_at: new Date().toISOString(),
    times_confirmed: 9000,
    metadata: { source_authority: 100, verified: true },
  }] });
  assert.equal(imported.imported, 1);
  const row = db.searchMemories({ project: "memory_authority_project", query: "synthetic imported instruction claim", includeDisabled: true })[0];
  assert.ok(row);
  assert.equal(row.state, "pending");
  assert.equal(row.requires_confirmation, true);
  assert.equal(row.last_confirmed_at, null);
  assert.equal(row.times_confirmed, 0);
  assert.equal(requiresMemoryConfirmation(row), true);
  assert.equal(row.source, "import");
  assert.notEqual(row.source_authority, 100);
  assert.equal(row.metadata.source_authority, undefined);
  assert.equal(row.metadata.import_metadata.source_authority, 100);
  assert.ok(row.confidence <= 0.5);

  const trusted = db.upsertMemory({
    type: "fact", project: "memory_authority_project", content: "stable trusted duplicate",
    summary: "trusted summary", source: "explicit", source_authority: 5,
  });
  const before = db.getMemoryById(trusted.id, { includeDisabled: true });
  const duplicate = db.importMemories({ memories: [{
    type: "fact", project: "memory_authority_project", content: "stable trusted duplicate",
    summary: "injected replacement summary", confidence: 1, times_confirmed: 1000,
    metadata: { source_authority: 100, verified: true },
  }] });
  assert.equal(duplicate.skipped, 1);
  const after = db.getMemoryById(trusted.id, { includeDisabled: true });
  assert.equal(after.summary, before.summary);
  assert.equal(after.confidence, before.confidence);
  assert.equal(after.source_authority, before.source_authority);
  assert.equal(after.times_confirmed, before.times_confirmed);
  assert.equal(after.last_confirmed_at, before.last_confirmed_at);
});

test("memory writes and imports redact credential-shaped content and metadata before persistence", () => {
  const marker = "SYNTHETIC_MEMORY_PERSISTENCE_SECRET";
  const direct = db.upsertMemory({
    type: "fact",
    project: "memory_authority_project",
    content: `Connection uses api_key=${marker}`,
    summary: `Summary password=${marker}`,
    source: `credential=${marker}`,
    source_ref: `https://example.invalid/resource?access_token=${marker}`,
    evidence_excerpt: `token=${marker}`,
    metadata: { password: marker, note: `secret=${marker}` },
  });
  const directRow = db.getDb().prepare("SELECT content, summary, source, source_ref, evidence_excerpt, metadata_json FROM memories WHERE id = ?").get(direct.id);
  assert.equal(JSON.stringify(directRow).includes(marker), false, "direct write must not persist synthetic credential values");
  assert.equal(JSON.stringify(db.getMemoryById(direct.id, { includeDisabled: true })).includes(marker), false);

  const imported = db.importMemories({ memories: [{
    type: "observation",
    project: "memory_authority_project",
    content: `Imported token=${marker}`,
    summary: `Imported password=${marker}`,
    source: `api_key=${marker}`,
    source_ref: `https://example.invalid/import?token=${marker}`,
    evidence_excerpt: `credential=${marker}`,
    metadata: { access_key: marker, note: `password=${marker}` },
  }] });
  assert.equal(imported.imported, 1);
  const importedRow = db.getDb().prepare("SELECT content, summary, source_ref, metadata_json FROM memories WHERE source = 'import' AND content LIKE '%Imported%' ORDER BY created_at DESC LIMIT 1").get();
  assert.ok(importedRow);
  assert.equal(JSON.stringify(importedRow).includes(marker), false, "imported memory must not persist synthetic credential values");

  const lifecycle = db.upsertMemory({ type: "fact", project: "memory_authority_project", content: "synthetic lifecycle reason fixture", summary: "synthetic lifecycle reason fixture" });
  db.softDeleteMemory(lifecycle.id, `api_key=${marker}`);
  const lifecycleRow = db.getDb().prepare("SELECT metadata_json FROM memories WHERE id = ?").get(lifecycle.id);
  assert.equal(lifecycleRow.metadata_json.includes(marker), false, "lifecycle reason must not persist synthetic credentials");

  db.getDb().prepare("UPDATE memories SET content = ?, summary = ?, source_ref = ?, metadata_json = ? WHERE id = ?").run(
    `Legacy raw token=${marker}`,
    `Legacy api_key=${marker}`,
    `https://example.invalid/legacy?password=${marker}`,
    JSON.stringify({ password: marker, note: `secret=${marker}` }),
    direct.id,
  );
  const legacyProjection = db.getMemoryById(direct.id, { includeDisabled: true });
  assert.equal(JSON.stringify(legacyProjection).includes(marker), false, "memory projections must redact known credential shapes in legacy rows");
  const legacyRaw = db.getDb().prepare("SELECT content, metadata_json FROM memories WHERE id = ?").get(direct.id);
  assert.equal(JSON.stringify(legacyRaw).includes(marker), true, "read sanitization must not silently rewrite historical database rows");
});

test("legacy context documents are redacted on write and projection without rewriting legacy rows", () => {
  const marker = "SYNTHETIC_CONTEXT_PERSISTENCE_SECRET";
  db.setDocument("context", { decisions: [{ context: `api_key=${marker}`, decision: "Use a governed tool" }] });
  const stored = db.getDb().prepare("SELECT data_json FROM json_documents WHERE name = 'context'").get();
  assert.equal(stored.data_json.includes(marker), false, "new context documents must be sanitized before storage");
  assert.equal(JSON.stringify(db.loadDocument("context", {})).includes(marker), false);

  db.getDb().prepare("UPDATE json_documents SET data_json = ? WHERE name = 'context'").run(
    JSON.stringify({ problems: [{ description: `password=${marker}` }] }),
  );
  const legacyProjection = db.loadDocument("context", {});
  assert.equal(JSON.stringify(legacyProjection).includes(marker), false, "known credential patterns in old context rows must be sanitized on read");
  assert.equal(db.getDb().prepare("SELECT data_json FROM json_documents WHERE name = 'context'").get().data_json.includes(marker), true,
    "read sanitization must not silently rewrite historical rows");
});

test("legacy vector context payloads are redacted before recall", async () => {
  const marker = "SYNTHETIC_VECTOR_CONTEXT_SECRET";
  const qdrant = require("../src/qdrant");
  const inference = require("../src/compute/inference-service");
  const contextFamily = require("../src/tools/families/context");
  const originalAvailable = qdrant.isAvailable;
  const originalSearch = qdrant.search;
  const originalEmbed = inference.embed;
  try {
    qdrant.isAvailable = async () => true;
    qdrant.search = async () => [{
      payload: { type: "problem", data: { id: "legacy_vector_problem", project: "memory_authority_project", description: `Security review api_key=${marker}` } },
      score: 0.9,
    }];
    inference.embed = async () => ({ embedding: [0.1, 0.2] });
    const contextApi = require("../src/tools/context");
    const executionContext = contextApi.createTestExecutionContext({
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
      project: "memory_authority_project",
    });
    const results = await contextApi.runWithContext(executionContext,
      () => contextFamily.searchContext({}, "Security review", "all", 10, "memory_authority_project"));
    assert.ok(results.some(result => result.item.id === "legacy_vector_problem"));
    assert.equal(JSON.stringify(results).includes(marker), false, "legacy vector payload must be sanitized before context recall");
  } finally {
    qdrant.isAvailable = originalAvailable;
    qdrant.search = originalSearch;
    inference.embed = originalEmbed;
  }
});

test("failed replacement persistence rolls back the old-memory deletion", async () => {
  const original = db.upsertMemory({ type: "fact", project: "memory_authority_project", content: "atomic correction original", summary: "atomic correction original", source: "explicit", source_authority: 5 });
  const upsertMemory = db.upsertMemory;
  db.upsertMemory = () => { throw new Error("synthetic replacement write failure"); };
  try {
    const result = await dispatcher.dispatchTestTool({
      descriptor: memory,
      args: { action: "correct", id: original.id, correct_to: "replacement that must not persist", project: "memory_authority_project" },
      context: { authIdentity: { principal_id: owner.principal_id, principal_type: "human" }, project: "memory_authority_project" },
    });
    assert.equal(result.isError, true);
  } finally {
    db.upsertMemory = upsertMemory;
  }
  const unchanged = db.getMemoryById(original.id, { includeDisabled: true });
  assert.equal(unchanged.state, "active");
  assert.equal(unchanged.content, "atomic correction original");
  assert.equal(db.searchMemories({ project: "memory_authority_project", query: "replacement that must not persist", includeDisabled: true }).length, 0);
});
