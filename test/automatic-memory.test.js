#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-memory-test-"));
process.env.SIDEKICK_DATA_DIR = tempDir;
process.env.SIDEKICK_AUTO_MEMORY = "1";
process.env.SIDEKICK_AUTO_MEMORY_MAX = "10";

const {
  loadContext,
  recordToolCallMemory,
  recordAgentTaskMemory,
  recallMemoryForText,
  formatMemoryRecall
} = require("../src/memory");
const dbStore = require("../src/db");

dbStore.runPendingMigrations();

console.log("Test automatic memory capture and recall");

const toolMemory = recordToolCallMemory({
  name: "sidekick_bash",
  args: { command: "systemctl status sidekick-mcp", project: "sidekick" },
  duration: 42,
  success: true,
  summary: "sidekick-mcp is active",
  source: "agent"
});

assert.ok(toolMemory, "Tool memory should be stored");
assert.strictEqual(toolMemory.project, "sidekick", "Project should be inferred from args");
assert.strictEqual(toolMemory.type, "tool_call", "Tool memory should be stored as structured tool_call memory");

const taskMemory = recordAgentTaskMemory({
  goal: "Check project sidekick service health",
  taskId: "task123",
  status: "completed",
  steps: [
    { type: "tool", tool: "sidekick_bash", args: { command: "systemctl status sidekick-mcp", project: "sidekick" }, result: "active" },
    { type: "done", text: "sidekick-mcp is active" }
  ]
});

assert.ok(taskMemory, "Agent task memory should be stored");
assert.strictEqual(taskMemory.memory.project, "sidekick", "Task project should be inferred from goal");
assert.strictEqual(taskMemory.memory.type, "session", "Agent task memory should be stored as structured session memory");

const ctx = loadContext();
assert.ok(Array.isArray(ctx.memories), "Context should include memories array");
assert.ok(ctx.memories.length >= 2, "Context should retain automatic memories");
assert.ok(Array.isArray(ctx.sessions), "Context should include sessions array");
assert.ok(ctx.sessions.some(s => s.taskId === "task123"), "Agent task should create a session summary");

const recalled = recallMemoryForText("sidekick service health", { limit: 5 });
assert.ok(recalled.length > 0, "Recall should return relevant memories");
assert.ok(recalled.some(item => item.structured), "Recall should include table-backed structured memories");

const formatted = formatMemoryRecall(recalled);
assert.ok(formatted.includes("sidekick"), "Formatted recall should include relevant text");

const beforeDedup = dbStore.searchMemories({ type: "tool_call", project: "sidekick", limit: 20 });
recordToolCallMemory({
  name: "sidekick_bash",
  args: { command: "systemctl status sidekick-mcp", project: "sidekick" },
  duration: 24,
  success: true,
  summary: "sidekick-mcp is active",
  source: "agent"
});
const afterDedup = dbStore.searchMemories({ type: "tool_call", project: "sidekick", limit: 20 });
assert.strictEqual(afterDedup.length, beforeDedup.length, "Duplicate structured memory should update existing row");
assert.ok(afterDedup[0].times_confirmed >= 2, "Duplicate structured memory should increment confirmation count");

const extractedTask = recordAgentTaskMemory({
  goal: "I decided to keep LF line endings. Prefer SQLite for structured memory. Follow up on the dashboard review. The database file is sidekick.db.",
  project: "sidekick",
  taskId: "task_extract",
  status: "completed",
  steps: [
    { type: "tool", tool: "sidekick_bash", args: { command: "echo structured memory", project: "sidekick" }, result: "ok" },
    { type: "done", text: "Completed extraction test task" }
  ]
});

assert.ok(Array.isArray(extractedTask.extracted), "Task extraction should return extracted memories");
assert.ok(extractedTask.extracted.length >= 2, "Task extraction should produce structured memories");
const preferences = dbStore.searchMemories({ type: "preference", project: "sidekick", limit: 10 });
const facts = dbStore.searchMemories({ type: "fact", project: "sidekick", limit: 10 });
const openThreads = dbStore.searchMemories({ type: "open_thread", project: "sidekick", limit: 10 });

assert.ok(preferences.some(m => m.source_task_id === "task_extract"), "Should store a preference memory");
assert.ok(facts.some(m => m.source_task_id === "task_extract"), "Should store a fact memory");
assert.ok(openThreads.some(m => m.source_task_id === "task_extract"), "Should store an open-thread memory");

const conflictTask = recordAgentTaskMemory({
  goal: "Prefer PostgreSQL for structured memory.",
  project: "sidekick",
  taskId: "task_conflict",
  status: "completed",
  steps: [
    { type: "done", text: "Recorded a conflicting preference" }
  ]
});

assert.ok(Array.isArray(conflictTask.extracted), "Conflicting task should still extract memories");
const allPreferences = dbStore.searchMemories({ type: "preference", project: "sidekick", includeDisabled: true, limit: 20 });
const sqlitePreference = allPreferences.find(m => /sqlite/i.test(m.summary || m.content || ""));
const postgresPreference = allPreferences.find(m => /postgresql/i.test(m.summary || m.content || ""));

assert.ok(sqlitePreference, "Should retain the original SQLite preference row");
assert.ok(postgresPreference, "Should store the new PostgreSQL preference row");
assert.strictEqual(sqlitePreference.enabled, false, "Conflicting older memory should be superseded");
assert.strictEqual(sqlitePreference.metadata.state, "superseded", "Superseded memory should be marked in metadata");
assert.strictEqual(sqlitePreference.metadata.superseded_by, postgresPreference.id, "Superseded row should point to replacement");
assert.strictEqual(postgresPreference.enabled, true, "Replacement memory should remain enabled");

console.log("Automatic memory tests passed");
