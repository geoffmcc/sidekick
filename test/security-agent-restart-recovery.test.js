"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("fresh Agent process parks an orphaned task when its credential was revoked", { timeout: 60_000 }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-agent-restart-auth-"));
  const dbFile = path.join(dataDir, "sidekick-test.db");
  const secretFile = path.join(dataDir, "synthetic-secret");
  const taskId = "agt_security_restart_revoked01";
  const executionId = "exec_security_restart_revoked01";
  fs.writeFileSync(secretFile, "synthetic-restart-test-key");

  const prior = {
    NODE_ENV: process.env.NODE_ENV,
    SIDEKICK_DATA_DIR: process.env.SIDEKICK_DATA_DIR,
    SIDEKICK_DB_FILE: process.env.SIDEKICK_DB_FILE,
    SIDEKICK_SECRET_KEY_FILE: process.env.SIDEKICK_SECRET_KEY_FILE,
  };

  try {
    process.env.NODE_ENV = "test";
    process.env.SIDEKICK_DATA_DIR = dataDir;
    process.env.SIDEKICK_DB_FILE = dbFile;
    process.env.SIDEKICK_SECRET_KEY_FILE = secretFile;
    const db = require("../src/db");
    db.runPendingMigrations();
    assert.equal(path.dirname(db.DB_FILE), dataDir, "seed database must be inside this test's temporary directory");

    const identity = require("../src/core/identity");
    const authentication = require("../src/core/authentication");
    const taskStore = require("../src/agent/task-store");
    const taskModel = require("../src/agent/task-model");
    const kernel = require("../src/platform/kernel");
    const principal = identity.createPrincipal({ type: "human", displayName: "Synthetic restart recovery principal" });
    const credential = authentication.createCredential({
      principalId: principal.principal_id,
      displayName: "Synthetic restart recovery credential",
      scopes: ["agent.tasks.read", "tools.execute"],
    }).credential;

    const task = taskModel.createTask({
      task_id: taskId,
      execution_id: executionId,
      objective: "must remain parked after its credential is revoked",
      actor_principal_id: principal.principal_id,
      requested_by_principal_id: principal.principal_id,
      principal_context: { credential_id: credential.credential_id, credential_scopes: credential.scopes },
      checkpoint: { version: 1, safe_boundary: "before_tool", next_action: "resume_from_checkpoint" },
    });
    taskStore.insertTask(task);
    taskStore.updateTask(taskId, { state: "planning", phase: "execution" });
    taskStore.updateTask(taskId, { state: "ready", phase: "execution" });
    taskStore.updateTask(taskId, { state: "running", phase: "execution" });

    kernel.createExecution({ execution_id: executionId, task_id: taskId, operation_type: "agent_task", tool_name: "agent", actor_id: principal.principal_id });
    kernel.transitionExecution(executionId, "queued", { source: "test", actor_id: principal.principal_id });
    kernel.transitionExecution(executionId, "running", { source: "test", actor_id: principal.principal_id });
    assert.equal(kernel.claimExecution({ execution_id: executionId, claimed_by: "synthetic-crashed-process", lease_ms: 10_000 }).ok, true);
    db.getDb().prepare("UPDATE platform_execution_claims SET lease_expires_at=? WHERE execution_id=?")
      .run(new Date(Date.now() - 1000).toISOString(), executionId);
    assert.equal(authentication.revokeCredential(credential.credential_id), true);
    db.closeDatabase();

    const script = `
      const agent = require('./src/agent');
      const store = require('./src/agent/task-store');
      const db = require('./src/db');
      setTimeout(() => {
        try {
          const task = store.getTask(${JSON.stringify(taskId)});
          const kernel = require('./src/platform/kernel');
          const auth = require('./src/agent/task-identity').persistedTaskAuthIdentity(task);
          const credential = require('./src/core/authentication').getCredential(task?.principal_context?.credential_id);
          const execution = kernel.getExecution(${JSON.stringify(executionId)});
          console.log(JSON.stringify({ state: task?.state, phase: task?.phase, next_action: task?.next_action, last_error_code: task?.last_error_code, task_execution_id: task?.execution_id, auth_identity: auth, credential_revoked: Boolean(credential?.revoked_at), execution: execution?.state, execution_task_id: execution?.task_id, events: store.listEvents(${JSON.stringify(taskId)}).map(event => event.event_type), claim: kernel.getExecutionClaim(${JSON.stringify(executionId)}) }));
          db.closeDatabase();
          process.exit(task?.state === 'blocked' && task?.last_error_code === 'recovery_authorization_denied' ? 0 : 2);
        } catch (error) {
          console.error(error.stack || error);
          try { db.closeDatabase(); } catch {}
          process.exit(3);
        }
      }, 5000);
    `;
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SIDEKICK_DATA_DIR: dataDir,
        SIDEKICK_DB_FILE: dbFile,
        SIDEKICK_SECRET_KEY_FILE: secretFile,
        SIDEKICK_DISABLE_OLLAMA_BOOTSTRAP: "1",
      },
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, `fresh Agent process failed: ${child.stderr}\n${child.stdout}`);
    const lines = child.stdout.trim().split(/\r?\n/);
    const result = JSON.parse(lines.at(-1));
    assert.equal(result.state, "blocked", JSON.stringify(result));
    assert.equal(result.phase, "recovery");
    assert.equal(result.next_action, "reauthorize_task");
    assert.equal(result.last_error_code, "recovery_authorization_denied");
    assert.equal(result.auth_identity, null, "child process must observe credential revocation from durable storage");
    assert.equal(result.credential_revoked, true);
    assert.equal(result.execution, "orphaned");
  } finally {
    try { require("../src/db").closeDatabase(); } catch {}
    process.env.NODE_ENV = prior.NODE_ENV;
    process.env.SIDEKICK_DATA_DIR = prior.SIDEKICK_DATA_DIR;
    process.env.SIDEKICK_DB_FILE = prior.SIDEKICK_DB_FILE;
    process.env.SIDEKICK_SECRET_KEY_FILE = prior.SIDEKICK_SECRET_KEY_FILE;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
