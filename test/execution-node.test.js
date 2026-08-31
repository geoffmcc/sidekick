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
assert.strictEqual(placement.checkEligibility(descriptor, { nodeId: "node_b", platform: "windows", protocolVersion: "1", workspaces: ["security-research"], authorized: true, healthy: true }).eligible, false);
assert.strictEqual(placement.checkEligibility({ ...descriptor, placement: { ...descriptor.placement, nodeSafe: false } }, { platform: "linux", protocolVersion: "1", workspaces: ["security-research"] }).eligible, false);

process.env.SIDEKICK_DATA_DIR = path.join(fixture, "data");
process.env.SIDEKICK_SECRET_KEY = "execution-node-test-secret-key";
const manager = require("../src/node/manager");
const { maybeExecute } = require("../src/node/dispatch");
manager.ensureSchema();
const db = require("../src/db").getDb();
db.prepare("INSERT INTO compute_workers (worker_id, node_id, display_name, platform, state, connection_state, credential_state) VALUES (?, ?, ?, ?, 'online', 'online', 'active')").run("wk_test_node", "node_test", "test", "linux");
manager.register("wk_test_node", { descriptorSetHash: "hash", capabilities: { workspaces: ["security-research"] } });
manager.authorizeWorkspace("wk_test_node", { workspaceId: "ws_test", name: "security-research", rootIdentity: configured.rootIdentity, permissions: { read: true } });
const job = manager.enqueue({ workerId: "wk_test_node", requestId: "req_test", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: { path: path.join(root, "file") }, idempotencyKey: "idem_test" });
assert.strictEqual(manager.enqueue({ workerId: "wk_test_node", requestId: "req_other", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {}, idempotencyKey: "idem_test" }).jobId, job.jobId);
const claimed = manager.claim("wk_test_node", 10000);
assert.strictEqual(claimed.jobId, job.jobId);
assert.strictEqual(manager.finish(job.jobId, "wk_test_node", claimed.leaseId, { content: [{ type: "text", text: "ok" }] }, { receiptId: "receipt_test", jobId: job.jobId, tool: "read", descriptorVersion: "1", descriptorIdentity: descriptorIdentity({ name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }) }).state, "completed");
assert.throws(() => manager.finish(job.jobId, "wk_test_node", claimed.leaseId, {}, {}), /lease/);

const cancellable = manager.enqueue({ workerId: "wk_test_node", requestId: "req_cancel", toolName: "read", descriptor: { name: "read", version: "1", placement: { nodeSafe: true, locations: ["node"] } }, args: {} });
const cancellableClaim = manager.claim("wk_test_node", 10000);
assert.strictEqual(cancellableClaim.jobId, cancellable.jobId);
assert.strictEqual(manager.renew(cancellable.jobId, "wk_test_node", cancellableClaim.leaseId, 10000).jobId, cancellable.jobId);
assert.strictEqual(manager.requestCancel(cancellable.jobId).cancellationRequested, true);
assert.strictEqual(manager.cancellation(cancellable.jobId, "wk_test_node", cancellableClaim.leaseId).requested, true);
assert.throws(() => manager.finish(cancellable.jobId, "wk_test_node", cancellableClaim.leaseId, {}, {}), /lease/);
assert.strictEqual(manager.fail(cancellable.jobId, "wk_test_node", cancellableClaim.leaseId, "node_execution_cancelled", "cancelled").state, "cancelled");

const beforeRemoteOnly = db.prepare("SELECT COUNT(*) AS count FROM execution_node_jobs").get().count;
maybeExecute(descriptor, { path: path.join(outside, "remote-only-repository") }, { timeoutMs: 50 }).then(remoteOnly => {
  assert.strictEqual(remoteOnly.code, "node_path_visibility_unverified");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM execution_node_jobs").get().count, beforeRemoteOnly);
  try { require("../src/db").closeDatabase?.(); } catch {}
  fs.rmSync(fixture, { recursive: true, force: true });
  console.log("Execution node tests passed");
}).catch(error => {
  try { require("../src/db").closeDatabase?.(); } catch {}
  fs.rmSync(fixture, { recursive: true, force: true });
  throw error;
});
