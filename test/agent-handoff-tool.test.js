"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const data = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-agent-handoff-tool-"));
process.env.SIDEKICK_DATA_DIR = data;
process.env.SIDEKICK_SECRET_KEY_FILE = path.join(data, "secret");
fs.writeFileSync(process.env.SIDEKICK_SECRET_KEY_FILE, "test-only-key");

const { createTask } = require("../src/agent/task-model");
const tasks = require("../src/agent/task-store");
const dbStore = require("../src/db");
const { TOOLS } = require("../src/tools");
const context = require("../src/tools/context");
const identity = require("../src/core/identity");
const platformKernel = require("../src/platform/kernel");

dbStore.runPendingMigrations();
const owner = identity.bootstrapOwner({ username: "agent_handoff_test_owner", password: "a sufficiently long synthetic test password" });
platformKernel.registerProject({ project_id: "handoff-tool-test", owner_actor_id: owner.principal_id, source: "test" });

function parse(result) { return JSON.parse(result.content[0].text); }

(async () => {
  try {
    const task = createTask({ task_id: "agt_handoff_tool01", objective: "Build a durable continuation", profile: "quick", project_id: "handoff-tool-test", requested_by_principal_id: owner.principal_id, actor_principal_id: owner.principal_id });
    tasks.insertTask(task);
    const result = await context.runWithContext(context.createAgentExecutionContext({ taskId: task.task_id, project: task.project_id, authIdentity: { principal_id: owner.principal_id, principal_type: "human" } }), () => TOOLS.handoff({
      action: "create",
      project: task.project_id,
      title: "Agent continuity",
      content: "The Agent has started the durable continuation.",
      packet: {
        objective: task.objective,
        summary: "A receiver must continue the complete plan.",
        status: "active",
        next_step: "Inspect the durable task checkpoint",
        completed_steps: [],
        acceptance_criteria: ["Receiver can recover the task state"],
        evidence: [{ type: "continuity_checkpoint", label: "Initial snapshot", status: "verified", observed_at: new Date().toISOString() }],
        provenance: { working_directory: process.cwd(), task_id: task.task_id },
      },
    }));
    const handoff = parse(result).handoff;
    assert.strictEqual(tasks.getTask(task.task_id).handoff_id, handoff.id, "Agent handoff creation binds the artifact to the durable task");
    assert.strictEqual(handoff.task_id, task.task_id, "handoff records its producing task");
    assert.strictEqual(handoff.lifecycle_state, "active", "Agent handoff creation activates the continuity record immediately");
    assert.ok(handoff.checkpoint_hash, "Agent handoff creation captures a repository checkpoint immediately");
    assert.ok(dbStore.getHandoffEvidenceState(handoff.id).length > 0, "Agent handoff creation refreshes evidence state immediately");
    console.log("Agent handoff tool continuity: passed");
  } finally {
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
