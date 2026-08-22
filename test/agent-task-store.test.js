"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-agent-task-"));
process.env.SIDEKICK_DATA_DIR = data;
process.env.SIDEKICK_SECRET_KEY_FILE = path.join(data, "secret");
fs.writeFileSync(process.env.SIDEKICK_SECRET_KEY_FILE, "test-only-key");
const { createTask } = require("../src/agent/task-model");
const store = require("../src/agent/task-store");
try {
  const task = createTask({ task_id: "agt_store01", objective: "Inspect the service", profile: "quick" });
  assert.strictEqual(store.insertTask(task).task_id, "agt_store01");
  assert.strictEqual(store.getTask("agt_store01").state, "created");
  store.updateTask("agt_store01", { state: "planning", phase: "planning", next_action: "draft_plan" });
  store.checkpointTask("agt_store01", { version: 1, safe_boundary: "after_goal", next_action: "draft_plan" });
  store.addPlanRevision("agt_store01", { version: 1, steps: [] });
  store.addFailure("agt_store01", { action_fingerprint: "a", error_class: "timeout", retryable: true });
  store.recordCompletedOperation("agt_store01", { fingerprint: "read-fp", capability: "read", read_only: true, receipt_ref: "op-1", summary: "bounded read completed" });
  assert.strictEqual(store.getTask("agt_store01").continuation.completed_operations[0].receipt_ref, "op-1");
  store.recordAmbiguousOperation("agt_store01", { fingerprint: "write-fp", capability: "write", reason: "receipt unavailable" });
  assert.strictEqual(store.getTask("agt_store01").state, "blocked");
  const events = store.listEvents("agt_store01");
  assert.ok(events.some(event => event.event_type === "task.checkpoint"));
  assert.strictEqual(store.listTasks({ state: "blocked" }).length, 1);
  console.log("Agent task store: passed");
} finally { try { fs.rmSync(data, { recursive: true, force: true }); } catch {} }
