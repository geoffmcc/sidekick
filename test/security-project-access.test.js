const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-project-access-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authorization = require("../src/core/authorization");
const projectAccess = require("../src/core/project-access");
const { canReviewUnownedTask, taskBelongsToIdentity } = require("../src/agent/task-access");
const platformKernel = require("../src/platform/kernel");
const dispatcher = require("../src/tools/dispatcher");
const tools = require("../src/tools");
require("../src/tools");
const handoffTool = require("../src/tools/families/memory-handoff");
const projectRegistryTool = require("../src/tools/families/project-registry");
const storageTools = require("../src/tools/families/storage");
const networkingTools = require("../src/tools/families/networking");
const processManagementTools = require("../src/tools/families/process-mgmt");
const operationsTools = require("../src/tools/families/operations");
const secretTools = require("../src/tools/families/secret");
const toolContext = require("../src/tools/context");
const { registerHandoffReadRoutes } = require("../src/dashboard/handoff-read-routes");
const predictEngine = require("../src/predict");

const owner = identity.bootstrapOwner({ username: "access_owner", password: "a sufficiently long owner password" });
const operator = require('./helpers/authorized-identity').createHumanUser(identity, { username: "access_operator", password: "a sufficiently long operator password" });
identity.assignRole(operator.principal_id, "operator", owner);
const denied = require('./helpers/authorized-identity').createHumanUser(identity, { username: "access_denied", password: "a sufficiently long denied password" });
platformKernel.registerProject({ project_id: "memory_a", owner_actor_id: owner.principal_id });
platformKernel.registerProject({ project_id: "memory_b", owner_actor_id: owner.principal_id });
projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
const memoryA = db.upsertMemory({ type: "fact", project: "memory_a", content: "Project A fact", summary: "Project A fact", confidence: 0.9, source: "test" });
const secretB = db.upsertMemory({ type: "fact", project: "memory_b", content: "Project B private fact", summary: "Project B private fact", confidence: 0.9, source: "test" });

test("Agent cross-principal learning review requires project membership in addition to approvals.grant", () => {
  const reviewer = require('./helpers/authorized-identity').createHumanUser(identity, { username: "scoped_learning_reviewer", password: "a sufficiently long reviewer password" });
  identity.assignRole(reviewer.principal_id, "administrator", owner);
  const task = { task_id: "agt_cross_project_review", project_id: "memory_b", actor_principal_id: denied.principal_id };
  const scopedReviewer = { principal_id: reviewer.principal_id, scopes: ["approvals.grant"] };
  assert.equal(canReviewUnownedTask(scopedReviewer, task), false, "approval permission alone cannot read a source task in an ungranted project");
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: reviewer.principal_id, project: "memory_b", accessLevel: "read" });
  assert.equal(canReviewUnownedTask(scopedReviewer, task), true, "a current read membership plus the scoped approval grant can review the task");
  assert.equal(canReviewUnownedTask({ ...scopedReviewer, scopes: [] }, task), false, "empty credential scopes still deny review");
  const agentSource = fs.readFileSync(path.join(__dirname, "../src/agent.js"), "utf8");
  assert.match(agentSource, /return canReviewUnownedTask\(auth, task\) \? task : null/);
});

test("project grants attenuate access and revoke immediately", () => {
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "read"), true);
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "write"), false);
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_b", "read"), false);
  const task = { actor_principal_id: operator.principal_id, project_id: "memory_a" };
  assert.equal(taskBelongsToIdentity({ principal_id: operator.principal_id, scopes: null }, task), true, "task ownership and current project membership permit reading project-derived task content");
  assert.deepEqual(projectAccess.listAccessibleProjects(operator.principal_id).map(project => project.project_id), ["memory_a"]);
  assert.equal(projectAccess.hasProjectAccess(owner.principal_id, "memory_b", "write"), true, "owners have explicit global management access");
  assert.equal(projectAccess.revokeProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a" }), true);
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "read"), false);
  assert.equal(taskBelongsToIdentity({ principal_id: operator.principal_id, scopes: null }, task), false, "project membership revocation immediately hides the owner's project-scoped task");
  assert.equal(taskBelongsToIdentity({ principal_id: operator.principal_id, scopes: [] }, task), false, "empty credential scopes cannot retain task access");
  const agentSource = fs.readFileSync(path.join(__dirname, "../src/agent.js"), "utf8");
  assert.match(agentSource, /taskProject && authIdentity && !projectAccess\.hasProjectPermission\(authIdentity\.principal_id, taskProject, "agent\.tasks\.read"/);
});

test("principal disablement immediately revokes access to an owned unscoped task", () => {
  const subject = require('./helpers/authorized-identity').createHumanUser(identity, {
    username: "disabled_task_owner",
    password: "a sufficiently long disabled owner password",
  });
  const task = { actor_principal_id: subject.principal_id, project_id: null };
  assert.equal(taskBelongsToIdentity({ principal_id: subject.principal_id, scopes: null }, task), true);

  identity.setPrincipalEnabled(subject.principal_id, false, owner);
  assert.equal(taskBelongsToIdentity({ principal_id: subject.principal_id, scopes: null }, task), false);
});

test("project access changes roll back when their authoritative audit event cannot be written", () => {
  const target = require('./helpers/authorized-identity').createHumanUser(identity, { username: "audit_atomic_target", password: "a sufficiently long target password" });
  platformKernel.registerProject({ project_id: "audit_atomic_project", owner_actor_id: owner.principal_id });
  const connection = db.getDb();

  connection.exec(`CREATE TRIGGER reject_project_grant_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'project.access.granted' AND json_extract(NEW.details_json, '$.project_id') = 'audit_atomic_project'
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
  try {
    assert.throws(() => projectAccess.grantProjectAccess({
      actorPrincipalId: owner.principal_id, principalId: target.principal_id,
      project: "audit_atomic_project", accessLevel: "read",
    }), /synthetic audit failure/);
    assert.equal(projectAccess.hasProjectMembership(target.principal_id, "audit_atomic_project", "read"), false,
      "failed audit must roll back the access grant");
  } finally {
    connection.exec("DROP TRIGGER reject_project_grant_audit");
  }

  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: target.principal_id, project: "audit_atomic_project", accessLevel: "read" });
  connection.exec(`CREATE TRIGGER reject_project_revoke_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'project.access.revoked' AND json_extract(NEW.details_json, '$.project_id') = 'audit_atomic_project'
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
  try {
    assert.throws(() => projectAccess.revokeProjectAccess({
      actorPrincipalId: owner.principal_id, principalId: target.principal_id,
      project: "audit_atomic_project",
    }), /synthetic audit failure/);
    assert.equal(projectAccess.hasProjectMembership(target.principal_id, "audit_atomic_project", "read"), true,
      "failed audit must roll back the access revocation");
  } finally {
    connection.exec("DROP TRIGGER reject_project_revoke_audit");
  }
});

test("role and delegation authority changes roll back when their audit event fails", () => {
  const roleTarget = require('./helpers/authorized-identity').createHumanUser(identity, { username: "audit_role_target", password: "a sufficiently long role password" });
  const connection = db.getDb();
  connection.exec(`CREATE TRIGGER reject_role_grant_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'role.assigned' AND NEW.principal_id = '${roleTarget.principal_id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic role audit failure'); END`);
  try {
    assert.throws(() => identity.assignRole(roleTarget.principal_id, "operator", owner), /synthetic role audit failure/);
    assert.equal(authorization.authorize({ principalId: roleTarget.principal_id, permission: "workflows.execute" }).ok, false,
      "failed role audit must roll back the permission grant");
  } finally {
    connection.exec("DROP TRIGGER reject_role_grant_audit");
  }
  identity.assignRole(roleTarget.principal_id, "operator", owner);
  connection.exec(`CREATE TRIGGER reject_role_revoke_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'role.removed' AND NEW.principal_id = '${roleTarget.principal_id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic role audit failure'); END`);
  try {
    assert.throws(() => identity.removeRole(roleTarget.principal_id, "operator", owner), /synthetic role audit failure/);
    assert.equal(authorization.authorize({ principalId: roleTarget.principal_id, permission: "workflows.execute" }).ok, true,
      "failed role audit must roll back permission revocation");
  } finally {
    connection.exec("DROP TRIGGER reject_role_revoke_audit");
  }

  const delegate = require('./helpers/authorized-identity').createPrincipal(identity, { type: "agent", displayName: "Audit delegation target", actorPrincipalId: owner.principal_id });
  connection.exec(`CREATE TRIGGER reject_delegation_grant_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'delegation.created' AND NEW.principal_id = '${delegate.principal_id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic delegation audit failure'); END`);
  try {
    assert.throws(() => authorization.createDelegation({ delegatorPrincipalId: owner.principal_id, delegatePrincipalId: delegate.principal_id, permissions: ["memory.read"], actorContext: owner }), /synthetic delegation audit failure/);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM identity_delegations WHERE delegate_principal_id = ?").get(delegate.principal_id).count, 0,
      "failed delegation audit must roll back delegated authority");
  } finally {
    connection.exec("DROP TRIGGER reject_delegation_grant_audit");
  }
  const delegation = authorization.createDelegation({ delegatorPrincipalId: owner.principal_id, delegatePrincipalId: delegate.principal_id, permissions: ["memory.read"], actorContext: owner });
  connection.exec(`CREATE TRIGGER reject_delegation_revoke_audit BEFORE INSERT ON identity_audit_events
    WHEN NEW.event_type = 'delegation.revoked' AND json_extract(NEW.details_json, '$.delegation_id') = '${delegation.delegation_id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic delegation audit failure'); END`);
  try {
    assert.throws(() => authorization.revokeDelegation(delegation.delegation_id, owner), /synthetic delegation audit failure/);
    assert.equal(authorization.getDelegation(delegation.delegation_id).revoked_at, null,
      "failed revocation audit must roll back delegation revocation");
  } finally {
    connection.exec("DROP TRIGGER reject_delegation_revoke_audit");
  }
});

test("KV reads cannot escape the current project membership", async () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
  const namespacedKey = `__sidekick_principal_v1:${encodeURIComponent(operator.principal_id)}:${encodeURIComponent("memory_b")}:kv-private`;
  db.setKV(namespacedKey, "synthetic private value", "memory_b", "test");
  const context = toolContext.createMcpExecutionContext({
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
    project: "memory_a",
  });
  const results = await Promise.all([
    dispatcher.dispatchTool({ name: "get", args: { key: "kv-private", project: "memory_b" }, context }),
    dispatcher.dispatchTool({ name: "get_by_project", args: { project: "memory_b" }, context }),
  ]);
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.code, "project_scope_denied");
    assert.doesNotMatch(result.content[0].text, /synthetic private value/);
  }
});

test("global project grants are required to manage memberships", () => {
  assert.throws(() => projectAccess.grantProjectAccess({ actorPrincipalId: operator.principal_id, principalId: denied.principal_id, project: "memory_a", accessLevel: "read" }), /projects.access.manage/);
});

test("explicit credential scopes attenuate global project management", () => {
  assert.equal(projectAccess.hasGlobalProjectAccess(owner.principal_id, []), false);
  assert.equal(projectAccess.hasGlobalProjectAccess(owner.principal_id, [projectAccess.MANAGE_PERMISSION]), true);
  assert.throws(() => projectAccess.grantProjectAccess({
    actorPrincipalId: owner.principal_id, credentialScopes: [], principalId: denied.principal_id,
    project: "memory_a", accessLevel: "read",
  }), /projects.access.manage/);
});

test("project membership does not replace the memory read/write permission", () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "write" });
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "read", ["tools.execute"]), false);
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "read", ["memory.read"]), true);
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "write", ["memory.read"]), false);
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "write", ["memory.write"]), true);
});

test("project resource permissions compose with membership and credential scopes", () => {
  assert.equal(projectAccess.hasProjectPermission(operator.principal_id, "memory_a", "predictions.read", "read"), true);
  assert.equal(projectAccess.hasProjectPermission(operator.principal_id, "memory_b", "predictions.read", "read"), false);
  assert.equal(projectAccess.hasProjectPermission(operator.principal_id, "memory_a", "predictions.read", "read", []), false);
  assert.deepEqual(projectAccess.listAccessibleProjectsForPermission(operator.principal_id, "predictions.read").map(project => project.project_id), ["memory_a"]);
  assert.deepEqual(projectAccess.listAccessibleProjectsForPermission(operator.principal_id, "predictions.read", []).map(project => project.project_id), []);
});

test("memory project helpers preserve delegated authority attenuation and recheck revocation", () => {
  const authorization = require("../src/core/authorization");
  const delegation = authorization.createDelegation({
    delegatorPrincipalId: owner.principal_id,
    delegatePrincipalId: operator.principal_id,
    permissions: ["predictions.read"],
    actorContext: owner,
  });
  const delegatedIdentity = {
    principal_id: operator.principal_id,
    principal_type: "human",
    scopes: null,
    delegation_id: delegation.delegation_id,
  };
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "read", null, delegation.delegation_id), false,
    "the operator role's memory.read grant cannot exceed the active narrower delegation");
  const delegatedContext = toolContext.createMcpExecutionContext({ authIdentity: delegatedIdentity, project: "memory_a" });
  assert.throws(() => toolContext.runWithContext(delegatedContext, () => require("../src/tools/families/memory-scope").scopedProject("memory_a")), /scope denied/);

  authorization.revokeDelegation(delegation.delegation_id, owner);
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "read", null, delegation.delegation_id), false,
    "revocation remains effective in direct project-access helper calls");
});

test("session begin and continuation require current project memory permissions", async () => {
  const unauthenticated = await dispatcher.callMcpTool("session", { action: "list", project: "memory_a" });
  assert.equal(unauthenticated.isError, true);
  assert.equal(unauthenticated.code, "unauthenticated", "low-risk session classification cannot expose identityless session reads");

  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "write" });
  const auth = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" } };
  const beforeForeign = db.listTaskSessions({ project: "memory_b", limit: 100 }).length;
  const foreign = await dispatcher.callAgentTool("session", { action: "begin", goal: "cross-project session must not read or write memory", project: "memory_b" }, auth);
  assert.equal(foreign.isError, true);
  assert.equal(foreign.code, "project_access_denied");
  assert.equal(db.listTaskSessions({ project: "memory_b", limit: 100 }).length, beforeForeign, "denial occurs before session persistence");

  const allowed = await dispatcher.callAgentTool("session", { action: "begin", goal: "authorized scoped session", project: "memory_a" }, auth);
  assert.equal(allowed.isError, undefined);
  const session = JSON.parse(allowed.content[0].text).session;
  const narrowlyScopedBegin = await dispatcher.callMcpTool("session", { action: "begin", goal: "least-privilege scoped session", project: "memory_a" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human", scopes: ["memory.read", "memory.write"] },
  });
  assert.equal(narrowlyScopedBegin.isError, undefined, "memory-scoped credentials can create continuity without the broad tools.execute grant");
  const readOnlyBegin = await dispatcher.callAgentTool("session", { action: "begin", goal: "read-only credential must not write", project: "memory_a" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human", scopes: ["memory.read"] },
  });
  assert.equal(readOnlyBegin.code, "authorization_denied", "read-only memory credentials cannot begin a session");
  const narrowlyScopedStatus = await dispatcher.callMcpTool("session", { action: "status", id: session.id }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human", scopes: ["memory.read"] },
  });
  assert.equal(narrowlyScopedStatus.isError, undefined, "read-only memory credentials can read an owned session");
  const before = db.getTaskSession(session.id);
  projectAccess.revokeProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a" });
  const checkpoint = await dispatcher.callAgentTool("session", { action: "checkpoint", id: session.id, current_plan: "should not persist" }, auth);
  assert.equal(checkpoint.isError, true);
  assert.equal(checkpoint.content[0].text, `Task session not found: ${session.id}`);
  assert.equal(db.getTaskSession(session.id).updated_at, before.updated_at, "revoked project access prevents session and linked-handoff writes");
});

test("filesystem directory and content reads reject identityless callers before accessing paths", async () => {
  const unauthenticated = await dispatcher.callMcpTool("list", { path: dataDir });
  assert.equal(unauthenticated.isError, true);
  assert.equal(unauthenticated.code, "unauthenticated");

  const direct = await require("../src/tools/families/filesystem").sidekick_list({ path: dataDir });
  assert.equal(direct.isError, true);
  assert.equal(direct.code, "unauthenticated", "direct family calls must enforce identity too");

  const family = require("../src/tools/families/filesystem");
  const canary = path.join(dataDir, "filesystem-direct-read-canary.txt");
  fs.writeFileSync(canary, "synthetic filesystem canary", "utf8");
  for (const [handler, args] of [
    [family.sidekick_read, { path: canary }],
    [family.sidekick_find, { path: dataDir, name: "filesystem-direct-read-canary.txt" }],
  ]) {
    const result = await handler(args);
    assert.equal(result.isError, true);
    assert.equal(result.code, "unauthenticated", "direct filesystem content reads must require identity");
    assert.doesNotMatch(JSON.stringify(result), /synthetic filesystem canary/, "denial must precede filesystem content access");
  }

  const writeTarget = path.join(dataDir, "filesystem-direct-write-canary.txt");
  const write = await family.sidekick_write({ path: writeTarget, content: "must not write" });
  assert.equal(write.isError, true);
  assert.equal(write.code, "unauthenticated", "direct filesystem writes must require identity and critical execution permission");
  assert.equal(fs.existsSync(writeTarget), false, "denial must precede filesystem mutation");

  const insufficient = await toolContext.runWithContext({
    source: "mcp",
    authIdentity: { principal_id: denied.principal_id, scopes: ["tools.execute"] },
  }, () => family.sidekick_write({ path: writeTarget, content: "must still not write" }));
  assert.equal(insufficient.isError, true);
  assert.equal(insufficient.code, "forbidden", "ordinary execution scope cannot authorize a critical direct handler");
  assert.equal(fs.existsSync(writeTarget), false, "insufficient authority must be rejected before mutation");

  const priorAllowedPaths = process.env.SIDEKICK_MCP_ALLOWED_PATHS;
  process.env.SIDEKICK_MCP_ALLOWED_PATHS = dataDir;
  try {
    fs.writeFileSync(writeTarget, "old content", { mode: 0o640 });
    const authorizedWrite = await dispatcher.callMcpTool("write", { path: writeTarget, content: "complete replacement" }, {
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    });
    assert.equal(authorizedWrite.isError, undefined, "authorized writes remain available");
    assert.equal(fs.readFileSync(writeTarget, "utf8"), "complete replacement", "the target is atomically replaced with complete content");
    if (process.platform !== "win32") assert.equal(fs.statSync(writeTarget).mode & 0o777, 0o640, "replacement preserves the existing mode");

    const symlinkTarget = path.join(dataDir, "filesystem-write-symlink-target.txt");
    const symlink = path.join(dataDir, "filesystem-write-symlink.txt");
    fs.writeFileSync(symlinkTarget, "target must remain unchanged");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(symlinkTarget, symlink, "file");
      symlinkCreated = true;
    } catch (error) {
      if (!/[Pp]ermission|privilege|not supported/i.test(String(error && error.message))) throw error;
    }
    if (symlinkCreated) {
      const symlinkWrite = await dispatcher.callMcpTool("write", { path: symlink, content: "must not follow link" }, {
        authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
      });
      assert.equal(symlinkWrite.code, "invalid_path");
      assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "target must remain unchanged");
      const symlinkRead = await dispatcher.callMcpTool("read", { path: symlink }, {
        authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
      });
      assert.equal(symlinkRead.isError, true, "filesystem reads reject even allowed-root symlinks at the file-open boundary");
      assert.doesNotMatch(JSON.stringify(symlinkRead), /target must remain unchanged/, "a path swap cannot expose the linked file contents");
    }
  } finally {
    if (priorAllowedPaths === undefined) delete process.env.SIDEKICK_MCP_ALLOWED_PATHS;
    else process.env.SIDEKICK_MCP_ALLOWED_PATHS = priorAllowedPaths;
  }
});

test("database metadata, host scanning, and file hashing reject identityless callers", async () => {
  for (const [name, args] of [
    ["db_schema", {}],
    ["db_stats", {}],
    ["security_scan", { path: dataDir, max_files: 1 }],
    ["insight_report", { paths: [dataDir] }],
    ["hash", { path: path.join(dataDir, "synthetic-missing-file") }],
  ]) {
    const result = await dispatcher.callMcpTool(name, args);
    assert.equal(result.isError, true, `${name} must deny before reading internal state`);
    assert.equal(result.code, "unauthenticated", `${name} must identify missing caller identity`);
  }

  const directChecks = [
    ["../src/tools/families/database-inspection", "sidekick_db_schema", {}],
    ["../src/tools/families/database-inspection", "sidekick_db_stats", {}],
    ["../src/tools/families/security", "sidekick_security_scan", { path: dataDir, max_files: 1 }],
    ["../src/tools/families/media", "sidekick_insight_report", { paths: [dataDir] }],
    ["../src/tools/families/hashing", "sidekick_hash", { path: path.join(dataDir, "synthetic-missing-file") }],
  ];
  for (const [familyPath, handlerName, args] of directChecks) {
    const result = await require(familyPath)[handlerName](args);
    assert.equal(result.isError, true, `${handlerName} direct invocation must deny without identity`);
    assert.equal(result.code, "unauthenticated", `${handlerName} direct invocation must fail closed`);
  }

  const pureHash = await dispatcher.callMcpTool("hash", { input: "caller supplied text" });
  assert.equal(pureHash.isError, undefined, "pure text hashing does not read ambient filesystem state");
});

test("direct Git handler calls require canonical dispatch even for an authorized Owner", async () => {
  const development = require("../src/tools/families/development");
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  const result = await toolContext.runWithContext(context, () => development.sidekick_git({
    action: "push",
    path: dataDir,
  }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required", "direct Git mutation must fail before invoking Git");
});

test("changelog refs are resolved past Git option parsing and saves reject symlinks", () => {
  const development = require("../src/tools/families/development");
  const descriptor = development.descriptors.find(item => item.name === "changelog");
  assert.equal(descriptor.schema.safeParse({ action: "preview", from: "HEAD" }).success, true);
  assert.equal(descriptor.schema.safeParse({ action: "preview", from: "x".repeat(development.MAX_CHANGELOG_REVISION_LENGTH + 1) }).success, false);
  assert.match(development.resolveChangelogRevision(process.cwd(), "HEAD"), /^[0-9a-f]{40,64}$/i);

  let revParseArgs = null;
  const fakeHash = "a".repeat(40);
  const resolved = development.resolveChangelogRevision(process.cwd(), "--output=/tmp/untrusted-log-output", (_program, args) => {
    revParseArgs = args;
    return fakeHash;
  });
  assert.equal(resolved, fakeHash);
  assert.ok(revParseArgs.includes("--end-of-options"), "untrusted refs are parsed as revision data after the option boundary");

  const outputPath = path.join(dataDir, "CHANGELOG.md");
  const linkedTargetPath = path.join(dataDir, "changelog-target.md");
  const regularPath = path.join(dataDir, "ordinary-CHANGELOG.md");
  fs.writeFileSync(linkedTargetPath, "keep changelog target unchanged");
  fs.symlinkSync(linkedTargetPath, outputPath);
  const priorAllowedPaths = process.env.SIDEKICK_MCP_ALLOWED_PATHS;
  process.env.SIDEKICK_MCP_ALLOWED_PATHS = dataDir;
  try {
    development.writeChangelogFile(regularPath, "authorized changelog");
    assert.equal(fs.readFileSync(regularPath, "utf8"), "authorized changelog", "ordinary authorized changelog writes remain supported");
    assert.throws(() => development.readChangelogFile(outputPath), /symlink/);
    assert.throws(() => development.writeChangelogFile(outputPath, "untrusted replacement"), /symlink/);
    assert.equal(fs.readFileSync(linkedTargetPath, "utf8"), "keep changelog target unchanged");
  } finally {
    if (priorAllowedPaths === undefined) delete process.env.SIDEKICK_MCP_ALLOWED_PATHS;
    else process.env.SIDEKICK_MCP_ALLOWED_PATHS = priorAllowedPaths;
  }
});

test("direct dependency inspection requires canonical dispatch before process inspection", async () => {
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  const result = await toolContext.runWithContext(context, () => require("../src/tools/families/development").sidekick_depend({ action: "tree", type: "process", target: "1" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("dependency inspection scopes npm project paths and strips credentials from child processes", async () => {
  const development = require("../src/tools/families/development");
  const descriptor = development.descriptors.find(item => item.name === "depend");
  assert.equal(descriptor.schema.safeParse({ action: "tree", type: "npm", depth: -1 }).success, false);
  assert.equal(descriptor.schema.safeParse({ action: "tree", type: "npm", depth: 11 }).success, false);
  assert.equal(descriptor.schema.safeParse({ action: "tree", type: "npm", target: "x".repeat(4097) }).success, false);
  const priorAllowedPaths = process.env.SIDEKICK_MCP_ALLOWED_PATHS;
  const priorDeniedPaths = process.env.SIDEKICK_MCP_DENIED_PATHS;
  const priorSecret = process.env.SIDEKICK_TEST_DEPENDENCY_SECRET;
  process.env.SIDEKICK_MCP_ALLOWED_PATHS = dataDir;
  const blockedProjectPath = path.join(dataDir, "blocked-dependency-project");
  process.env.SIDEKICK_MCP_DENIED_PATHS = blockedProjectPath;
  process.env.SIDEKICK_TEST_DEPENDENCY_SECRET = "synthetic-dependency-secret";
  try {
    const projectPath = path.join(dataDir, "dependency-project");
    fs.mkdirSync(projectPath, { recursive: true });
    const resolved = toolContext.runWithContext({ source: "mcp" }, () => development.resolveNpmProjectDirectory(projectPath));
    assert.equal(resolved, fs.realpathSync(projectPath));

    let captured = null;
    const output = development.runDependencyCommand("npm", ["ls"], { cwd: resolved }, (program, args, options) => {
      captured = { program, args, options };
      return "ok";
    });
    assert.equal(output, "ok");
    assert.equal(captured.program, "npm");
    assert.equal(captured.options.env.SIDEKICK_TEST_DEPENDENCY_SECRET, undefined);
    assert.equal(captured.options.env.SIDEKICK_SECRET_KEY, undefined);

    const outside = await dispatcher.callMcpTool("depend", { action: "tree", type: "npm", target: blockedProjectPath }, {
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    });
    assert.equal(outside.isError, true, "npm cannot inspect a project outside the configured path scope");
    assert.match(outside.content[0].text, /outside the configured read scope/);
  } finally {
    if (priorAllowedPaths === undefined) delete process.env.SIDEKICK_MCP_ALLOWED_PATHS;
    else process.env.SIDEKICK_MCP_ALLOWED_PATHS = priorAllowedPaths;
    if (priorDeniedPaths === undefined) delete process.env.SIDEKICK_MCP_DENIED_PATHS;
    else process.env.SIDEKICK_MCP_DENIED_PATHS = priorDeniedPaths;
    if (priorSecret === undefined) delete process.env.SIDEKICK_TEST_DEPENDENCY_SECRET;
    else process.env.SIDEKICK_TEST_DEPENDENCY_SECRET = priorSecret;
  }
});

test("direct runbook creation requires canonical dispatch before persistence", async () => {
  const runbook = require("../src/tools/families/runbook");
  const runbookPath = path.join(dataDir, "runbooks.json");
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  const result = await toolContext.runWithContext(context, () => runbook.sidekick_runbook({
    action: "create",
    name: "direct-handler-canary",
    steps: [{ name: "canary", command: "echo must not run" }],
  }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
  assert.equal(fs.existsSync(runbookPath), false, "direct call must not persist the runbook definition");
});

test("direct high-impact control and recovery handlers require canonical dispatch", async () => {
  const calls = [
    ["memory maintenance", () => require("../src/tools/families/memory-maintenance").sidekick_memory_maintenance({ action: "apply", project: "memory_a", run_id: "missing" })],
    ["generated-tool lifecycle", () => require("../src/tools/families/evolve").sidekick_evolve({ action: "cleanup", confirm: true })],
    ["network-scope mutation", () => require("../src/tools/families/network-scopes").sidekick_network_scopes({ action: "create", name: "direct-call-canary", policy: {} })],
    ["mission execution", () => require("../src/tools/families/operations").sidekick_mission({ action: "execute", intent: "delete key", key: "direct-call-canary", confirm: true })],
    ["workflow execution", () => require("../src/tools/families/workflow-definitions").sidekick_workflow({ action: "run", name: "developer/repository-recon" })],
  ];
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  for (const [label, invoke] of calls) {
    const result = await toolContext.runWithContext(context, invoke);
    assert.equal(result.isError, true, `${label} direct invocation must fail closed`);
    assert.equal(result.code, "canonical_dispatch_required", `${label} must require canonical dispatch before effects`);
  }
});

test("direct browser, module, project, and workspace handlers require canonical dispatch", async () => {
  const calls = [
    ["browser interaction", () => require("../src/tools/families/browser").sidekick_browser({ action: "click", session: "synthetic" })],
    ["module activation", () => require("../src/tools/families/module-management").sidekick_module({ action: "enable", name: "synthetic" })],
    ["project registration", () => projectRegistryTool.sidekick_project_registry({ action: "register", project: "direct-call-canary" })],
    ["workspace deletion", () => require("../src/tools/families/workspace").sidekick_workspace({ action: "delete", workspace_id: "synthetic" })],
  ];
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  for (const [label, invoke] of calls) {
    const result = await toolContext.runWithContext(context, invoke);
    assert.equal(result.isError, true, `${label} direct invocation must fail closed`);
    assert.equal(result.code, "canonical_dispatch_required", `${label} must require canonical dispatch before effects`);
  }
});

test("direct scheduled execution handlers require canonical dispatch before persistence", async () => {
  const scheduling = require("../src/tools/families/scheduling");
  const calls = [
    ["cron creation", () => scheduling.sidekick_cron({ action: "add", name: "direct-call-canary", schedule: "* * * * *", command: "echo must-not-run" })],
    ["delay creation", () => scheduling.sidekick_delay({ action: "add", when: "1h", tool: "bash", args: { command: "echo must-not-run" } })],
    ["watch creation", () => scheduling.sidekick_watch({ action: "add", name: "direct-call-canary", source: "service", target: "synthetic", condition: "stopped", interval: 60, action_tool: "bash", action_args: { command: "echo must-not-run" } })],
  ];
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  for (const [label, invoke] of calls) {
    const result = await toolContext.runWithContext(context, invoke);
    assert.equal(result.isError, true, `${label} direct invocation must fail closed`);
    assert.equal(result.code, "canonical_dispatch_required", `${label} must require canonical dispatch before effects`);
  }
});

test("direct notification handlers require canonical dispatch before outbound effects", async () => {
  const comms = require("../src/tools/families/comms");
  const result = await toolContext.runWithContext(
    toolContext.createAgentExecutionContext({
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    }),
    () => comms.sidekick_notify({ channel: "discord", webhook_url: "https://example.invalid/hook", message: "must not send" }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("direct queue, orchestration, retry, batch, and circuit handlers require canonical dispatch", async () => {
  const flowControl = require("../src/tools/families/flow-control");
  const calls = [
    ["queued task creation", () => flowControl.sidekick_queue({ action: "add", tool: "bash", args: { command: "echo must-not-run" } })],
    ["orchestration creation", () => flowControl.sidekick_orchestrate({ action: "create", task_name: "direct-call-canary", subtasks: [{ name: "canary", tool: "bash", args: { command: "echo must-not-run" } }] })],
    ["retry execution", () => flowControl.sidekick_retry({ tool: "bash", args: { command: "echo must-not-run" }, max_attempts: 1 })],
    ["batch execution", () => flowControl.sidekick_batch({ calls: [{ tool: "bash", args: { command: "echo must-not-run" } }] })],
    ["circuit state access", () => flowControl.sidekick_circuit({ action: "reset", target: "direct-call-canary" })],
  ];
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  for (const [label, invoke] of calls) {
    const result = await toolContext.runWithContext(context, invoke);
    assert.equal(result.isError, true, `${label} direct invocation must fail closed`);
    assert.equal(result.code, "canonical_dispatch_required", `${label} must require canonical dispatch before effects`);
  }
});

test("direct model administration and learned-procedure handlers require canonical dispatch", async () => {
  const calls = [
    ["Ollama model administration", () => require("../src/tools/families/inference").sidekick_ollama({ action: "pull", model: "synthetic-canary" })],
    ["learned procedure creation", () => require("../src/tools/families/teach").sidekick_teach({ action: "teach_procedure", name: "direct-call-canary", description: "synthetic", steps: [{ tool: "bash", args: { command: "echo must-not-run" } }] })],
  ];
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  for (const [label, invoke] of calls) {
    const result = await toolContext.runWithContext(context, invoke);
    assert.equal(result.isError, true, `${label} direct invocation must fail closed`);
    assert.equal(result.code, "canonical_dispatch_required", `${label} must require canonical dispatch before effects`);
  }
});

test("direct GitHub API handler requires canonical dispatch before credential resolution", async () => {
  const result = await toolContext.runWithContext(
    toolContext.createAgentExecutionContext({
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    }),
    () => require("../src/tools/families/github").sidekick_github({ action: "create_issue", repo: "owner/repo", args: "{}" }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("direct GitHub CI status handler requires canonical dispatch", async () => {
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  const result = await toolContext.runWithContext(context, () => require("../src/tools/families/github").sidekick_ci_status({ repo: "owner/repo" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("direct task session handler requires canonical dispatch before persistence", async () => {
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    project: "memory_a",
  });
  const result = await toolContext.runWithContext(context, () => require("../src/tools/families/memory-session").sidekick_session({ action: "begin", goal: "must not persist directly", project: "memory_a" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("direct low-risk project, resume, and embedding handlers require canonical dispatch", async () => {
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    project: "memory_a",
  });
  const calls = [
    ["project context", () => require("../src/tools/families/context").sidekick_project({ name: "memory_a", include: "kv" })],
    ["resume context", () => require("../src/tools/families/resume").sidekick_resume({ action: "check", project: "memory_a" })],
    ["embedding submission", () => require("../src/tools/families/inference").sidekick_embed({ text: "synthetic direct-call canary" })],
  ];
  for (const [label, invoke] of calls) {
    const result = await toolContext.runWithContext(context, invoke);
    assert.equal(result.isError, true, `${label} direct invocation must fail closed`);
    assert.equal(result.code, "canonical_dispatch_required", `${label} must require dispatch before reading or submitting data`);
  }
});

test("direct infrastructure diagnostic and metrics handlers require canonical dispatch", async () => {
  const observability = require("../src/tools/families/observability");
  const calls = [
    ["health diagnostics", () => observability.sidekick_health({ check: "services" })],
    ["network diagnostics", () => observability.sidekick_netdiag({ action: "listeners" })],
    ["metrics access", () => observability.sidekick_metrics({ action: "query", query: "from(bucket: \"sidekick\")" })],
  ];
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  for (const [label, invoke] of calls) {
    const result = await toolContext.runWithContext(context, invoke);
    assert.equal(result.isError, true, `${label} direct invocation must fail closed`);
    assert.equal(result.code, "canonical_dispatch_required", `${label} must require canonical dispatch before effects`);
  }
});

test("direct host status handler requires canonical dispatch", async () => {
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  const result = await toolContext.runWithContext(context, () => require("../src/tools/families/observability").sidekick_status({ include: "services" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
  const governed = await dispatcher.callAgentTool("status", { include: "uptime" }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.notEqual(governed.isError, true, "canonical host status read remains available to the authorized caller");
});

test("direct Black Box handler requires canonical dispatch before incident access", async () => {
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  const result = await toolContext.runWithContext(context, () => require("../src/tools/families/black-box").sidekick_black_box({ action: "list_incidents" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
  const governed = await dispatcher.callAgentTool("black_box", { action: "list_incidents" }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.notEqual(governed.isError, true, "canonical incident listing remains available to the authorized caller");
});

test("direct Predict handler requires canonical dispatch before prediction access", async () => {
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  const result = await toolContext.runWithContext(context, () => require("../src/tools/families/meta").sidekick_predict({ action: "list" }));
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("direct Compute provider administration requires canonical dispatch", async () => {
  const result = await toolContext.runWithContext(
    toolContext.createAgentExecutionContext({
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    }),
    () => require("../src/compute/tools").sidekick_compute_providers({ action: "create", name: "direct-call-canary", type: "ollama" }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("direct Compute worker, model, job, and routing handlers reject an authorized Owner before effects", async () => {
  const computeTools = require("../src/compute/tools");
  const db = require("../src/db");
  const context = toolContext.createAgentExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  const beforeTokens = db.getDb().prepare("SELECT COUNT(*) AS count FROM compute_enrollment_tokens").get().count;
  const beforeRules = db.getDb().prepare("SELECT COUNT(*) AS count FROM compute_routing_rules").get().count;
  const results = await toolContext.runWithContext(context, async () => Promise.all([
    computeTools.sidekick_compute({ action: "overview" }),
    computeTools.sidekick_compute_nodes({ action: "create_token", display_name: "direct-call-canary" }),
    computeTools.sidekick_compute_models({ action: "list" }),
    computeTools.sidekick_compute_jobs({ action: "recover" }),
    computeTools.sidekick_compute_route({ action: "create_rule", name: "direct-call-canary" }),
  ]));
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.code, "canonical_dispatch_required");
  }
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS count FROM compute_enrollment_tokens").get().count, beforeTokens);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS count FROM compute_routing_rules").get().count, beforeRules);
});

test("direct memory lifecycle, portability, and sync handlers require canonical dispatch", async () => {
  const memoryCore = require("../src/tools/families/memory-core");
  const memoryLifecycle = require("../src/tools/families/memory-lifecycle");
  const memoryPortability = require("../src/tools/families/memory-portability");
  const memorySync = require("../src/tools/families/memory-sync");
  const beforeMemories = db.getDb().prepare("SELECT COUNT(*) AS count FROM memories").get().count;
  const beforeUserId = db.getUserId();
  const context = toolContext.createAgentExecutionContext({ authIdentity: { principal_id: owner.principal_id, principal_type: "human" } });
  const calls = [
    () => memoryCore.sidekick_memory({ action: "remember", project: "memory_a", content: "direct memory canary" }),
    () => memoryLifecycle.sidekick_memory_manage({ action: "process_auto_expirations", project: "memory_a" }),
    () => memoryPortability.sidekick_memory_export({ project: "memory_a" }),
    () => memoryPortability.sidekick_memory_import({ project: "memory_a", data: { memories: [] } }),
    () => memorySync.sidekick_sync_identity({ action: "set_user", user_id: "direct-call-canary" }),
    () => memorySync.sidekick_sync_export({ project: "memory_a" }),
    () => memorySync.sidekick_sync_import({ project: "memory_a", data: { memories: [] } }),
    () => memorySync.sidekick_sync_diff({ project: "memory_a", since: new Date(0).toISOString() }),
  ];
  const results = await toolContext.runWithContext(context, () => Promise.all(calls.map(invoke => invoke())));
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.code, "canonical_dispatch_required");
  }
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS count FROM memories").get().count, beforeMemories);
  assert.equal(db.getUserId(), beforeUserId);
});

test("direct context and connector handlers require canonical dispatch", async () => {
  const contextTool = require("../src/tools/families/context");
  const connectorTool = require("../src/tools/families/connectors");
  const context = toolContext.createAgentExecutionContext({ authIdentity: { principal_id: owner.principal_id, principal_type: "human" }, project: "memory_a" });
  const results = await toolContext.runWithContext(context, () => Promise.all([
    contextTool.sidekick_context({ action: "recall", query: "private context", project: "memory_a" }),
    connectorTool.sidekick_connector({ action: "health", connector_id: "direct-call-canary" }),
  ]));
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.code, "canonical_dispatch_required");
  }
});

test("direct inference and LLM-backed handlers require canonical dispatch", async () => {
  const inference = require("../src/tools/families/inference");
  const development = require("../src/tools/families/development");
  const meta = require("../src/tools/families/meta");
  const context = toolContext.createAgentExecutionContext({ authIdentity: { principal_id: owner.principal_id, principal_type: "human" }, project: "memory_a" });
  const calls = [
    () => inference.sidekick_llm({ prompt: "synthetic direct-call canary" }),
    () => development.sidekick_changelog({ from: "HEAD", use_llm: true }),
    () => meta.sidekick_fresheyes({ problem: "synthetic direct-call canary" }),
  ];
  const results = await toolContext.runWithContext(context, () => Promise.all(calls.map(invoke => invoke())));
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.code, "canonical_dispatch_required");
  }
});

test("direct media and analytics handlers require canonical dispatch", async () => {
  const media = require("../src/tools/families/media");
  const context = toolContext.createAgentExecutionContext({ authIdentity: { principal_id: owner.principal_id, principal_type: "human" }, project: "memory_a" });
  const calls = [
    () => media.sidekick_ocr({ path: "synthetic-image.png" }),
    () => media.sidekick_media({ action: "info", input: "synthetic-media.mp4" }),
    () => media.sidekick_transcribe({ action: "cancel", job_id: "synthetic-job" }),
    () => media.sidekick_analytics({ query: "synthetic analysis" }),
  ];
  const results = await toolContext.runWithContext(context, () => Promise.all(calls.map(invoke => invoke())));
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.code, "canonical_dispatch_required");
  }
});

test("DuckDB analytics disables external access before caller SQL and bounds file input", async () => {
  const media = require("../src/tools/families/media");
  const attackerQuery = "SELECT 1; SET enable_external_access=true";
  const script = media.buildAnalyticsScript({ file: "private-input.csv", format: "csv", query: attackerQuery });
  const loadIndex = script.indexOf("CREATE TABLE data");
  const externalAccessIndex = script.indexOf('SET enable_external_access=false');
  const lockIndex = script.indexOf('SET lock_configuration=true');
  const callerQueryIndex = script.indexOf("cursor = con.execute(params[\"query\"])");
  assert.ok(loadIndex >= 0 && loadIndex < externalAccessIndex, "only the explicitly selected file is loaded before external access is disabled");
  assert.ok(externalAccessIndex < lockIndex && lockIndex < callerQueryIndex, "the external-access denial is locked before caller SQL runs");
  assert.equal(script.includes(attackerQuery), false, "untrusted SQL is carried as base64 data, not embedded as Python source");

  const descriptor = media.descriptors.find(item => item.name === "analytics");
  assert.equal(descriptor.schema.safeParse({ query: "x".repeat(media.MAX_ANALYTICS_QUERY_CHARS + 1) }).success, false);
  assert.equal(descriptor.schema.safeParse({ query: "SELECT 1", format: "remote" }).success, false);

  const sourcePath = path.join(dataDir, "analytics-source.csv");
  const copiedPath = path.join(dataDir, "analytics-copy.csv");
  fs.writeFileSync(sourcePath, "value\n1\n");
  const priorAllowedPaths = process.env.SIDEKICK_MCP_ALLOWED_PATHS;
  process.env.SIDEKICK_MCP_ALLOWED_PATHS = dataDir;
  try {
    toolContext.runWithContext({ source: "mcp" }, () => media.copyAnalyticsInput(sourcePath, copiedPath));
    assert.equal(fs.readFileSync(copiedPath, "utf8"), "value\n1\n");

    const linkedInputPath = path.join(dataDir, "analytics-linked-input.csv");
    try { fs.symlinkSync(sourcePath, linkedInputPath, "file"); }
    catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    }
    if (fs.existsSync(linkedInputPath)) {
      const linkedCopyPath = path.join(dataDir, "analytics-linked-copy.csv");
      toolContext.runWithContext({ source: "mcp" }, () => media.copyAnalyticsInput(linkedInputPath, linkedCopyPath));
      assert.equal(fs.readFileSync(linkedCopyPath, "utf8"), "value\n1\n", "in-scope symlinks keep their supported behavior");
    }

    const oversizedPath = path.join(dataDir, "analytics-oversized.csv");
    fs.closeSync(fs.openSync(oversizedPath, "w"));
    fs.truncateSync(oversizedPath, media.MAX_ANALYTICS_FILE_BYTES + 1);
    const oversizedCopyPath = path.join(dataDir, "analytics-oversized-copy.csv");
    assert.throws(() => toolContext.runWithContext({ source: "mcp" }, () => media.copyAnalyticsInput(oversizedPath, oversizedCopyPath)), /exceeds/);
  } finally {
    if (priorAllowedPaths === undefined) delete process.env.SIDEKICK_MCP_ALLOWED_PATHS;
    else process.env.SIDEKICK_MCP_ALLOWED_PATHS = priorAllowedPaths;
  }
});

test("media tools reject protocol URLs and resolve only scoped regular file paths", async () => {
  const media = require("../src/tools/families/media");
  for (const url of ["http://127.0.0.1/latest/meta-data/", "file:///etc/passwd", "concat:/etc/passwd", "pipe:1", "data:text/plain,secret"]) {
    assert.throws(() => media.assertLocalMediaPath(url), /local filesystem path/);
  }

  const inputPath = path.join(dataDir, "local-media-input.mp4");
  const outputPath = path.join(dataDir, "local-media-output.mp4");
  const outputTargetPath = path.join(dataDir, "local-media-output-target.mp4");
  const symlinkOutputPath = path.join(dataDir, "local-media-output-link.mp4");
  fs.writeFileSync(inputPath, "synthetic local media");
  fs.writeFileSync(outputTargetPath, "preserve output target");
  fs.symlinkSync(outputTargetPath, symlinkOutputPath);
  const priorAllowedPaths = process.env.SIDEKICK_MCP_ALLOWED_PATHS;
  process.env.SIDEKICK_MCP_ALLOWED_PATHS = dataDir;
  try {
    const resolvedInput = toolContext.runWithContext({ source: "mcp" }, () => media.resolveMediaInputPath(inputPath));
    assert.equal(resolvedInput, fs.realpathSync(inputPath));
    const resolvedOutput = toolContext.runWithContext({ source: "mcp" }, () => media.resolveMediaOutputPath(outputPath));
    assert.equal(resolvedOutput, outputPath);
    assert.throws(() => toolContext.runWithContext({ source: "mcp" }, () => media.resolveMediaOutputPath(symlinkOutputPath)), /symlink/);
    assert.equal(fs.readFileSync(outputTargetPath, "utf8"), "preserve output target");

    const remoteInput = await dispatcher.callMcpTool("media", { action: "info", input: "http://127.0.0.1/latest/meta-data/" }, {
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    });
    assert.equal(remoteInput.isError, true);
    assert.match(remoteInput.content[0].text, /URL and device protocols are not accepted/);
    const remoteOutput = await dispatcher.callMcpTool("media", { action: "convert", input: inputPath, output: "http://attacker.invalid/upload" }, {
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    });
    assert.equal(remoteOutput.isError, true);
    assert.match(remoteOutput.content[0].text, /URL and device protocols are not accepted/);
  } finally {
    if (priorAllowedPaths === undefined) delete process.env.SIDEKICK_MCP_ALLOWED_PATHS;
    else process.env.SIDEKICK_MCP_ALLOWED_PATHS = priorAllowedPaths;
  }
});

test("database exports atomically replace the output leaf instead of following symlinks", () => {
  const databaseAdmin = require("../src/tools/families/database-admin");
  const outputPath = path.join(dataDir, "database-export.json");
  const linkedTargetPath = path.join(dataDir, "database-export-target.json");
  fs.writeFileSync(linkedTargetPath, "keep target unchanged");
  fs.symlinkSync(linkedTargetPath, outputPath);
  const priorAllowedPaths = process.env.SIDEKICK_MCP_ALLOWED_PATHS;
  process.env.SIDEKICK_MCP_ALLOWED_PATHS = dataDir;
  try {
    toolContext.runWithContext({ source: "mcp" }, () => databaseAdmin.writeDatabaseExport(outputPath, "export contents"));
    assert.equal(fs.readFileSync(linkedTargetPath, "utf8"), "keep target unchanged");
    assert.equal(fs.readFileSync(outputPath, "utf8"), "export contents");
    assert.equal(fs.lstatSync(outputPath).isSymbolicLink(), false);

    assert.throws(
      () => databaseAdmin.writeDatabaseExport(outputPath, "x".repeat(databaseAdmin.MAX_DATABASE_EXPORT_BYTES + 1)),
      /exceeds/,
    );
  } finally {
    if (priorAllowedPaths === undefined) delete process.env.SIDEKICK_MCP_ALLOWED_PATHS;
    else process.env.SIDEKICK_MCP_ALLOWED_PATHS = priorAllowedPaths;
  }
});

test("transcription job IDs cannot traverse paths and job records are principal-scoped", async () => {
  const media = require("../src/tools/families/media");
  const jobId = "tr_00000000-0000-4000-8000-000000000001";
  assert.throws(() => media.transcriptionJobPath("../../sidekick.db"), /invalid transcription job ID/);
  const activeJobs = new Map([
    ["running", { status: "running" }],
    ["queued", { status: "queued" }],
    ["completed", { status: "completed" }],
  ]);
  assert.equal(media.countActiveTranscriptionJobs(activeJobs), media.MAX_ACTIVE_TRANSCRIPTION_JOBS);
  assert.throws(() => media.assertTranscriptionCapacity(activeJobs), /capacity reached/);
  activeJobs.delete("queued");
  assert.doesNotThrow(() => media.assertTranscriptionCapacity(activeJobs));
  const scratchOutput = fs.mkdtempSync(path.join(dataDir, "transcription-scratch-"));
  fs.writeFileSync(path.join(scratchOutput, "raw-transcript.txt"), "synthetic transcript");
  media.removeTranscriptionOutput(scratchOutput);
  assert.equal(fs.existsSync(scratchOutput), false, "completed or cancelled job scratch output is removed");

  const traversal = await dispatcher.callMcpTool("transcribe", { action: "status", job_id: "../../sidekick.db" }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.equal(traversal.isError, true);
  assert.equal(traversal.code, "validation_failed", "untrusted job IDs must be rejected before file lookup");

  media.saveTranscriptionJob({
    job_id: jobId,
    owner_principal_id: owner.principal_id,
    status: "completed",
    output: "private synthetic transcript",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const ownStatus = await dispatcher.callMcpTool("transcribe", { action: "status", job_id: jobId }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.equal(ownStatus.isError, undefined, JSON.stringify(ownStatus));
  assert.match(ownStatus.content[0].text, /private synthetic transcript/);
  assert.doesNotMatch(ownStatus.content[0].text, /owner_principal_id/);

  const otherStatus = await dispatcher.callMcpTool("transcribe", { action: "status", job_id: jobId }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(otherStatus.isError, true);
  assert.equal(otherStatus.code, undefined);
  assert.doesNotMatch(otherStatus.content[0].text, /private synthetic transcript/);

  const otherCancel = await dispatcher.callMcpTool("transcribe", { action: "cancel", job_id: jobId }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(otherCancel.isError, true);
  const ownerAfterDeniedCancel = await dispatcher.callMcpTool("transcribe", { action: "status", job_id: jobId }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.match(ownerAfterDeniedCancel.content[0].text, /"status":\s*"completed"/);
});

test("database metadata inspection uses its dedicated scoped permission", async () => {
  for (const name of ["db_schema", "db_stats"]) {
    const descriptor = tools.getBuiltinRegistry().get(name);
    assert.equal(descriptor.authorizationPermission, "database.inspect");
    const denied = await dispatcher.callAgentTool(name, {}, {
      authIdentity: { principal_id: operator.principal_id, principal_type: "human", scopes: ["tools.execute"] },
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.code, "authorization_denied", `${name} must require the database.inspect scope`);
  }

  const operatorRead = await dispatcher.callAgentTool("db_schema", {}, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(operatorRead.isError, undefined, "the existing operator workflow retains explicit database.inspect access");

  const directDenied = await toolContext.runWithContext(
    toolContext.createAgentExecutionContext({ authIdentity: { principal_id: operator.principal_id, scopes: ["tools.execute"] } }),
    () => require("../src/tools/families/database-inspection").sidekick_db_stats({}),
  );
  assert.equal(directDenied.isError, true);
  assert.equal(directDenied.code, "forbidden", "direct family calls enforce the dedicated grant too");
});

test("direct handoff handler calls require canonical dispatch", async () => {
  const result = await toolContext.runWithContext(
    toolContext.createMcpExecutionContext(),
    () => handoffTool.sidekick_handoff({ action: "list", project: "memory_a" }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
  assert.match(result.content[0].text, /canonical dispatch/);

  const ownerContext = toolContext.createMcpExecutionContext({
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    project: "memory_a",
  });
  const ownerDirect = await toolContext.runWithContext(ownerContext, () => handoffTool.sidekick_handoff({ action: "list", project: "memory_a" }));
  assert.equal(ownerDirect.isError, true);
  assert.equal(ownerDirect.code, "canonical_dispatch_required", "an authorized Owner must not bypass dispatcher policy or audit through a direct handoff call");
});

test("direct project registry handler calls require an attributable principal", async () => {
  const result = await toolContext.runWithContext(
    toolContext.createMcpExecutionContext(),
    () => projectRegistryTool.sidekick_project_registry({ action: "list" }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("direct infrastructure handler calls enforce their dispatcher privilege level", async () => {
  const calls = [
    [networkingTools.sidekick_tunnel, { action: "invalid" }],
    [networkingTools.sidekick_wireguard, { action: "invalid" }],
    [networkingTools.sidekick_nginx, { action: "invalid" }],
    [processManagementTools.sidekick_process, { action: "invalid" }],
    [processManagementTools.sidekick_service, { action: "invalid" }],
    [processManagementTools.sidekick_archive, { action: "invalid" }],
    [operationsTools.sidekick_ops, { action: "invalid" }],
  ];
  for (const [handler, args] of calls) {
    const result = await handler(args);
    assert.equal(result.code, "unauthenticated");
  }
  const insufficient = await toolContext.runWithContext(
    toolContext.createMcpExecutionContext({ authIdentity: { principal_id: denied.principal_id, principal_type: "human" } }),
    () => processManagementTools.sidekick_process({ action: "list" }),
  );
  assert.equal(insufficient.code, "forbidden", "an authenticated caller without tools.execute_high must not enumerate processes directly");
});

test("direct secret handler calls enforce metadata, value-read, and mutation grants", async () => {
  for (const action of ["list", "get", "store", "delete", "rotate"]) {
    const result = await secretTools.sidekick_secret({ action, key: "synthetic_secret", value: "synthetic-value", generate: "32" });
    assert.equal(result.isError, true);
    assert.equal(result.code, "unauthenticated");
  }
  for (const action of ["list", "get", "store", "delete", "rotate"]) {
    const result = await toolContext.runWithContext(
      toolContext.createMcpExecutionContext({ authIdentity: { principal_id: denied.principal_id, principal_type: "human" } }),
      () => secretTools.sidekick_secret({ action, key: "synthetic_secret", value: "synthetic-value", generate: "32" }),
    );
    assert.equal(result.code, "forbidden", `${action} requires its matching secrets grant`);
  }
});

test("webhook payload read and clear require distinct current grants", async () => {
  const payloads = [{ id: "synthetic_webhook_1", source: "test", timestamp: new Date().toISOString(), payload: { message: "synthetic private webhook body" } }];
  db.setDocument("webhooks", payloads);

  const unauthenticated = await dispatcher.callMcpTool("webhook", { action: "list" });
  assert.equal(unauthenticated.isError, true);
  assert.equal(unauthenticated.code, "unauthenticated");

  const noReadGrant = await dispatcher.callAgentTool("webhook", { action: "get", id: payloads[0].id }, {
    authIdentity: { principal_id: denied.principal_id, principal_type: "human" },
  });
  assert.equal(noReadGrant.isError, true);
  assert.equal(noReadGrant.code, "authorization_denied");
  assert.deepEqual(db.loadDocument("webhooks", []), payloads, "denied reads and clears do not alter retained data");

  const ownerRead = await dispatcher.callAgentTool("webhook", { action: "get", id: payloads[0].id }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.equal(ownerRead.isError, undefined);
  assert.match(ownerRead.content[0].text, /synthetic private webhook body/);

  const noManageGrant = await dispatcher.callAgentTool("webhook", { action: "clear" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(noManageGrant.isError, true);
  assert.equal(noManageGrant.code, "authorization_denied");
  assert.deepEqual(db.loadDocument("webhooks", []), payloads, "read authority cannot clear webhook data");

  const ownerClear = await dispatcher.callAgentTool("webhook", { action: "clear" }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.equal(ownerClear.isError, undefined);
  assert.deepEqual(db.loadDocument("webhooks", []), []);
});

test("direct webhook clear and anonymize-pattern mutation fail before persistent effects", async () => {
  const payloads = [{ id: "synthetic_direct_webhook", source: "test", timestamp: new Date().toISOString(), payload: { message: "retained" } }];
  db.setDocument("webhooks", payloads);
  const comms = require("../src/tools/families/comms");
  const security = require("../src/tools/families/security");
  const ownerContext = toolContext.createMcpExecutionContext({ authIdentity: { principal_id: owner.principal_id, principal_type: "human" } });
  const directClear = await toolContext.runWithContext(ownerContext, () => comms.sidekick_webhook({ action: "clear" }));
  assert.equal(directClear.code, "canonical_dispatch_required");
  assert.deepEqual(db.loadDocument("webhooks", []), payloads, "direct clear must not remove received webhook data");

  const uniquePattern = "DIRECT_GUARD_PATTERN_20261021";
  const directMutation = await toolContext.runWithContext(ownerContext, () => security.sidekick_anonymize({
    action: "add_pattern",
    custom_patterns: [{ pattern: uniquePattern, replacement: "[REDACTED]" }],
  }));
  assert.equal(directMutation.code, "canonical_dispatch_required");
  const visiblePatterns = await dispatcher.callAgentTool("anonymize", { action: "patterns" }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.equal(visiblePatterns.isError, undefined);
  assert.ok(!visiblePatterns.content[0].text.includes(uniquePattern), "direct pattern mutation must not persist");
});

test("metrics reads and Ollama model operations reject identityless dispatch before service access", async () => {
  for (const [name, args] of [
    ["metrics", { action: "query", query: "from(bucket: \"synthetic\") |> range(start: -1h)" }],
    ["metrics", { action: "write", measurement: "synthetic", fields: { value: 1 } }],
    ["ollama", { action: "list" }],
    ["ollama", { action: "pull", model: "synthetic-test-model" }],
  ]) {
    const result = await dispatcher.callMcpTool(name, args);
    assert.equal(result.isError, true, `${name}.${args.action} must be denied without identity`);
    assert.equal(result.code, "unauthenticated", `${name}.${args.action} must fail before touching the service`);
  }
});

test("anonymize pattern inspection and mutation reject identityless dispatch", async () => {
  for (const args of [
    { action: "patterns" },
    { action: "add_pattern", custom_patterns: [{ pattern: "synthetic", replacement: "redacted" }] },
    { action: "remove_pattern", custom_patterns: [{ pattern: "synthetic", replacement: "redacted" }] },
  ]) {
    const result = await dispatcher.callMcpTool("anonymize", args);
    assert.equal(result.isError, true);
    assert.equal(result.code, "unauthenticated");
  }
  const transform = await dispatcher.callMcpTool("anonymize", { action: "anonymize", input: "synthetic text" });
  assert.notEqual(transform.code, "unauthenticated", "pure caller-provided text transform remains usable without persistent authority");
});

test("GitHub CI status requires canonical dispatch and the dedicated current repository-read grant", async () => {
  const githubTools = require("../src/tools/families/github");
  const direct = await githubTools.sidekick_ci_status({ repo: "private/example", sha: "synthetic-sha" });
  assert.equal(direct.isError, true);
  assert.equal(direct.code, "canonical_dispatch_required");

  const unauthenticated = await dispatcher.callMcpTool("ci_status", { repo: "private/example", sha: "synthetic-sha" });
  assert.equal(unauthenticated.isError, true);
  assert.equal(unauthenticated.code, "unauthenticated");

  const noGrant = await dispatcher.callAgentTool("ci_status", { repo: "private/example", sha: "synthetic-sha" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(noGrant.isError, true);
  assert.equal(noGrant.code, "authorization_denied");
});

test("resume pointers are project-scoped and require an authenticated identity", async () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
  db.setDocument("resume", { items: {
    memory_a: { project: "memory_a", status: "active", summary: "Visible project resume", next_step: "Continue" },
    memory_b: { project: "memory_b", status: "active", summary: "Synthetic private project resume", next_step: "Do not expose" },
  } });
  const unauthenticated = await dispatcher.callMcpTool("resume", { action: "list", format: "json" });
  assert.equal(unauthenticated.isError, true);
  assert.equal(unauthenticated.code, "unauthenticated");

  const listed = await dispatcher.callAgentTool("resume", { action: "list", format: "json" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.notEqual(listed.isError, true, listed.content?.[0]?.text);
  const items = JSON.parse(listed.content[0].text).items;
  assert.ok(items.some(item => item.project === "memory_a"));
  assert.ok(items.every(item => item.project === "memory_a"), "unbound list filters every project by current read access");
  const narrowlyScopedList = await dispatcher.callMcpTool("resume", { action: "list", format: "json" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human", scopes: ["memory.read"] },
  });
  assert.notEqual(narrowlyScopedList.isError, true, narrowlyScopedList.content?.[0]?.text);
  const readOnlySet = await dispatcher.callAgentTool("resume", { action: "set", project: "memory_a", summary: "must not persist", next_step: "must not persist" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human", scopes: ["memory.read"] },
  });
  assert.equal(readOnlySet.code, "authorization_denied", "read-only memory credentials cannot mutate resume pointers");

  const foreignCheck = await dispatcher.callAgentTool("resume", { action: "check", project: "memory_b" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(foreignCheck.isError, true);
  assert.equal(foreignCheck.code, "project_access_denied");
  assert.equal(db.loadDocument("resume").items.memory_b.summary, "Synthetic private project resume", "denied actions do not mutate the foreign pointer");
});

test("signed Dashboard proxy keeps role authority distinct from empty credential scopes", () => {
  const { createAgentProxyHeaders, verifyAgentProxyRequest } = require("../src/security/agent-proxy-auth");
  const authorization = require("../src/core/authorization");
  const secret = "synthetic-dashboard-proxy-scope-test-secret";
  const method = "GET";
  const requestPath = "/api/agent/tasks";
  const now = Date.now();
  const roleHeaders = createAgentProxyHeaders({ secret, method, path: requestPath, principalId: operator.principal_id, scopes: null, now });
  const roleIdentity = verifyAgentProxyRequest({ secret, method, path: requestPath, headers: roleHeaders, now, usedNonces: new Map() });
  assert.equal(roleIdentity.scopes, null);
  assert.equal(authorization.authorize({ principalId: operator.principal_id, permission: "predictions.read", credentialScopes: roleIdentity.scopes }).ok, true);

  const emptyCredentialHeaders = createAgentProxyHeaders({ secret, method, path: requestPath, principalId: operator.principal_id, scopes: [], now });
  const emptyCredentialIdentity = verifyAgentProxyRequest({ secret, method, path: requestPath, headers: emptyCredentialHeaders, now, usedNonces: new Map() });
  assert.deepEqual(emptyCredentialIdentity.scopes, []);
  assert.equal(authorization.authorize({ principalId: operator.principal_id, permission: "predictions.read", credentialScopes: emptyCredentialIdentity.scopes }).ok, false);
});

test("prediction SQL project-list filtering excludes unrelated and unscoped rows", () => {
  const dbh = db.getDb();
  const now = new Date().toISOString();
  const insert = dbh.prepare(`INSERT INTO predictions (id,type,subject,explanation,project,status,created_at,updated_at)
    VALUES (?, 'likely_failure', ?, 'synthetic explanation', ?, 'active', ?, ?)`);
  insert.run("security-pred-a", "scoped A", "memory_a", now, now);
  insert.run("security-pred-b", "private B", "memory_b", now, now);
  insert.run("security-pred-global", "unscoped global", null, now, now);
  const visible = predictEngine.listPredictions({ projects: ["memory_a"] });
  assert.deepEqual(visible.map(prediction => prediction.id), ["security-pred-a"]);
  assert.deepEqual(predictEngine.listPredictions({ projects: [] }), []);
});

test("canonical Predict dispatcher enforces identity, project filtering, and resource concealment", async () => {
  const context = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" } };
  const unauthenticated = await dispatcher.callMcpTool("predict", { action: "list" });
  assert.equal(unauthenticated.code, "unauthenticated");

  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
  const listed = await dispatcher.callAgentTool("predict", { action: "list" }, context);
  assert.equal(listed.isError, undefined);
  const predictions = JSON.parse(listed.content[0].text).predictions;
  assert.ok(predictions.some(prediction => prediction.id === "security-pred-a"));
  assert.ok(predictions.every(prediction => prediction.project === "memory_a"));

  const hidden = await dispatcher.callMcpTool("predict", { action: "get", id: "security-pred-b" }, context);
  assert.equal(hidden.isError, true);
  assert.equal(hidden.code, "not_found");
  assert.doesNotMatch(hidden.content[0].text, /private B/);

  const mutation = await dispatcher.callAgentTool("predict", { action: "dismiss", id: "security-pred-b" }, context);
  assert.equal(mutation.isError, true);
  assert.equal(mutation.code, "not_found");
  assert.equal(predictEngine.getPrediction("security-pred-b").status, "active", "cross-project mutation is rejected before persistence");
});

test("Predict revalidates delegated permission and project membership on each call", async () => {
  const delegate = require('./helpers/authorized-identity').createPrincipal(identity, { type: "agent", displayName: "prediction reader agent", actorPrincipalId: owner.principal_id });
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: delegate.principal_id, project: "memory_a", accessLevel: "read" });
  const delegation = require("../src/core/authorization").createDelegation({
    delegatorPrincipalId: operator.principal_id,
    delegatePrincipalId: delegate.principal_id,
    permissions: ["predictions.read"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    actorContext: { principal_id: operator.principal_id },
  });
  const context = { authIdentity: { principal_id: delegate.principal_id, principal_type: "agent", delegation_id: delegation.delegation_id } };
  const allowed = await dispatcher.callAgentTool("predict", { action: "list" }, context);
  assert.equal(allowed.isError, undefined);
  assert.ok(JSON.parse(allowed.content[0].text).predictions.every(prediction => prediction.project === "memory_a"));

  require("../src/core/authorization").revokeDelegation(delegation.delegation_id, { principal_id: operator.principal_id });
  const revoked = await dispatcher.callAgentTool("predict", { action: "list" }, context);
  assert.equal(revoked.isError, true);
  assert.equal(revoked.code, "authorization_denied", "revoked authority is reevaluated at dispatch");
});

test("dispatcher requires an attributable principal for every non-low-risk operation", async () => {
  const denied = await dispatcher.callMcpTool("bash", { command: "echo should-not-run" });
  assert.equal(denied.code, "unauthenticated");
  assert.match(denied.content[0].text, /Authentication required/);

  const lowRiskRead = await dispatcher.callMcpTool("capability", { action: "list" });
  assert.equal(lowRiskRead.isError, undefined, "explicitly low-risk inventory remains available under transport policy");
  const lowRiskCatalog = await dispatcher.callMcpTool("capability", { action: "catalog", limit: 1 });
  assert.equal(lowRiskCatalog.isError, undefined, "read-only capability catalog remains available without Core mutation authority");

  const authorized = await dispatcher.callMcpTool("db_query", { sql: "SELECT 1 AS identity_ok" }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
  assert.equal(authorized.isError, undefined, "the authenticated owner reaches the authorized handler");
  assert.match(authorized.content[0].text, /identity_ok/);
});

test("project registry reads require memory authority and filter by current project membership", async () => {
  const anonymous = await dispatcher.callMcpTool("project_registry", { action: "list" });
  assert.equal(anonymous.isError, true);
  assert.equal(anonymous.code, "unauthenticated");

  const operatorContext = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" } };
  const listing = await dispatcher.callMcpTool("project_registry", { action: "list" }, operatorContext);
  assert.equal(listing.isError, undefined);
  const listedProjects = JSON.parse(listing.content[0].text).projects;
  assert.deepEqual(listedProjects.map(project => project.project_id), ["memory_a"]);
  assert.doesNotMatch(listing.content[0].text, /Project B private/);

  const ownProject = await dispatcher.callMcpTool("project_registry", { action: "get", project: "memory_a" }, operatorContext);
  assert.equal(ownProject.isError, undefined);
  const foreignProject = await dispatcher.callMcpTool("project_registry", { action: "get", project: "memory_b" }, operatorContext);
  assert.equal(foreignProject.isError, true);
  assert.equal(foreignProject.code, "project_access_denied");
  assert.doesNotMatch(foreignProject.content?.[0]?.text || "", /Project B private/);
  const foreignSources = await dispatcher.callMcpTool("project_registry", { action: "sources", project: "memory_b" }, operatorContext);
  assert.equal(foreignSources.isError, true);
  assert.equal(foreignSources.code, "project_access_denied");
});

test("canonical memory dispatcher blocks cross-project reads before returning content", async () => {
  const result = await dispatcher.callMcpTool("memory", { action: "get", id: secretB.id, project: "memory_b" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text || "", /project|scope/i);
  assert.doesNotMatch(result.content?.[0]?.text || "", /Project B private fact/);
});

test("authenticated users cannot query memories without an authorized explicit project", async () => {
  const result = await dispatcher.callMcpTool("memory", { action: "query" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text || "", /project scope/i);
});

test("memory export is project-bound and import requires write membership", async () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
  const omitted = await dispatcher.callMcpTool("memory_export", {}, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(omitted.isError, true, "non-manager export must name an authorized project");

  const scoped = await dispatcher.callMcpTool("memory_export", { project: "memory_a" }, {
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(scoped.isError, undefined);
  const exported = JSON.parse(scoped.content[0].text);
  assert.ok(exported.memories.some(memory => memory.project === "memory_a"));
  assert.ok(exported.memories.every(memory => memory.project === "memory_a"));
  assert.ok(!scoped.content[0].text.includes("Project B private fact"));

  const imported = await dispatcher.callMcpTool("memory_import", {
    project: "memory_a", data: JSON.stringify({ memories: [] }),
  }, { authIdentity: { principal_id: operator.principal_id, principal_type: "human" } });
  assert.equal(imported.isError, true, "read-only membership cannot import memories");
});

test("sync diff and import preserve memory project boundaries", async () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "write" });
  const identityContext = { authIdentity: { principal_id: operator.principal_id, principal_type: "human" } };
  const unscopedDiff = await dispatcher.callMcpTool("sync_diff", { since: "2000-01-01T00:00:00.000Z" }, identityContext);
  assert.equal(unscopedDiff.isError, true, "non-global diff must name an authorized project");
  const scopedDiff = await dispatcher.callMcpTool("sync_diff", { project: "memory_a", since: "2000-01-01T00:00:00.000Z" }, identityContext);
  assert.equal(scopedDiff.isError, undefined);
  const changes = JSON.parse(scopedDiff.content[0].text).changes;
  assert.ok(changes.every(change => change.project === "memory_a"));
  assert.doesNotMatch(scopedDiff.content[0].text, /Project B private fact/);

  const imported = await dispatcher.callMcpTool("sync_import", {
    project: "memory_a",
    data: JSON.stringify({ memories: [
      { type: "fact", project: "memory_a", content: "sync imported scoped A", confidence: 0.8 },
      { type: "fact", project: "memory_b", content: "sync imported forbidden B", confidence: 0.8 },
    ] }),
  }, identityContext);
  assert.equal(imported.isError, undefined);
  assert.ok(db.searchMemories({ project: "memory_a", query: "sync imported scoped A" }).length > 0);
  assert.equal(db.searchMemories({ project: "memory_b", query: "sync imported forbidden B" }).length, 0);
});

test("Dashboard handoff ownership does not survive project-access revocation", () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
  const handoff = db.saveHandoff({
    project: "memory_a", title: "Access revocation", source: "test",
    content: "Decision: current project access is required even for the creator.",
    owner_principal_id: operator.principal_id,
    created_by_principal_id: operator.principal_id,
  });
  const handlers = new Map();
  const app = { get: (route, handler) => handlers.set(route, handler) };
  registerHandoffReadRoutes({ app, dbStore: db, errorResponse: () => {} });
  function invoke(route) {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    handlers.get(route)({ params: { id: handoff.id }, query: {}, authPrincipal: { principal_id: operator.principal_id, scopes: null } }, res);
    return res;
  }

  assert.equal(invoke("/api/handoffs/:id").statusCode, 200, "active project grant permits the handoff owner");
  assert.equal(projectAccess.revokeProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a" }), true);
  const revoked = invoke("/api/handoffs/:id");
  assert.equal(revoked.statusCode, 404);
  assert.equal(revoked.body.error, "Handoff not found");
  assert.equal(invoke("/api/handoffs/:id/readiness").statusCode, 404);
});

test("Dashboard memory evidence requires memory permission and project scope", () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
  const handlers = new Map();
  registerHandoffReadRoutes({ app: { get: (route, handler) => handlers.set(route, handler) }, dbStore: db, errorResponse: () => {} });
  function invoke(memoryId, principalId, scopes) {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    handlers.get("/api/memories/:id/evidence")({
      params: { id: memoryId },
      authPrincipal: { principal_id: principalId, scopes },
    }, res);
    return res;
  }

  const principalAdminOnly = invoke(secretB.id, operator.principal_id, ["principals.manage"]);
  assert.equal(principalAdminOnly.statusCode, 404, "principal administration scope must not grant memory evidence access");
  const wrongProject = invoke(secretB.id, operator.principal_id, ["memory.read"]);
  assert.equal(wrongProject.statusCode, 404, "memory read permission does not replace project membership");
  const scopedRead = invoke(memoryA.id, operator.principal_id, ["memory.read"]);
  assert.equal(scopedRead.statusCode, 200);
  assert.equal(scopedRead.body.memory.id, memoryA.id);
});

test("Dashboard memory evidence requires access to both the memory project and linked handoff project", () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
  const linkedHandoff = db.saveHandoff({
    project: "memory_a", title: "Synthetic linked handoff", source: "test",
    content: "Synthetic content in the project the operator may read.",
    owner_principal_id: operator.principal_id,
    created_by_principal_id: operator.principal_id,
  });
  const crossProjectMemory = db.upsertMemory({
    type: "fact", project: "memory_b", content: "Synthetic private memory linked to another project handoff",
    summary: "Synthetic private memory", confidence: 0.8, source: "test", source_ref: linkedHandoff.id,
  });
  const sameProjectMemory = db.upsertMemory({
    type: "fact", project: "memory_a", content: "Synthetic memory linked within the same project",
    summary: "Synthetic same-project memory", confidence: 0.8, source: "test", source_ref: linkedHandoff.id,
  });
  assert.ok(linkedHandoff?.id, "synthetic source handoff fixture is persisted");
  assert.ok(crossProjectMemory?.id, "synthetic cross-project memory fixture is persisted");
  assert.ok(sameProjectMemory?.id, "synthetic same-project memory fixture is persisted");
  assert.equal(crossProjectMemory.source_ref, linkedHandoff.id, "memory points at the authorized-project handoff");
  assert.equal(db.getMemoryById(crossProjectMemory.id, { includeDisabled: true }).project, "memory_b");
  assert.equal(db.getHandoff(linkedHandoff.id).project, "memory_a");
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "read", ["memory.read"]), true);
  const handlers = new Map();
  registerHandoffReadRoutes({ app: { get: (route, handler) => handlers.set(route, handler) }, dbStore: db, errorResponse: () => {} });
  const invoke = memoryId => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    handlers.get("/api/memories/:id/evidence")({
      params: { id: memoryId },
      authPrincipal: { principal_id: operator.principal_id, scopes: ["memory.read"] },
    }, res);
    return res;
  };
  const sameProject = invoke(sameProjectMemory.id);
  assert.equal(sameProject.statusCode, 200, "same-project memory and handoff remain readable");
  assert.equal(sameProject.body.memory.id, sameProjectMemory.id);
  const res = invoke(crossProjectMemory.id);
  assert.equal(res.statusCode, 404, "access to a linked handoff must not expose a memory from an unauthorized project");
  assert.doesNotMatch(JSON.stringify(res.body), /Synthetic private memory/);
});

test("handoff details do not include linked memories outside the handoff project scope", async () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "read" });
  const handoff = db.saveHandoff({
    project: "memory_a", title: "Synthetic scoped handoff", source: "test",
    content: "Synthetic handoff content for project scope test.",
    owner_principal_id: operator.principal_id,
    created_by_principal_id: operator.principal_id,
  });
  const scopedMemory = db.upsertMemory({
    type: "fact", project: "memory_a", content: "Synthetic same-project handoff memory",
    summary: "Synthetic same-project handoff memory", confidence: 0.8, source: "test",
    source_ref: handoff.id, metadata: { handoff_id: handoff.id },
  });
  const globalMemory = db.upsertMemory({
    type: "fact", project: null, content: "Synthetic private global memory via source reference",
    summary: "Synthetic private global memory", confidence: 0.8, source: "test",
    source_ref: handoff.id,
  });
  const metadataLinkedGlobalMemory = db.upsertMemory({
    type: "fact", project: null, content: "Synthetic private global memory via metadata reference",
    summary: "Synthetic private global metadata memory", confidence: 0.8, source: "test",
    metadata: { handoff_id: handoff.id },
  });
  const handlers = new Map();
  registerHandoffReadRoutes({ app: { get: (route, handler) => handlers.set(route, handler) }, dbStore: db, errorResponse: () => {} });
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handlers.get("/api/handoffs/:id")({
    params: { id: handoff.id }, query: {},
    authPrincipal: { principal_id: operator.principal_id, scopes: ["memory.read"] },
  }, res);

  assert.equal(res.statusCode, 200, "the authorized operator may still read the handoff itself");
  assert.ok(res.body.memories.some(memory => memory.id === scopedMemory.id), "same-project linked memories remain visible");
  assert.ok(globalMemory?.id && metadataLinkedGlobalMemory?.id, "synthetic global fixtures are persisted");
  assert.ok(!res.body.memories.some(memory => memory.id === globalMemory.id));
  assert.ok(!res.body.memories.some(memory => memory.id === metadataLinkedGlobalMemory.id));
  assert.doesNotMatch(JSON.stringify(res.body.memories), /Synthetic private global memory/);

  const inspected = await dispatcher.callMcpTool("handoff", { action: "inspect", id: handoff.id, project: "memory_a" }, {
    project: "memory_a",
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  assert.equal(inspected.isError, undefined);
  const inspectedMemories = JSON.parse(inspected.content[0].text).extracted_memories;
  assert.ok(Array.isArray(inspectedMemories), inspected.content[0].text);
  assert.ok(inspectedMemories.some(memory => memory.id === scopedMemory.id));
  assert.ok(!inspectedMemories.some(memory => memory.id === globalMemory.id));
  assert.ok(!inspectedMemories.some(memory => memory.id === metadataLinkedGlobalMemory.id));
  assert.doesNotMatch(JSON.stringify(inspectedMemories), /Synthetic private global memory/);
});

test("handoff packet persistence redacts credentials by nested field name", () => {
  const apiKey = "SYNTHETIC_HANDOFF_API_KEY_VALUE";
  const token = "SYNTHETIC_HANDOFF_TOKEN_VALUE";
  const handoff = db.saveHandoff({
    project: "memory_a", title: "Synthetic packet redaction", source: "test",
    content: "Synthetic handoff content.",
    packet: {
      objective: "Synthetic objective",
      status: "active",
      next_step: "Continue safely",
      provenance: { api_key: apiKey },
      evidence: [{ type: "test", label: "Synthetic evidence", token }],
    },
  });
  const updated = db.saveHandoff({
    id: handoff.id, project: "memory_a", content: "Synthetic updated handoff content.",
    expectedVersion: handoff.version,
    packet: {
      ...handoff.packet,
      next_step: "Updated safely",
      artifacts: [{ type: "test", password: "SYNTHETIC_HANDOFF_PASSWORD_VALUE" }],
    },
  });
  const dbHandle = db.getDb();
  const current = dbHandle.prepare("SELECT packet_json FROM memory_handoffs WHERE id = ?").get(handoff.id);
  const history = dbHandle.prepare("SELECT packet_json FROM memory_handoff_versions WHERE handoff_id = ?").all(handoff.id);
  const links = dbHandle.prepare("SELECT payload_json FROM memory_handoff_links WHERE handoff_id = ?").all(handoff.id);
  const persisted = JSON.stringify({ current, history, links, updated });
  assert.doesNotMatch(persisted, /SYNTHETIC_HANDOFF_API_KEY_VALUE/);
  assert.doesNotMatch(persisted, /SYNTHETIC_HANDOFF_TOKEN_VALUE/);
  assert.doesNotMatch(persisted, /SYNTHETIC_HANDOFF_PASSWORD_VALUE/);
  assert.match(persisted, /\[REDACTED\]/);
});

test("handoff content and titles persist only redacted credential text", () => {
  const apiKey = "SYNTHETIC_HANDOFF_CONTENT_API_KEY_VALUE";
  const password = "SYNTHETIC_HANDOFF_CONTENT_PASSWORD_VALUE";
  const handoff = db.saveHandoff({
    project: "memory_a", title: `Synthetic api_key=${apiKey}`, source: "test",
    content: JSON.stringify({ summary: "Synthetic handoff", password }),
    packet: { objective: "Synthetic safe objective", status: "active", next_step: "Continue safely" },
  });
  const dbHandle = db.getDb();
  const legacyRawContent = JSON.stringify({ summary: "Synthetic handoff", password });
  const legacyRawPacket = JSON.stringify({ objective: "Synthetic safe objective", status: "active", next_step: "Continue safely", provenance: { api_key: apiKey } });
  dbHandle.prepare("UPDATE memory_handoffs SET title = ?, content = ?, packet_json = ? WHERE id = ?")
    .run(`Legacy api_key=${apiKey}`, legacyRawContent, legacyRawPacket, handoff.id);
  const updated = db.saveHandoff({
    id: handoff.id, project: "memory_a", expectedVersion: handoff.version,
    title: `Legacy api_key=${apiKey}`,
    content: legacyRawContent,
  });
  const current = dbHandle.prepare("SELECT title, content, redacted_content FROM memory_handoffs WHERE id = ?").get(handoff.id);
  const history = dbHandle.prepare("SELECT title, content, redacted_content FROM memory_handoff_versions WHERE handoff_id = ?").all(handoff.id);
  const persisted = JSON.stringify({ current, history, updated });
  assert.doesNotMatch(persisted, /SYNTHETIC_HANDOFF_CONTENT_API_KEY_VALUE/);
  assert.doesNotMatch(persisted, /SYNTHETIC_HANDOFF_CONTENT_PASSWORD_VALUE/);
  assert.match(persisted, /\[REDACTED\]/);
});

test("handoff extraction cannot write memories into an ungranted project", async () => {
  const context = tools.context.createMcpExecutionContext({
    authIdentity: { principal_id: operator.principal_id, principal_type: "human" },
  });
  const before = db.searchMemories({ project: "memory_b", includeDisabled: true, limit: 100 }).length;
  const result = await dispatcher.dispatchTool({ name: "handoff", context, args: {
    action: "create", project: "memory_b", title: "Unauthorized handoff",
    content: "Decision: this must not be stored in another project.",
  } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /write access denied|project access denied/i);
  assert.equal(db.searchMemories({ project: "memory_b", includeDisabled: true, limit: 100 }).length, before);
});

test("revoked and disabled principals cannot retain project access", () => {
  projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal_id, project: "memory_a", accessLevel: "write" });
  identity.setPrincipalEnabled(operator.principal_id, false, owner);
  assert.equal(projectAccess.hasProjectAccess(operator.principal_id, "memory_a", "write"), false);
});

test("handoff claim tokens are exposed once to authenticated dispatch and excluded from logs", async () => {
  const root = path.join(dataDir, "claim-token-repository");
  const { execFileSync } = require("node:child_process");
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "Synthetic handoff claim fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "claim fixture"], { stdio: "ignore" });
  const packet = {
    objective: "Verify one-time claim output",
    status: "active",
    current_state: "A ready, disposable security fixture",
    completed_steps: ["Created a synthetic handoff"],
    next_step: "Verify claim handling",
    acceptance_criteria: ["An authenticated caller receives the one-time token; logs do not"],
    provenance: {
      working_directory: root,
      commit_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      branch: "main",
    },
    evidence: [{ type: "test", label: "synthetic claim fixture", status: "passed", observed_at: new Date().toISOString() }],
  };
  const handoff = db.saveHandoff({ project: "memory_a", content: "Synthetic claim-token test fixture.", packet });
  db.captureHandoffCheckpoint(handoff.id, { working_directory: root });
  db.refreshHandoffEvidence(handoff.id, { working_directory: root });
  db.transitionHandoff(handoff.id, "ready", { expectedVersion: handoff.version });

  const result = await dispatcher.callMcpTool("handoff", {
    action: "claim", id: handoff.id, project: "memory_a", owner: owner.principal_id,
  }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
    project: "memory_a",
    sessionId: "synthetic-claim-token-session",
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.claim_token, "authenticated dispatch must return the one-time token");
  assert.equal(payload.handoff.lifecycle_state, "claimed");
  assert.equal(JSON.stringify(db.readToolLogs(100)).includes(payload.claim_token), false, "the bearer token must not enter tool logs");

  const denied = await dispatcher.callMcpTool("handoff", {
    action: "claim", id: handoff.id, project: "memory_a", owner: owner.principal_id,
  }, { project: "memory_a", sessionId: "synthetic-unauthenticated-session" });
  assert.equal(denied.isError, true, "identityless dispatch must not receive a claim token");
  assert.equal(JSON.stringify(denied).includes(payload.claim_token), false);
  assert.equal(db.getHandoff(handoff.id).claim.owner, owner.principal_id, "denied retry must not change the active claim");
});

test("handoff provenance verification enforces the caller filesystem path policy", async () => {
  const allowedRoot = fs.mkdtempSync(path.join(dataDir, "handoff-allowed-root-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-outside-root-"));
  const previousAllowed = process.env.SIDEKICK_MCP_ALLOWED_PATHS;
  const previousGlobalAllowed = process.env.SIDEKICK_ALLOWED_PATHS;
  const previousDashboardAllowed = process.env.SIDEKICK_DASHBOARD_ALLOWED_PATHS;
  process.env.SIDEKICK_MCP_ALLOWED_PATHS = allowedRoot;
  process.env.SIDEKICK_DASHBOARD_ALLOWED_PATHS = allowedRoot;
  process.env.SIDEKICK_ALLOWED_PATHS = allowedRoot;
  try {
    const { execFileSync } = require("node:child_process");
    fs.writeFileSync(path.join(outsideRoot, "README.md"), "Synthetic out-of-scope handoff claim fixture\n");
    execFileSync("git", ["init", "-b", "main", outsideRoot], { stdio: "ignore" });
    execFileSync("git", ["-C", outsideRoot, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", outsideRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "out-of-scope claim fixture"], { stdio: "ignore" });

    const handoff = db.saveHandoff({
      project: "memory_a",
      content: "Synthetic fixture with a repository outside the caller's path scope.",
      owner_principal_id: owner.principal_id,
      created_by_principal_id: owner.principal_id,
      packet: { objective: "Verify scoped repository access", provenance: { working_directory: outsideRoot, commit_sha: "abcdef0123456789" } },
    });
    const result = await dispatcher.callMcpTool("handoff", {
      action: "verify", id: handoff.id, project: "memory_a",
    }, {
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
      project: "memory_a",
      sessionId: "synthetic-handoff-path-policy-session",
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /Path blocked by policy/, JSON.stringify(result));

    const createResult = await dispatcher.callMcpTool("handoff", {
      action: "create", project: "memory_a", title: "Blocked out-of-scope repository",
      content: "Synthetic record that must not persist an out-of-scope repository path.",
      packet: { objective: "Reject an out-of-scope persisted repository", provenance: { working_directory: outsideRoot } },
    }, {
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
      project: "memory_a",
      sessionId: "synthetic-handoff-create-path-policy-session",
    });
    assert.equal(createResult.isError, true, JSON.stringify(createResult));
    assert.match(createResult.content[0].text, /Path blocked by policy/, JSON.stringify(createResult));
    assert.equal(db.listHandoffs({ project: "memory_a", limit: 100 }).some(item => item.title === "Blocked out-of-scope repository"), false,
      "out-of-scope repository paths must not be persisted by the MCP handoff tool");

    const dashboardHandoff = db.saveHandoff({
      project: "memory_a",
      content: "Synthetic dashboard path-scope fixture.",
      owner_principal_id: owner.principal_id,
      created_by_principal_id: owner.principal_id,
      packet: { objective: "Verify dashboard repository path scope", provenance: { working_directory: outsideRoot, commit_sha: "abcdef0123456789" } },
    });
    const handlers = new Map();
    registerHandoffReadRoutes({ app: { get: (route, handler) => handlers.set(route, handler) }, dbStore: db, errorResponse: () => {} });
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    handlers.get("/api/handoffs/:id/preflight")({
      params: { id: dashboardHandoff.id }, query: {},
      authPrincipal: { principal_id: owner.principal_id, scopes: null },
    }, response);
    assert.equal(response.statusCode, 403, "Dashboard preflight must not inspect a handoff repo outside its filesystem policy");

    const claimHandoff = db.saveHandoff({
      project: "memory_a",
      content: "Synthetic out-of-scope repository claim fixture.",
      owner_principal_id: owner.principal_id,
      created_by_principal_id: owner.principal_id,
      packet: {
        objective: "Reject claim of an out-of-scope repository",
        status: "active",
        current_state: "Synthetic fixture",
        completed_steps: ["Created disposable repository"],
        next_step: "Continue after an authorized claim",
        acceptance_criteria: ["Claiming checks repository path policy before readiness inspection"],
        provenance: {
          working_directory: outsideRoot,
          commit_sha: execFileSync("git", ["-C", outsideRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          branch: "main",
        },
        evidence: [{ type: "test", label: "synthetic claim fixture", status: "passed", observed_at: new Date().toISOString() }],
      },
    });
    db.captureHandoffCheckpoint(claimHandoff.id, { working_directory: outsideRoot });
    db.refreshHandoffEvidence(claimHandoff.id, { working_directory: outsideRoot });
    db.transitionHandoff(claimHandoff.id, "ready", { expectedVersion: claimHandoff.version });
    const claimResult = await dispatcher.callMcpTool("handoff", {
      action: "claim", id: claimHandoff.id, project: "memory_a", owner: owner.principal_id, working_directory: allowedRoot,
    }, {
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
      project: "memory_a",
      sessionId: "synthetic-handoff-claim-path-policy-session",
    });
    assert.equal(claimResult.isError, true, JSON.stringify(claimResult));
    assert.match(claimResult.content[0].text, /Path blocked by policy/, JSON.stringify(claimResult));
    assert.equal(db.getHandoff(claimHandoff.id).claim, null, "an out-of-scope repository must be rejected before claim/readiness work");

    const sessionResult = await dispatcher.callMcpTool("session", {
      action: "begin", goal: "Reject an out-of-scope workspace", project: "memory_a", working_directory: outsideRoot,
    }, {
      authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
      project: "memory_a",
      sessionId: "synthetic-session-path-policy-session",
    });
    assert.equal(sessionResult.isError, true, JSON.stringify(sessionResult));
    assert.match(sessionResult.content[0].text, /Path blocked by policy/, JSON.stringify(sessionResult));
    assert.equal(db.listTaskSessions({ project: "memory_a", limit: 100 }).some(session => session.goal === "Reject an out-of-scope workspace"), false,
      "a blocked workspace must not leave a durable session record");
  } finally {
    if (previousAllowed === undefined) delete process.env.SIDEKICK_MCP_ALLOWED_PATHS;
    else process.env.SIDEKICK_MCP_ALLOWED_PATHS = previousAllowed;
    if (previousGlobalAllowed === undefined) delete process.env.SIDEKICK_ALLOWED_PATHS;
    else process.env.SIDEKICK_ALLOWED_PATHS = previousGlobalAllowed;
    if (previousDashboardAllowed === undefined) delete process.env.SIDEKICK_DASHBOARD_ALLOWED_PATHS;
    else process.env.SIDEKICK_DASHBOARD_ALLOWED_PATHS = previousDashboardAllowed;
    fs.rmSync(allowedRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test.after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});
