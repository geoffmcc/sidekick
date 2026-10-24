const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-node-test-"));
const root = path.join(fixture, "workspace");
const outside = path.join(fixture, "outside");
fs.mkdirSync(path.join(root, "buried", "repo", ".git"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(root, "buried", "repo", ".git", "config"), "[core]\n");

const workspace = require("../src/node/workspace");
const placement = require("../src/node/placement");
const { descriptorIdentity } = placement;

const configured = workspace.createWorkspace({ name: "security-research", root, permissions: { read: true, write: false, execute: false } });
assert.strictEqual(configured.name, "security-research");
assert.ok(workspace.discoverRepositories(configured).some(repo => repo.root.endsWith(path.join("buried", "repo"))));
assert.throws(() => workspace.resolveWorkspacePath(configured, path.join(root, "..", "outside")), /outside|traversal/);
assert.throws(() => workspace.resolveWorkspacePath(configured, outside), /outside/);
const link = path.join(root, "escape");
try { fs.symlinkSync(outside, link, "dir"); assert.throws(() => workspace.resolveWorkspacePath(configured, path.join(link, "file")), /outside|symlink|does not exist/); } catch (error) { if (error.code !== "EPERM") throw error; }

const writable = workspace.createWorkspace({ name: "security-research", root, permissions: { read: true, write: true, execute: false } });
assert.strictEqual(workspace.resolveWorkspacePath(writable, path.join(root, "new", "output.txt"), { operation: "write", allowMissing: true }), path.join(root, "new", "output.txt"));
assert.throws(() => workspace.resolveWorkspacePath(writable, path.join(outside, "new.txt"), { operation: "write", allowMissing: true }), /outside/);

const descriptor = { name: "read", version: "1", placement: { locations: ["node"], nodeSafe: true, requirements: { os: ["linux"], workspaces: ["security-research"] } } };
const eligible = placement.checkEligibility(descriptor, { nodeId: "node_a", platform: "linux", protocolVersion: "1", workspaces: ["security-research"], authorized: true, healthy: true });
assert.strictEqual(eligible.eligible, true);
const visible = placement.checkEligibility(descriptor, { nodeId: "node_path", platform: "linux", protocolVersion: "1", workspaces: [{ name: "security-research", root }], authorized: true, healthy: true }, { requestedPaths: [path.join(root, "buried", "repo")] });
assert.strictEqual(visible.eligible, true);
const invisible = placement.checkEligibility(descriptor, { nodeId: "node_path", platform: "linux", protocolVersion: "1", workspaces: [{ name: "security-research", root }], authorized: true, healthy: true }, { requestedPaths: [outside] });
assert.strictEqual(invisible.eligible, false);
assert.ok(invisible.reasons.some(reason => reason.startsWith("path_not_visible:")));
const unverifiable = placement.checkEligibility(descriptor, { nodeId: "node_without_root", platform: "linux", protocolVersion: "1", workspaces: ["security-research"], authorized: true, healthy: true }, { requestedPaths: [path.join(root, "buried", "repo")] });
assert.strictEqual(unverifiable.eligible, false);
assert.ok(unverifiable.reasons.includes("path_visibility_unverifiable"));
const readGrant = { nodeId: "node_grant", platform: "linux", protocolVersion: "1", workspaces: [{ name: "security-research", root, permissions: { read: true, write: false } }], authorized: true, healthy: true };
assert.strictEqual(placement.checkEligibility(descriptor, readGrant, { requestedPaths: [path.join(root, "file")], requiredWorkspacePermission: "read" }).eligible, true);
const deniedWrite = placement.checkEligibility(descriptor, readGrant, { requestedPaths: [path.join(root, "file")], requiredWorkspacePermission: "write" });
assert.strictEqual(deniedWrite.eligible, false);
assert.ok(deniedWrite.reasons.includes("workspace_permission_missing:write"));
assert.strictEqual(placement.checkEligibility(descriptor, { ...readGrant, workspaces: [{ name: "security-research", root, permissions: { read: true, write: true } }] }, { requestedPaths: [outside], requiredWorkspacePermission: "write" }).eligible, false);
assert.strictEqual(placement.checkEligibility(descriptor, { nodeId: "node_b", platform: "windows", protocolVersion: "1", workspaces: ["security-research"], authorized: true, healthy: true }).eligible, false);
assert.strictEqual(placement.checkEligibility({ ...descriptor, placement: { ...descriptor.placement, nodeSafe: false } }, { platform: "linux", protocolVersion: "1", workspaces: ["security-research"] }).eligible, false);

process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.SIDEKICK_SECRET_KEY = "execution-node-test-secret-key";
const manager = require("../src/node/manager");
const { maybeExecute } = require("../src/node/dispatch");
require("../src/db").runPendingMigrations();
manager.ensureSchema();
assert.strictEqual(manager.workspacePermissionForTool("git", { action: "branch" }), "read");
assert.strictEqual(manager.workspacePermissionForTool("git", { action: "branch", args: "-D feature" }), "write");
assert.strictEqual(manager.workspacePermissionForTool("write", { path: path.join(root, "file") }), "write", "Core and node share the workspace write classification");
const db = require("../src/db").getDb();
db.prepare("INSERT INTO compute_workers (worker_id, node_id, display_name, platform, state, connection_state, credential_state) VALUES (?, ?, ?, ?, 'online', 'online', 'active')").run("wk_test_node", "node_test", "test", "linux");
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const fixtureOwner = identity.bootstrapOwner({ username: "execution_node_owner", password: "synthetic execution node owner password" });
const initiator = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "execution-node test initiator" });
identity.assignRole(initiator.principal_id, "operator", fixtureOwner);
const initiatorCredential = authentication.createCredential({ principalId: initiator.principal_id, displayName: "synthetic test credential", scopes: ["tools.execute"], createdByPrincipalId: fixtureOwner.principal_id, actorContext: fixtureOwner });
manager.register("wk_test_node", { descriptorSetHash: "hash", capabilities: { workspaces: [{ name: "security-research", root, permissions: { read: true, write: true } }] } });
manager.authorizeWorkspace("wk_test_node", { workspaceId: "ws_test", name: "security-research", rootIdentity: configured.rootIdentity, permissions: { read: true } });
const nodeAuthorityBeforeHeartbeat = manager.get("wk_test_node");
manager.register("wk_test_node", {
  descriptorSetHash: "heartbeat-hash",
  capabilities: { networkScopes: ["node-claimed-scope"], workspaces: ["node-claimed-workspace"] },
  networkScopes: ["untrusted-scope-argument"],
  workspaces: ["untrusted-workspace-argument"],
});
const nodeAfterHeartbeat = manager.get("wk_test_node");
assert.deepStrictEqual(nodeAfterHeartbeat.authorizedWorkspaces, nodeAuthorityBeforeHeartbeat.authorizedWorkspaces, "node registration and heartbeat telemetry cannot grant or replace workspace authority");
assert.deepStrictEqual(nodeAfterHeartbeat.authorizedNetworkScopes, nodeAuthorityBeforeHeartbeat.authorizedNetworkScopes, "node registration and heartbeat telemetry cannot grant or replace network-scope authority");
assert.deepStrictEqual(nodeAfterHeartbeat.capabilities.networkScopes, ["node-claimed-scope"], "reported capability labels remain telemetry separate from Core authorization");
const job = manager.enqueue({ workerId: "wk_test_node", requestId: "req_test", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: { path: path.join(root, "file") }, workspaceId: "ws_test", idempotencyKey: "idem_test" });
assert.strictEqual(manager.enqueue({ workerId: "wk_test_node", requestId: "req_other", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: { path: path.join(root, "file") }, workspaceId: "ws_test", idempotencyKey: "idem_test" }).jobId, job.jobId);
assert.throws(() => manager.enqueue({ workerId: "wk_test_node", requestId: "req_changed_args", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: { path: path.join(root, "other-file") }, workspaceId: "ws_test", idempotencyKey: "idem_test" }), /different execution scope or operation/);
assert.throws(() => manager.enqueue({ workerId: "wk_test_node", requestId: "req_changed_identity", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: { path: path.join(root, "file") }, context: { authIdentity: { principal_id: "other-principal", authentication_method: "session" } }, workspaceId: "ws_test", idempotencyKey: "idem_test" }), /different execution scope or operation/);
assert.throws(() => manager.enqueue({ workerId: "wk_test_node", requestId: "req_write_denied", toolName: "write", descriptor: { name: "write", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: { path: path.join(root, "file"), content: "x" }, workspaceId: "ws_test" }), /does not grant write/);
assert.throws(() => manager.enqueue({ workerId: "wk_test_node", requestId: "req_no_workspace", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {} }), /workspace is required/);
const claimed = manager.claim("wk_test_node", 10000);
assert.strictEqual(claimed.jobId, job.jobId);
assert.strictEqual(manager.finish(job.jobId, "wk_test_node", claimed.leaseId, { content: [{ type: "text", text: "ok" }] }, { receiptId: "receipt_test", jobId: job.jobId, tool: "read", descriptorVersion: "1", descriptorIdentity: descriptorIdentity({ name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }) }).state, "completed");
assert.throws(() => manager.finish(job.jobId, "wk_test_node", claimed.leaseId, {}, {}), /lease/);
const orderedRetry = manager.enqueue({ workerId: "wk_test_node", requestId: "req_ordered", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: { path: path.join(root, "file"), options: { alpha: 1, beta: 2 } }, workspaceId: "ws_test", idempotencyKey: "idem_ordered" });
assert.strictEqual(manager.enqueue({ workerId: "wk_test_node", requestId: "req_reordered", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: { options: { beta: 2, alpha: 1 }, path: path.join(root, "file") }, workspaceId: "ws_test", idempotencyKey: "idem_ordered" }).jobId, orderedRetry.jobId, "object key ordering does not split the same logical retry");
const orderedRetryClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(orderedRetryClaim.jobId, orderedRetry.jobId);
manager.fail(orderedRetry.jobId, "wk_test_node", orderedRetryClaim.leaseId, "test_cleanup", "test cleanup");
const nodeAuthorization = { principalId: initiator.principal_id, permission: "tools.execute", credentialScopes: ["tools.execute"], resource: { tool: "read", source: "mcp" } };
const revokedInitiatorJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_revoked_initiator", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: { authIdentity: { principal_id: initiator.principal_id, credential_id: initiatorCredential.credential.credential_id, authentication_method: "scoped_credential" }, nodeAuthorization }, workspaceId: "ws_test" });
assert.strictEqual(authentication.revokeCredential(initiatorCredential.credential.credential_id, fixtureOwner), true);
assert.strictEqual(manager.claim("wk_test_node", 10000), null, "a queued remote job is not leased after its initiating credential is revoked");
assert.strictEqual(manager.getJob(revokedInitiatorJob.jobId).errorCode, "initiator_authority_revoked");
const activeInitiatorCredential = authentication.createCredential({ principalId: initiator.principal_id, displayName: "active synthetic test credential", scopes: ["tools.execute"], createdByPrincipalId: fixtureOwner.principal_id, actorContext: fixtureOwner });
const activeInitiatorJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_active_initiator", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: { authIdentity: { principal_id: initiator.principal_id, credential_id: activeInitiatorCredential.credential.credential_id, authentication_method: "scoped_credential" }, nodeAuthorization: { ...nodeAuthorization, credentialScopes: activeInitiatorCredential.credential.scopes } }, workspaceId: "ws_test" });
const activeInitiatorClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(activeInitiatorClaim.jobId, activeInitiatorJob.jobId, "a currently active initiating credential preserves authorized remote execution");
assert.strictEqual(authentication.revokeCredential(activeInitiatorCredential.credential.credential_id, fixtureOwner), true);
assert.strictEqual(manager.cancellation(activeInitiatorJob.jobId, "wk_test_node", activeInitiatorClaim.leaseId).requested, true, "an active remote operation is asked to cancel after its credential is revoked");
assert.strictEqual(manager.fail(activeInitiatorJob.jobId, "wk_test_node", activeInitiatorClaim.leaseId, "node_execution_cancelled", "authority revoked").state, "cancelled");
const roleCredential = authentication.createCredential({ principalId: initiator.principal_id, displayName: "role-revocation test credential", scopes: ["tools.execute"], createdByPrincipalId: fixtureOwner.principal_id, actorContext: fixtureOwner });
const revokedRoleJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_revoked_role", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: { authIdentity: { principal_id: initiator.principal_id, credential_id: roleCredential.credential.credential_id, authentication_method: "scoped_credential" }, nodeAuthorization: { ...nodeAuthorization, credentialScopes: roleCredential.credential.scopes } }, workspaceId: "ws_test" });
identity.removeRole(initiator.principal_id, "operator", fixtureOwner);
assert.strictEqual(manager.claim("wk_test_node", 10000), null, "a queued job is not leased after its initiating role grant is removed");
assert.strictEqual(manager.getJob(revokedRoleJob.jobId).errorCode, "initiator_authority_revoked");
identity.assignRole(initiator.principal_id, "operator", fixtureOwner);
const roleLeaseJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_role_revoked_during_execution", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: { authIdentity: { principal_id: initiator.principal_id, credential_id: roleCredential.credential.credential_id, authentication_method: "scoped_credential" }, nodeAuthorization: { ...nodeAuthorization, credentialScopes: roleCredential.credential.scopes } }, workspaceId: "ws_test" });
const roleLease = manager.claim("wk_test_node", 10000);
assert.strictEqual(roleLease.jobId, roleLeaseJob.jobId);
identity.removeRole(initiator.principal_id, "operator", fixtureOwner);
assert.throws(() => manager.renew(roleLeaseJob.jobId, "wk_test_node", roleLease.leaseId, 10000), /authority/);
assert.strictEqual(manager.cancellation(roleLeaseJob.jobId, "wk_test_node", roleLease.leaseId).requested, true, "a running remote operation is asked to cancel after its required role is removed");
assert.strictEqual(manager.fail(roleLeaseJob.jobId, "wk_test_node", roleLease.leaseId, "node_execution_cancelled", "authority revoked").state, "cancelled");
const revokedWorkspaceJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_revoked_workspace", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, workspaceId: "ws_test" });
db.prepare("UPDATE execution_node_workspaces SET permissions_json = ? WHERE workspace_id = ?").run(JSON.stringify({ read: false }), "ws_test");
assert.strictEqual(manager.claim("wk_test_node", 10000), null, "a queued job is not leased after its workspace read grant is removed");
assert.strictEqual(manager.getJob(revokedWorkspaceJob.jobId).errorCode, "execution_resource_authority_revoked");
db.prepare("UPDATE execution_node_workspaces SET permissions_json = ? WHERE workspace_id = ?").run(JSON.stringify({ read: true }), "ws_test");

identity.assignRole(initiator.principal_id, "operator", fixtureOwner);
const projectOwner = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "execution-node project owner" });
identity.assignRole(projectOwner.principal_id, "administrator", fixtureOwner);
const projectAccess = require("../src/core/project-access");
const platformKernel = require("../src/platform/kernel");
platformKernel.registerProject({ project_id: "node_project", owner_actor_id: projectOwner.principal_id });
projectAccess.grantProjectAccess({ actorPrincipalId: projectOwner.principal_id, principalId: initiator.principal_id, project: "node_project", accessLevel: "read" });
const projectCredential = authentication.createCredential({ principalId: initiator.principal_id, displayName: "project-scoped node test credential", scopes: ["tools.execute"], createdByPrincipalId: fixtureOwner.principal_id, actorContext: fixtureOwner });
const projectNodeContext = {
  authIdentity: { principal_id: initiator.principal_id, credential_id: projectCredential.credential.credential_id, authentication_method: "scoped_credential" },
  nodeAuthorization: { ...nodeAuthorization, credentialScopes: projectCredential.credential.scopes },
  project: "node_project",
};
const projectScopedJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_project_scoped", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: projectNodeContext, workspaceId: "ws_test" });
const projectScopedClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(projectScopedClaim.jobId, projectScopedJob.jobId, "current project membership preserves authorized remote execution");
assert.strictEqual(projectAccess.revokeProjectAccess({ actorPrincipalId: projectOwner.principal_id, principalId: initiator.principal_id, project: "node_project" }), true);
assert.strictEqual(manager.cancellation(projectScopedJob.jobId, "wk_test_node", projectScopedClaim.leaseId).requested, true, "revoked project membership requests cancellation of leased work");
assert.strictEqual(manager.fail(projectScopedJob.jobId, "wk_test_node", projectScopedClaim.leaseId, "node_execution_cancelled", "project membership revoked").state, "cancelled");
projectAccess.grantProjectAccess({ actorPrincipalId: projectOwner.principal_id, principalId: initiator.principal_id, project: "node_project", accessLevel: "read" });
const queuedProjectJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_project_revoked_before_claim", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: projectNodeContext, workspaceId: "ws_test" });
assert.strictEqual(projectAccess.revokeProjectAccess({ actorPrincipalId: projectOwner.principal_id, principalId: initiator.principal_id, project: "node_project" }), true);
assert.strictEqual(manager.claim("wk_test_node", 10000), null, "revoked project membership prevents a queued remote job from being leased");
assert.strictEqual(manager.getJob(queuedProjectJob.jobId).errorCode, "execution_resource_authority_revoked");
projectAccess.grantProjectAccess({ actorPrincipalId: projectOwner.principal_id, principalId: initiator.principal_id, project: "node_project", accessLevel: "read" });
const resultAfterRevocationJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_project_revoked_before_result", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: projectNodeContext, workspaceId: "ws_test" });
const resultAfterRevocationClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(resultAfterRevocationClaim.jobId, resultAfterRevocationJob.jobId);
assert.strictEqual(projectAccess.revokeProjectAccess({ actorPrincipalId: projectOwner.principal_id, principalId: initiator.principal_id, project: "node_project" }), true);
assert.throws(() => manager.finish(resultAfterRevocationJob.jobId, "wk_test_node", resultAfterRevocationClaim.leaseId, { content: [{ type: "text", text: "synthetic protected result" }] }, { receiptId: "receipt_revoked_project", jobId: resultAfterRevocationJob.jobId, tool: "read", descriptorVersion: "1", descriptorIdentity: descriptorIdentity({ name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }) }), /result was not published/);
assert.strictEqual(manager.getJob(resultAfterRevocationJob.jobId).result, null, "a worker that skips polling cannot publish a result after project access revocation");
assert.strictEqual(manager.getJob(resultAfterRevocationJob.jobId).cancellationRequested, true);
assert.strictEqual(manager.fail(resultAfterRevocationJob.jobId, "wk_test_node", resultAfterRevocationClaim.leaseId, "node_execution_cancelled", "project membership revoked").state, "cancelled");

const approvalDocument = require("../src/db");
const approvalLease = { id: "approval_node_active", status: "executing", operation_id: "operation_node_active", lease_expires_at: new Date(Date.now() + 60_000).toISOString() };
approvalDocument.setDocument("approvals", [approvalLease]);
const approvedNodeJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_approved_node", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: { approvedExecution: true, approvalId: approvalLease.id, operationId: approvalLease.operation_id }, workspaceId: "ws_test" });
const approvedNodeClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(approvedNodeClaim.jobId, approvedNodeJob.jobId, "a current approval execution lease preserves remote execution");
approvalDocument.setDocument("approvals", [{ ...approvalLease, status: "rejected" }]);
assert.strictEqual(manager.cancellation(approvedNodeJob.jobId, "wk_test_node", approvedNodeClaim.leaseId).requested, true, "a leased remote operation is cancelled after its approval is revoked");
assert.strictEqual(manager.fail(approvedNodeJob.jobId, "wk_test_node", approvedNodeClaim.leaseId, "node_execution_cancelled", "approval revoked").state, "cancelled");
const staleApproval = { id: "approval_node_stale", status: "executing", operation_id: "operation_node_stale", lease_expires_at: new Date(Date.now() - 1000).toISOString() };
approvalDocument.setDocument("approvals", [staleApproval]);
const staleApprovedNodeJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_stale_approved_node", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: { approvedExecution: true, approvalId: staleApproval.id, operationId: staleApproval.operation_id }, workspaceId: "ws_test" });
assert.strictEqual(manager.claim("wk_test_node", 10000), null, "an expired approval lease cannot authorize a queued remote job");
assert.strictEqual(manager.getJob(staleApprovedNodeJob.jobId).errorCode, "approval_authority_revoked");
approvalDocument.setDocument("approvals", []);

const approvalStore = require("../src/approvals/store");
approvalStore.ensureApprovalContinuationSchema();
const durableApprovalId = "approval_node_durable";
const durableTaskId = "task_node_durable_approval";
const durableApprovalOperationId = "operation_node_durable";
const durableLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
db.prepare(`INSERT INTO task_checkpoints
  (task_id, state, goal_encrypted, plan_version, plan_encrypted, plan_digest, current_approval_id, current_step_id, current_args_digest, current_idempotency_key, claimed_by, lease_expires_at, created_at, updated_at)
  VALUES (?, 'running', 'synthetic', '1', 'synthetic', 'digest', ?, 'step_node', 'args_digest', 'idem_node', 'runner_node', ?, ?, ?)`)
  .run(durableTaskId, durableApprovalId, durableLeaseExpiresAt, new Date().toISOString(), new Date().toISOString());
db.prepare(`INSERT INTO approvals
  (approval_id, status, tool_name, risk, source, task_id, step_id, plan_version, args_digest, idempotency_key, requested_at, expires_at, updated_at, operation_id)
  VALUES (?, 'executing', 'read', 'medium', 'test', ?, 'step_node', '1', 'args_digest', 'idem_node', ?, ?, ?, ?)`)
  .run(durableApprovalId, durableTaskId, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), durableApprovalOperationId);
const durableApprovedNodeJob = manager.enqueue({ workerId: "wk_test_node", requestId: "req_durable_approved_node", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, context: { approvedExecution: true, approvalId: durableApprovalId, operationId: durableApprovalOperationId }, workspaceId: "ws_test" });
const durableApprovedNodeClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(durableApprovedNodeClaim.jobId, durableApprovedNodeJob.jobId, "a running durable task checkpoint's live lease authorizes remote claim");
db.prepare("UPDATE task_checkpoints SET lease_expires_at = ? WHERE task_id = ?").run(new Date(Date.now() - 1000).toISOString(), durableTaskId);
assert.strictEqual(manager.cancellation(durableApprovedNodeJob.jobId, "wk_test_node", durableApprovedNodeClaim.leaseId).requested, true, "expired durable task lease requests cancellation during remote execution");
assert.strictEqual(manager.fail(durableApprovedNodeJob.jobId, "wk_test_node", durableApprovedNodeClaim.leaseId, "node_execution_cancelled", "task lease expired").state, "cancelled");

const pendingAfterDisable = manager.enqueue({ workerId: "wk_test_node", requestId: "req_disable", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, workspaceId: "ws_test" });
db.prepare("UPDATE compute_workers SET admin_state = 'maintenance' WHERE worker_id = ?").run("wk_test_node");
assert.strictEqual(manager.claim("wk_test_node", 10000), null, "a disabled node cannot claim work queued before disable");
db.prepare("UPDATE compute_workers SET admin_state = 'enabled', credential_state = 'revoked' WHERE worker_id = ?").run("wk_test_node");
assert.strictEqual(manager.claim("wk_test_node", 10000), null, "a revoked node cannot claim queued work");
db.prepare("UPDATE compute_workers SET credential_state = 'active' WHERE worker_id = ?").run("wk_test_node");
const afterReenable = manager.claim("wk_test_node", 10000);
assert.strictEqual(afterReenable.jobId, pendingAfterDisable.jobId, "eligible node can claim after explicit re-enable");
manager.fail(afterReenable.jobId, "wk_test_node", afterReenable.leaseId, "test_cleanup", "test cleanup");

const cancellable = manager.enqueue({ workerId: "wk_test_node", requestId: "req_cancel", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, workspaceId: "ws_test" });
const cancellableClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(cancellableClaim.jobId, cancellable.jobId);
assert.strictEqual(manager.renew(cancellable.jobId, "wk_test_node", cancellableClaim.leaseId, 10000).jobId, cancellable.jobId);
assert.strictEqual(manager.requestCancel(cancellable.jobId).cancellationRequested, true);
assert.strictEqual(manager.cancellation(cancellable.jobId, "wk_test_node", cancellableClaim.leaseId).requested, true);
assert.throws(() => manager.finish(cancellable.jobId, "wk_test_node", cancellableClaim.leaseId, {}, {}), /lease/);
assert.strictEqual(manager.fail(cancellable.jobId, "wk_test_node", cancellableClaim.leaseId, "node_execution_cancelled", "cancelled").state, "cancelled");

const expiring = manager.enqueue({ workerId: "wk_test_node", requestId: "req_expired", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, workspaceId: "ws_test" });
const expiringClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(expiringClaim.jobId, expiring.jobId);
db.prepare("UPDATE execution_node_jobs SET lease_expires_at = ? WHERE job_id = ?").run("2000-01-01T00:00:00.000Z", expiring.jobId);
assert.throws(() => manager.renew(expiring.jobId, "wk_test_node", expiringClaim.leaseId, 10000), /lease/);
assert.throws(() => manager.finish(expiring.jobId, "wk_test_node", expiringClaim.leaseId, {}, {}), /lease/);
assert.throws(() => manager.fail(expiring.jobId, "wk_test_node", expiringClaim.leaseId, "late_failure", "expired"), /lease/);
assert.ok(manager.recoverExpired() >= 1, "background recovery requeues the expired job");
assert.strictEqual(manager.getJob(expiring.jobId).state, "queued");
const recoveredClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(recoveredClaim.jobId, expiring.jobId);
assert.notStrictEqual(recoveredClaim.leaseId, expiringClaim.leaseId, "recovery issues a new lease token");
manager.fail(recoveredClaim.jobId, "wk_test_node", recoveredClaim.leaseId, "test_cleanup", "test cleanup");

const cancelledExpired = manager.enqueue({ workerId: "wk_test_node", requestId: "req_cancel_expired", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, workspaceId: "ws_test" });
const cancelledExpiredClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(cancelledExpiredClaim.jobId, cancelledExpired.jobId);
manager.requestCancel(cancelledExpired.jobId);
db.prepare("UPDATE execution_node_jobs SET lease_expires_at = ? WHERE job_id = ?").run("2000-01-01T00:00:00.000Z", cancelledExpired.jobId);
assert.ok(manager.recoverExpired() >= 1, "recovery closes cancelled expired leases");
assert.strictEqual(manager.getJob(cancelledExpired.jobId).state, "cancelled", "cancelled work is not requeued");

const beforeRemoteOnly = db.prepare("SELECT COUNT(*) AS count FROM execution_node_jobs").get().count;
maybeExecute(descriptor, { path: path.join(outside, "remote-only-repository", "nested", "file.txt") }, { timeoutMs: 50 }).then(remoteOnly => {
  assert.strictEqual(remoteOnly.code, "node_path_visibility_unverified");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM execution_node_jobs").get().count, beforeRemoteOnly);
  const beforeUnauthorizedRemoteWrite = db.prepare("SELECT COUNT(*) AS count FROM execution_node_jobs").get().count;
  return maybeExecute({ name: "write", placement: { nodeSafe: true, locations: ["node"] } }, { path: path.join(root, "not-created-by-test"), content: "synthetic" }, { timeoutMs: 50 }).then(unauthorizedWrite => {
    assert.strictEqual(unauthorizedWrite, null, "a server-visible destination stays on Core when no remote write workspace is authorized");
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM execution_node_jobs").get().count, beforeUnauthorizedRemoteWrite);
    assert.strictEqual(fs.existsSync(path.join(root, "not-created-by-test")), false);
    try { require("../src/db").closeDatabase?.(); } catch {}
    fs.rmSync(fixture, { recursive: true, force: true });
    console.log("Execution node tests passed");
  });
}).catch(error => {
  try { require("../src/db").closeDatabase?.(); } catch {}
  fs.rmSync(fixture, { recursive: true, force: true });
  throw error;
});
