const assert = require("assert");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-workspace-model-" + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = DATA_DIR;

delete require.cache[require.resolve("../src/db")];
delete require.cache[require.resolve("../src/platform/kernel")];

const dbStore = require("../src/db");
const platformKernel = require("../src/platform/kernel");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function cleanup() {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

// WS.1: createProjectWorkspace creates workspace
test("WS.1: createProjectWorkspace creates workspace", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "my_project", project_id: "proj_1", owner_id: "admin", config: { language: "en" }, resource_limits: { max_memory_mb: 1024 } });
  assert.ok(ws.workspace_id);
  assert.strictEqual(ws.name, "my_project");
  assert.strictEqual(ws.project_id, "proj_1");
  assert.strictEqual(ws.state, "active");
});

// WS.2: getProjectWorkspace returns parsed fields
test("WS.2: getProjectWorkspace returns parsed fields", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "test_get", project_id: "proj_2", config: { debug: true }, secrets: { api_key: "secret123" }, metadata: { region: "us-east" } });
  const got = platformKernel.getProjectWorkspace(ws.workspace_id);
  assert.deepStrictEqual(got.config, { debug: true });
  assert.deepStrictEqual(got.secrets, { api_key: "secret123" });
  assert.deepStrictEqual(got.metadata, { region: "us-east" });
});

// WS.3: getWorkspaceByProject finds active workspace
test("WS.3: getWorkspaceByProject finds active workspace", () => {
  platformKernel.createProjectWorkspace({ name: "find_me", project_id: "proj_3" });
  const found = platformKernel.getWorkspaceByProject("proj_3");
  assert.ok(found);
  assert.strictEqual(found.project_id, "proj_3");
});

// WS.4: getWorkspaceByProject returns null for missing
test("WS.4: getWorkspaceByProject returns null for missing", () => {
  const found = platformKernel.getWorkspaceByProject("proj_nonexistent");
  assert.strictEqual(found, null);
});

// WS.5: updateProjectWorkspace updates config
test("WS.5: updateProjectWorkspace updates config", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "update_test", project_id: "proj_5", config: { v: 1 } });
  const updated = platformKernel.updateProjectWorkspace(ws.workspace_id, { config: { v: 2 }, actor_id: "admin" });
  assert.strictEqual(updated.config_json.includes('"v":2'), true);
});

// WS.6: updateProjectWorkspace rejects missing workspace
test("WS.6: updateProjectWorkspace rejects missing", () => {
  assert.throws(() => { platformKernel.updateProjectWorkspace("ws_nonexistent"); }, /not found/);
});

// WS.7: archiveProjectWorkspace archives workspace
test("WS.7: archiveProjectWorkspace archives", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "archive_test", project_id: "proj_7" });
  const archived = platformKernel.archiveProjectWorkspace(ws.workspace_id, { actor_id: "admin" });
  assert.strictEqual(archived.state, "archived");
  assert.ok(archived.archived_at);
});

// WS.8: getWorkspaceByProject excludes archived
test("WS.8: getWorkspaceByProject excludes archived", () => {
  platformKernel.createProjectWorkspace({ name: "archive_exclude", project_id: "proj_8" });
  const ws = platformKernel.getWorkspaceByProject("proj_8");
  platformKernel.archiveProjectWorkspace(ws.workspace_id);
  const found = platformKernel.getWorkspaceByProject("proj_8");
  assert.strictEqual(found, null);
});

// WS.9: workspace emits events
test("WS.9: workspace emits events", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "events_test", project_id: "proj_9" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'workspace.created' AND subject_id = ?").all(ws.workspace_id);
  assert.ok(events.length > 0);
});

// WS.10: updateProjectWorkspace emits event
test("WS.10: update emits event", () => {
  const ws = platformKernel.createProjectWorkspace({ name: "update_event", project_id: "proj_10" });
  platformKernel.updateProjectWorkspace(ws.workspace_id, { config: { changed: true } });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'workspace.updated' AND subject_id = ?").all(ws.workspace_id);
  assert.ok(events.length > 0);
});

// MD.1: registerModel registers model
test("MD.1: registerModel registers model", () => {
  const model = platformKernel.registerModel({ name: "gpt-4", provider: "openai", version: "2024-01", capabilities: ["chat", "vision"], context_window: 128000, supports_streaming: true, supports_vision: true });
  assert.ok(model.model_id);
  assert.strictEqual(model.name, "gpt-4");
  assert.strictEqual(model.provider, "openai");
  assert.strictEqual(model.state, "registered");
  assert.strictEqual(model.supports_streaming, 1);
  assert.strictEqual(model.supports_vision, 1);
});

// MD.2: getModel returns parsed fields
test("MD.2: getModel returns parsed fields", () => {
  const model = platformKernel.registerModel({ name: "claude-3", provider: "anthropic", capabilities: ["chat"], metadata: { tier: "enterprise" } });
  const got = platformKernel.getModel(model.model_id);
  assert.deepStrictEqual(got.capabilities, ["chat"]);
  assert.strictEqual(got.supports_streaming, false);
  assert.deepStrictEqual(got.metadata, { tier: "enterprise" });
});

// MD.3: getModelByName finds model
test("MD.3: getModelByName finds model", () => {
  platformKernel.registerModel({ name: "find_me", provider: "test_provider" });
  const found = platformKernel.getModelByName("find_me", "test_provider");
  assert.ok(found);
  assert.strictEqual(found.name, "find_me");
});

// MD.4: getModelByName returns null for missing
test("MD.4: getModelByName returns null for missing", () => {
  const found = platformKernel.getModelByName("nonexistent", "provider");
  assert.strictEqual(found, null);
});

// MD.5: listModels lists all
test("MD.5: listModels lists all", () => {
  platformKernel.registerModel({ name: "list_a", provider: "p1" });
  platformKernel.registerModel({ name: "list_b", provider: "p2" });
  const all = platformKernel.listModels();
  assert.ok(all.length >= 2);
});

// MD.6: listModels filters by provider
test("MD.6: listModels filters by provider", () => {
  platformKernel.registerModel({ name: "filter_a", provider: "filter_p1" });
  platformKernel.registerModel({ name: "filter_b", provider: "filter_p2" });
  const filtered = platformKernel.listModels({ provider: "filter_p1" });
  assert.ok(filtered.every(m => m.provider === "filter_p1"));
});

// MD.7: deprecateModel marks deprecated
test("MD.7: deprecateModel marks deprecated", () => {
  const model = platformKernel.registerModel({ name: "deprecate_test", provider: "p" });
  const deprecated = platformKernel.deprecateModel(model.model_id, { reason: "replaced" });
  assert.strictEqual(deprecated.state, "deprecated");
  assert.ok(deprecated.deprecated_at);
});

// MD.8: recordModelUsage increments count
test("MD.8: recordModelUsage increments count", () => {
  const model = platformKernel.registerModel({ name: "usage_test", provider: "p" });
  platformKernel.recordModelUsage(model.model_id);
  platformKernel.recordModelUsage(model.model_id);
  const updated = platformKernel.getModel(model.model_id);
  assert.strictEqual(updated.usage_count, 2);
  assert.ok(updated.last_used_at);
});

// MD.9: model emits events
test("MD.9: model emits events", () => {
  const model = platformKernel.registerModel({ name: "events_model", provider: "p" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'model.registered' AND subject_id = ?").all(model.model_id);
  assert.ok(events.length > 0);
});

// MD.10: deprecate emits warning event
test("MD.10: deprecate emits warning event", () => {
  const model = platformKernel.registerModel({ name: "deprecate_event", provider: "p" });
  platformKernel.deprecateModel(model.model_id, { reason: "old" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'model.deprecated' AND subject_id = ?").all(model.model_id);
  assert.ok(events.length > 0);
  assert.strictEqual(events[0].severity, "warning");
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
