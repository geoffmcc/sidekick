const assert = require("assert");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "test-data-extension-docs-" + Date.now());
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

// EX.1: registerExtension registers extension
test("EX.1: registerExtension registers extension", () => {
  const ext = platformKernel.registerExtension({ name: "test_plugin", version: "1.0.0", type: "plugin", author: "admin", description: "A test plugin", entry_point: "./index.js", capabilities: ["chat", "tools"], dependencies: ["openai"], hooks: ["before_execute"], config_schema: { api_key: { type: "string", required: true } } });
  assert.ok(ext.extension_id);
  assert.strictEqual(ext.name, "test_plugin");
  assert.strictEqual(ext.version, "1.0.0");
  assert.strictEqual(ext.state, "registered");
});

// EX.2: getExtension returns parsed fields
test("EX.2: getExtension returns parsed fields", () => {
  const ext = platformKernel.registerExtension({ name: "parsed_ext", capabilities: ["a"], dependencies: ["b"], config: { key: "val" }, hooks: ["hook1"], metadata: { env: "prod" } });
  const got = platformKernel.getExtension(ext.extension_id);
  assert.deepStrictEqual(got.capabilities, ["a"]);
  assert.deepStrictEqual(got.dependencies, ["b"]);
  assert.deepStrictEqual(got.config, { key: "val" });
  assert.deepStrictEqual(got.hooks, ["hook1"]);
  assert.deepStrictEqual(got.metadata, { env: "prod" });
});

// EX.3: getExtensionByName finds extension
test("EX.3: getExtensionByName finds extension", () => {
  platformKernel.registerExtension({ name: "find_ext" });
  const found = platformKernel.getExtensionByName("find_ext");
  assert.ok(found);
  assert.strictEqual(found.name, "find_ext");
});

// EX.4: getExtensionByName returns null for missing
test("EX.4: getExtensionByName returns null for missing", () => {
  const found = platformKernel.getExtensionByName("nonexistent_ext");
  assert.strictEqual(found, null);
});

// EX.5: activateExtension activates registered extension
test("EX.5: activateExtension activates registered", () => {
  const ext = platformKernel.registerExtension({ name: "activate_ext" });
  const activated = platformKernel.activateExtension(ext.extension_id, { actor_id: "admin" });
  assert.strictEqual(activated.state, "active");
  assert.ok(activated.activated_at);
});

// EX.6: deactivateExtension deactivates active extension
test("EX.6: deactivateExtension deactivates active", () => {
  const ext = platformKernel.registerExtension({ name: "deactivate_ext" });
  platformKernel.activateExtension(ext.extension_id);
  const deactivated = platformKernel.deactivateExtension(ext.extension_id, { actor_id: "admin", reason: "update" });
  assert.strictEqual(deactivated.state, "deactivated");
  assert.ok(deactivated.deactivated_at);
});

// EX.7: uninstallExtension uninstalls extension
test("EX.7: uninstallExtension uninstalls", () => {
  const ext = platformKernel.registerExtension({ name: "uninstall_ext" });
  const uninstalled = platformKernel.uninstallExtension(ext.extension_id, { actor_id: "admin", reason: "removed" });
  assert.strictEqual(uninstalled.state, "uninstalled");
  assert.ok(uninstalled.uninstalled_at);
});

// EX.8: updateExtensionConfig updates config
test("EX.8: updateExtensionConfig updates config", () => {
  const ext = platformKernel.registerExtension({ name: "config_ext", config: { v: 1 } });
  const updated = platformKernel.updateExtensionConfig(ext.extension_id, { v: 2, new_key: "new" });
  assert.strictEqual(updated.config_json.includes('"v":2'), true);
});

// EX.9: recordExtensionUsage increments count
test("EX.9: recordExtensionUsage increments count", () => {
  const ext = platformKernel.registerExtension({ name: "usage_ext" });
  platformKernel.recordExtensionUsage(ext.extension_id);
  platformKernel.recordExtensionUsage(ext.extension_id);
  const updated = platformKernel.getExtension(ext.extension_id);
  assert.strictEqual(updated.usage_count, 2);
  assert.ok(updated.last_used_at);
});

// EX.10: listExtensions lists all
test("EX.10: listExtensions lists all", () => {
  platformKernel.registerExtension({ name: "list_ext_a" });
  platformKernel.registerExtension({ name: "list_ext_b" });
  const all = platformKernel.listExtensions();
  assert.ok(all.length >= 2);
});

// EX.11: listExtensions filters by state
test("EX.11: listExtensions filters by state", () => {
  const ext = platformKernel.registerExtension({ name: "filter_state_ext" });
  platformKernel.activateExtension(ext.extension_id);
  const active = platformKernel.listExtensions({ state: "active" });
  assert.ok(active.every(e => e.state === "active"));
});

// EX.12: listExtensions filters by type
test("EX.12: listExtensions filters by type", () => {
  platformKernel.registerExtension({ name: "filter_type_ext", type: "theme" });
  const themes = platformKernel.listExtensions({ type: "theme" });
  assert.ok(themes.every(e => e.type === "theme"));
});

// EX.13: extension emits events
test("EX.13: extension emits events", () => {
  const ext = platformKernel.registerExtension({ name: "events_ext" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'extension.registered' AND subject_id = ?").all(ext.extension_id);
  assert.ok(events.length > 0);
});

// EX.14: activate emits event
test("EX.14: activate emits event", () => {
  const ext = platformKernel.registerExtension({ name: "activate_event_ext" });
  platformKernel.activateExtension(ext.extension_id);
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'extension.activated' AND subject_id = ?").all(ext.extension_id);
  assert.ok(events.length > 0);
});

// EX.15: uninstall emits warning event
test("EX.15: uninstall emits warning event", () => {
  const ext = platformKernel.registerExtension({ name: "uninstall_event_ext" });
  platformKernel.uninstallExtension(ext.extension_id, { reason: "broken" });
  const events = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'extension.uninstalled' AND subject_id = ?").all(ext.extension_id);
  assert.ok(events.length > 0);
  assert.strictEqual(events[0].severity, "warning");
});

// DC.1: generatePlatformDocs generates summary
test("DC.1: generatePlatformDocs generates summary", () => {
  const docs = platformKernel.generatePlatformDocs();
  assert.ok(docs.generated_at);
  assert.ok(docs.summary);
  assert.ok(Array.isArray(docs.tables));
  assert.ok(docs.tables.length >= 10);
});

// DC.2: generatePlatformDocs includes counts
test("DC.2: generatePlatformDocs includes counts", () => {
  const docs = platformKernel.generatePlatformDocs();
  assert.strictEqual(typeof docs.summary.executions, "number");
  assert.strictEqual(typeof docs.summary.events, "number");
  assert.strictEqual(typeof docs.summary.models, "number");
  assert.strictEqual(typeof docs.summary.extensions, "number");
});

// DC.3: generatePlatformDocs includes state breakdown
test("DC.3: generatePlatformDocs includes state breakdown", () => {
  platformKernel.createExecution({ operation_type: "test", tool_name: "test" });
  const docs = platformKernel.generatePlatformDocs();
  assert.ok(Array.isArray(docs.execution_states));
});

// DC.4: generatePlatformDocs includes recent events
test("DC.4: generatePlatformDocs includes recent events", () => {
  const docs = platformKernel.generatePlatformDocs();
  assert.ok(Array.isArray(docs.recent_events_24h));
});

// DC.5: generatePlatformDocs includes active models
test("DC.5: generatePlatformDocs includes active models", () => {
  platformKernel.registerModel({ name: "docs_model", provider: "test" });
  const docs = platformKernel.generatePlatformDocs();
  assert.ok(Array.isArray(docs.active_models));
});

// DC.6: generatePlatformDocs includes active extensions
test("DC.6: generatePlatformDocs includes active extensions", () => {
  const ext = platformKernel.registerExtension({ name: "docs_ext" });
  platformKernel.activateExtension(ext.extension_id);
  const docs = platformKernel.generatePlatformDocs();
  assert.ok(Array.isArray(docs.active_extensions));
});

cleanup();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
