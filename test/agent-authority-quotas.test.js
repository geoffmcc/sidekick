"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const dataDir = process.env.SIDEKICK_TEST_DATA_DIR;
const dbFile = process.env.SIDEKICK_TEST_DB_FILE;
assert.ok(dataDir, "test runner must provide an isolated data directory");
assert.ok(dbFile, "test runner must provide an isolated database file");
Object.assign(process.env, {
  NODE_ENV: "test",
  SIDEKICK_DATA_DIR: dataDir,
  SIDEKICK_DB_FILE: dbFile,
  SIDEKICK_SECRET_KEY_FILE: path.join(dataDir, "test-secret-key"),
});
fs.writeFileSync(process.env.SIDEKICK_SECRET_KEY_FILE, "synthetic-authority-quota-test-key");

const { createAuthorityEnvelope } = require("../src/agent/authority");
const { createTask } = require("../src/agent/task-model");
const taskStore = require("../src/agent/task-store");
const durableOperations = require("../src/agent/durable-operations");
const db = require("../src/db").getDb();

function taskId(label) { return `agt_quota_${label}_${require("node:crypto").randomUUID().replaceAll("-", "")}`; }

test("authority quota limits are integer-bounded at creation and enforcement", () => {
  const normalized = createAuthorityEnvelope({ child_task_depth: 1.9, child_task_count: 1.9, concurrency_limit: 1.9 });
  assert.equal(normalized.child_task_depth, 1);
  assert.equal(normalized.child_task_count, 1);
  assert.equal(normalized.concurrency_limit, 1);

  const fractionalFanout = createTask({
    task_id: taskId("fanout"),
    objective: "Bound fractional child task quota",
    authority_envelope: { child_task_depth: 1.9, child_task_count: 1.9 },
  });
  taskStore.insertTask(fractionalFanout);
  assert.equal(taskStore.reserveChildTask(fractionalFanout.task_id).remaining, 0);
  assert.throws(() => taskStore.reserveChildTask(fractionalFanout.task_id), /child-task envelope limit reached/);

  const tampered = createTask({ task_id: taskId("tampered"), objective: "Bound persisted fractional quota" });
  taskStore.insertTask(tampered);
  db.prepare("UPDATE agent_tasks SET authority_envelope_json=? WHERE task_id=?")
    .run(JSON.stringify({ ...tampered.authority_envelope, child_task_depth: 1.9, child_task_count: 1.9 }), tampered.task_id);
  assert.equal(taskStore.reserveChildTask(tampered.task_id).remaining, 0, "durable reservation enforcement floors malformed persisted limits");
  assert.throws(() => taskStore.reserveChildTask(tampered.task_id), /child-task envelope limit reached/);

  const fractionalConcurrency = createTask({
    task_id: taskId("concurrency"),
    objective: "Bound fractional work package concurrency",
    authority_envelope: { concurrency_limit: 1.9 },
  });
  taskStore.insertTask(fractionalConcurrency);
  db.prepare("UPDATE agent_tasks SET authority_envelope_json=? WHERE task_id=?")
    .run(JSON.stringify({ ...fractionalConcurrency.authority_envelope, concurrency_limit: 1.9 }), fractionalConcurrency.task_id);
  const first = durableOperations.createWorkPackage({ task_id: fractionalConcurrency.task_id, package_key: "first" });
  const second = durableOperations.createWorkPackage({ task_id: fractionalConcurrency.task_id, package_key: "second" });
  durableOperations.claimWorkPackage(first.package_id, "quota-test-worker-1");
  try {
    assert.throws(() => durableOperations.claimWorkPackage(second.package_id, "quota-test-worker-2"), /concurrency limit/);
  } finally {
    durableOperations.finishWorkPackage(first.package_id, "completed", { verified: true }, "quota-test-worker-1");
  }
});
