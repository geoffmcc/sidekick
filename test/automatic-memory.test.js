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

const ctx = loadContext();
assert.ok(Array.isArray(ctx.memories), "Context should include memories array");
assert.ok(ctx.memories.length >= 2, "Context should retain automatic memories");
assert.ok(Array.isArray(ctx.sessions), "Context should include sessions array");
assert.ok(ctx.sessions.some(s => s.taskId === "task123"), "Agent task should create a session summary");

const recalled = recallMemoryForText("sidekick service health", { limit: 5 });
assert.ok(recalled.length > 0, "Recall should return relevant memories");

const formatted = formatMemoryRecall(recalled);
assert.ok(formatted.includes("sidekick"), "Formatted recall should include relevant text");

console.log("Automatic memory tests passed");
