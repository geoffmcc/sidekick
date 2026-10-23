"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const previousDataDir = process.env.SIDEKICK_DATA_DIR;
const previousDbFile = process.env.SIDEKICK_DB_FILE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-durable-credential-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick-test.db");
process.env.SIDEKICK_SECRET_KEY_FILE = path.join(dataDir, "secret");
fs.writeFileSync(process.env.SIDEKICK_SECRET_KEY_FILE, "synthetic-security-test-key");

const db = require("../src/db");
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const taskStore = require("../src/agent/task-store");
const { createTask } = require("../src/agent/task-model");
const { persistedTaskAuthIdentity } = require("../src/agent/task-identity");
const { authorizeRecoveredTask } = require("../src/agent/recovery-authorization");
db.runPendingMigrations();

test("durable task recovery uses the live credential record after database restore", () => {
  const owner = identity.bootstrapOwner({ username: "durable_recovery_owner", password: "synthetic durable recovery owner password" });
  const principal = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Synthetic recovery principal", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
  identity.assignRole(principal.principal_id, "operator", owner.principal_id);
  const created = authentication.createCredential({
    principalId: principal.principal_id,
    displayName: "Synthetic durable task credential",
    scopes: ["memory.read", "tools.execute"],
    createdByPrincipalId: owner.principal_id,
    actorContext: owner,
  });
  const task = createTask({
    task_id: "agt_security_credential01",
    objective: "synthetic credential recovery",
    actor_principal_id: principal.principal_id,
    requested_by_principal_id: principal.principal_id,
    principal_context: { credential_id: created.credential.credential_id, credential_scopes: created.credential.scopes },
  });
  taskStore.insertTask(task);

  const restored = taskStore.getTask(task.task_id);
  assert.equal(restored.principal_context.credential_id, created.credential.credential_id);
  const auth = persistedTaskAuthIdentity(restored);
  assert.ok(auth, `restored durable identity should validate: ${JSON.stringify({ principal: restored.actor_principal_id, context: restored.principal_context, credential: authentication.getCredential(created.credential.credential_id) })}`);
  assert.equal(auth.principal_id, principal.principal_id);
  assert.equal(auth.credential_id, created.credential.credential_id);
  assert.deepEqual(auth.scopes, ["memory.read", "tools.execute"]);
  const recoveryDeps = {
    resolvePrincipalIdentity: persistedTaskAuthIdentity,
    isPrincipalEnabled: principalId => Boolean(identity.getPrincipal(principalId)?.enabled),
    hasProjectTaskAccess: () => true,
  };
  assert.equal(authorizeRecoveredTask(restored, recoveryDeps).ok, true, "valid current credential allows recovery preflight");

  db.getDb().prepare("UPDATE identity_credentials SET scopes_json=? WHERE credential_id=?")
    .run(JSON.stringify(["memory.read"]), created.credential.credential_id);
  assert.deepEqual(persistedTaskAuthIdentity(taskStore.getTask(task.task_id)).scopes, ["memory.read"], "scope reductions apply after restart and cannot be regained from the task snapshot");

  db.getDb().prepare("UPDATE identity_credentials SET expires_at=? WHERE credential_id=?")
    .run(new Date(Date.now() - 1000).toISOString(), created.credential.credential_id);
  assert.equal(persistedTaskAuthIdentity(taskStore.getTask(task.task_id)), null, "credential expiry prevents durable task authority reconstruction");

  assert.equal(authentication.revokeCredential(created.credential.credential_id, owner), true);
  assert.equal(persistedTaskAuthIdentity(taskStore.getTask(task.task_id)), null, "credential revocation prevents durable task recovery from reconstructing authority");
  assert.deepEqual(authorizeRecoveredTask(taskStore.getTask(task.task_id), recoveryDeps), { ok: false, reason: "principal_authority_unavailable" }, "recovery denies execution when the original credential has been revoked");
});

test("recovery requires current project access and preserves only the Certification read-only service", () => {
  const principal = require('./helpers/authorized-identity').createPrincipal(identity, { type: "human", displayName: "Synthetic recovery project principal" });
  const projectTask = createTask({
    task_id: "agt_security_recovery_project01",
    objective: "synthetic scoped recovery",
    project_id: "recovery_project",
    actor_principal_id: principal.principal_id,
    requested_by_principal_id: principal.principal_id,
    principal_context: { credential_scopes: null },
  });
  const roleAuth = { principal_id: principal.principal_id, scopes: null, delegation_id: null };
  const projectDenied = authorizeRecoveredTask(projectTask, {
    resolvePrincipalIdentity: () => roleAuth,
    isPrincipalEnabled: id => Boolean(identity.getPrincipal(id)?.enabled),
    hasProjectTaskAccess: () => false,
  });
  assert.deepEqual(projectDenied, { ok: false, reason: "project_access_revoked" });

  const certificationTask = createTask({
    task_id: "agt_security_recovery_cert01",
    objective: "synthetic certification recovery",
    principal_context: { service_identity: "certification", credential_scopes: [] },
    authority_envelope: { allowed_effects: ["read_only"], changes_allowed: false, external_effects_allowed: false, production_allowed: false, child_task_count: 0 },
  });
  assert.deepEqual(authorizeRecoveredTask(certificationTask, {}), { ok: true, serviceIdentity: "certification" });
  certificationTask.authority_envelope.changes_allowed = true;
  assert.deepEqual(authorizeRecoveredTask(certificationTask, {}), { ok: false, reason: "service_authority_unavailable" }, "Certification recovery rejects a broadened persisted envelope");
});

test.after(() => {
  db.closeDatabase();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (previousDataDir === undefined) delete process.env.SIDEKICK_DATA_DIR;
  else process.env.SIDEKICK_DATA_DIR = previousDataDir;
  if (previousDbFile === undefined) delete process.env.SIDEKICK_DB_FILE;
  else process.env.SIDEKICK_DB_FILE = previousDbFile;
  delete process.env.SIDEKICK_SECRET_KEY_FILE;
});
