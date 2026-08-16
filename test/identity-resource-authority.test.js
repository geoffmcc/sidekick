const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, `test-data-identity-resource-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
delete require.cache[require.resolve("../src/platform/kernel")];
const db = require("../src/db");
const kernel = require("../src/platform/kernel");

try {
  db.runPendingMigrations();
  kernel.ensurePlatformKernelSchema();
  const principal = "prn_identity_resource_test";

  const runner = kernel.createRunnerSession({
    requested_by_principal_id: principal,
    actor_principal_id: "prn_agent_test",
    acting_for_principal_id: principal,
    executed_by_principal_id: "prn_agent_test",
  });
  assert.strictEqual(runner.requested_by_principal_id, principal);
  assert.strictEqual(runner.actor_principal_id, "prn_agent_test");
  assert.strictEqual(runner.acting_for_principal_id, principal);
  assert.strictEqual(runner.executed_by_principal_id, "prn_agent_test");

  const artifact = kernel.registerArtifact({
    storage_ref: "identity-resource-test.json",
    owner_principal_id: principal,
    created_by_principal_id: "prn_agent_test",
    actor_principal_id: "prn_agent_test",
  });
  assert.strictEqual(artifact.owner_principal_id, principal);
  assert.strictEqual(artifact.created_by_principal_id, "prn_agent_test");

  const session = db.saveTaskSession({
    goal: "identity resource authority test",
    owner_principal_id: principal,
    created_by_principal_id: "prn_agent_test",
  });
  assert.strictEqual(session.owner_principal_id, principal);
  assert.strictEqual(session.created_by_principal_id, "prn_agent_test");

  const handoff = db.saveHandoff({
    project: "identity-resource-test",
    content: "Completed identity resource authority test.",
    owner_principal_id: principal,
    created_by_principal_id: "prn_agent_test",
  });
  assert.strictEqual(handoff.owner_principal_id, principal);
  assert.strictEqual(handoff.created_by_principal_id, "prn_agent_test");

  console.log("Identity resource authority: 4 passed");
} finally {
  try { db.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
