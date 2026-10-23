"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-compute-admin-security-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");
const authorization = require("../src/core/authorization");
const express = require("express");
const { registerComputeAdminRoutes } = require("../src/compute/admin-api");
const jobManager = require("../src/compute/job-manager");

const owner = identity.bootstrapOwner({ username: "compute_admin_test_owner", password: "synthetic compute test password" });
const ownerContext = { principal_id: owner.principal_id };
const ownerCredential = authentication.createCredential({
  principalId: owner.principal_id,
  displayName: "synthetic compute owner credential",
  scopes: ["compute.nodes.read", "compute.nodes.manage", "compute.jobs.read", "compute.jobs.create", "compute.jobs.cancel", "compute.jobs.manage", "compute.jobs.recover"],
  createdByPrincipalId: owner.principal_id,
  actorContext: ownerContext,
});
const administrator = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "compute admin test administrator", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
identity.assignRole(administrator.principal_id, "administrator", owner);
const adminCredential = authentication.createCredential({
  principalId: administrator.principal_id,
  displayName: "synthetic compute administrator credential",
  scopes: ["compute.nodes.read", "compute.nodes.manage", "compute.jobs.read", "compute.jobs.create", "compute.jobs.cancel", "compute.jobs.manage", "compute.jobs.recover"],
  createdByPrincipalId: owner.principal_id,
  actorContext: ownerContext,
});
const member = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "compute project member", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
identity.assignRole(member.principal_id, "administrator", owner);
const memberCredential = authentication.createCredential({
  principalId: member.principal_id,
  displayName: "synthetic project member credential",
  scopes: ["compute.nodes.read", "compute.nodes.manage", "compute.jobs.read", "compute.jobs.create", "compute.jobs.cancel", "compute.jobs.manage"],
  createdByPrincipalId: owner.principal_id,
  actorContext: ownerContext,
});
const operator = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "compute admin test operator", createdByPrincipalId: owner.principal_id, actorPrincipalId: owner.principal_id });
identity.assignRole(operator.principal_id, "operator", owner);
const operatorCredential = authentication.createCredential({
  principalId: operator.principal_id,
  displayName: "synthetic compute operator credential",
  scopes: ["compute.nodes.manage", "compute.jobs.create", "compute.jobs.recover"],
  createdByPrincipalId: owner.principal_id,
  actorContext: ownerContext,
});

const calls = new Map();
function called(name) { calls.set(name, (calls.get(name) || 0) + 1); }
function handler(name, body) { return (_req, res) => { called(name); res.json({ ok: true, ...body }); }; }
const job = { jobId: "job_scoped", project: "project-visible" };
const compute = {
  jobManager: {
    getJob: jobId => jobId === job.jobId ? job : null,
  },
};
const projectAccess = {
  hasGlobalProjectAccess: principalId => principalId === owner.principal_id,
  hasProjectMembership: (principalId, project, access) => principalId === member.principal_id
    && project === "project-visible"
    && ["read", "write"].includes(access),
};
const platformKernel = { getProject: project => project === "project-visible" || project === "other-active-project" ? { project_id: project, state: "active" } : null };
const handlers = {
  listWorkers: handler("listWorkers", { workers: [] }),
  getWorker: handler("getWorker", { worker: { workerId: "worker-1" } }),
  disableWorker: handler("disableWorker", { worker: { workerId: "worker-1" } }),
  enableWorker: handler("enableWorker", { worker: { workerId: "worker-1" } }),
  revokeWorker: handler("revokeWorker", { worker: { workerId: "worker-1" } }),
  rotateWorkerCredential: handler("rotateWorkerCredential", { worker: { workerId: "worker-1" }, credential: { token: "synthetic-secret" } }),
  createJob: (req, res) => {
    called("createJob");
    dbStore.getDb().prepare("INSERT INTO security_compute_admin_mutation_probe (marker) VALUES (?)").run("created");
    res.json({ ok: true, job: { jobId: "job_created", project: req.body.project || null } });
  },
  listJobs: handler("listJobs", { jobs: [] }),
  getJob: handler("getJob", { job }),
  cancelJob: handler("cancelJob", { job }),
  retryJob: handler("retryJob", { job }),
  recoverJobs: handler("recoverJobs", { recovered: 1 }),
  health: handler("health", { overview: {} }),
  createEnrollmentToken: handler("createEnrollmentToken", { tokenId: "token-1" }),
};
dbStore.getDb().exec("CREATE TABLE security_compute_admin_mutation_probe (marker TEXT NOT NULL)");

const app = express();
const auditIdentity = { recordAuditEvent: (...args) => identity.recordAuditEvent(...args) };
registerComputeAdminRoutes({ app, express, authentication, authorization, identity: auditIdentity, dbStore, projectAccess, platformKernel, compute, handlers });
let server;
let baseUrl;
after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(route, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("Compute admin aliases enforce identity, operation permission, project scope, and actor audit", async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await request("/compute/admin/workers")).status, 401);
  assert.equal((await request("/compute/admin/workers", { token: "installation-wide-api-key-placeholder" })).status, 401);
  assert.equal((await request("/compute/admin/workers/worker-1/disable", { token: operatorCredential.token, method: "POST", body: {} })).status, 403);
  assert.equal(calls.get("disableWorker") || 0, 0, "underprivileged identity is denied before the mutation handler");

  assert.equal((await request("/compute/admin/workers/worker-1/disable", { token: adminCredential.token, method: "POST", body: {} })).status, 200);
  const workerAudit = dbStore.getDb().prepare("SELECT actor_principal_id, details_json FROM identity_audit_events WHERE event_type='compute.admin.mutation' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(workerAudit.actor_principal_id, administrator.principal_id);
  assert.match(workerAudit.details_json, /worker-1/);

  assert.equal((await request("/compute/admin/jobs/job_scoped", { token: adminCredential.token })).status, 404, "job details outside active project grants are concealed");
  assert.equal(calls.get("getJob") || 0, 0, "cross-project request is denied before handler dispatch");
  assert.equal((await request("/compute/admin/jobs/job_scoped", { token: memberCredential.token })).status, 200);
  assert.equal((await request("/compute/jobs/job_scoped", { token: memberCredential.token })).status, 200, "legacy job detail alias retains the same scope enforcement");
  const readAudit = dbStore.getDb().prepare("SELECT actor_principal_id FROM identity_audit_events WHERE event_type='compute.admin.read' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(readAudit.actor_principal_id, member.principal_id, "sensitive Compute reads are attributable too");

  assert.equal((await request("/compute/jobs", { token: adminCredential.token })).status, 400, "unscoped job listing requires global project access or an explicit project");
  assert.equal((await request("/compute/jobs", { token: memberCredential.token })).status, 400);
  assert.equal((await request("/compute/jobs?project=project-visible", { token: memberCredential.token })).status, 200);
  assert.equal((await request("/compute/admin/jobs", { token: memberCredential.token, method: "POST", body: { jobType: "generate", project: "other-active-project" } })).status, 404);
  assert.equal((await request("/compute/jobs", { token: memberCredential.token, method: "POST", body: { jobType: "generate", project: "project-visible" } })).status, 200);
  assert.equal((await request("/compute/admin/jobs", { token: adminCredential.token, method: "POST", body: { jobType: "generate" } })).status, 400, "even administrators need global project authority for projectless creation");

  assert.equal((await request("/compute/admin/jobs/job_scoped/cancel", { token: memberCredential.token, method: "POST", body: {} })).status, 200);
  assert.equal((await request("/compute/jobs/job_scoped/retry", { token: memberCredential.token, method: "POST", body: {} })).status, 200);
  assert.equal((await request("/compute/admin/recover", { token: adminCredential.token, method: "POST", body: {} })).status, 403, "global lease recovery is owner-only");
  assert.equal((await request("/compute/recover", { token: ownerCredential.token, method: "POST", body: {} })).status, 200);
  assert.equal((await request("/compute/admin/health", { token: memberCredential.token })).status, 200);
  assert.equal((await request("/compute/health", { token: memberCredential.token })).status, 200, "compatibility health alias uses the same permission checks");

  const priorAudit = auditIdentity.recordAuditEvent;
  auditIdentity.recordAuditEvent = () => { throw new Error("synthetic audit sink failure"); };
  try {
    const mutationsBeforeAuditFailure = dbStore.getDb().prepare("SELECT COUNT(*) AS count FROM security_compute_admin_mutation_probe").get().count;
    const response = await request("/compute/admin/jobs", { token: ownerCredential.token, method: "POST", body: { jobType: "generate" } });
    assert.equal(response.status, 500);
    assert.equal(dbStore.getDb().prepare("SELECT COUNT(*) AS count FROM security_compute_admin_mutation_probe").get().count, mutationsBeforeAuditFailure, "audit failure rolls back the synchronous mutation transaction");
  } finally { auditIdentity.recordAuditEvent = priorAudit; }
});

test("lease recovery rolls back when its attributable audit callback fails", () => {
  const created = jobManager.createJob({ jobType: "chat", capability: "chat", source: "security-test", requestPayload: { prompt: "synthetic" } });
  dbStore.getDb().prepare("UPDATE compute_jobs SET status='leased', lease_id=?, lease_expires_at=?, attempt=1 WHERE job_id=?")
    .run("lease_security_test", new Date(Date.now() - 60_000).toISOString(), created.jobId);
  assert.throws(() => jobManager.recoverExpiredLeases({ onRecovered() { throw new Error("synthetic audit failure"); } }), /synthetic audit failure/);
  assert.equal(jobManager.getJob(created.jobId).status, "leased", "failed audit leaves the job recovery unapplied");
  assert.equal(jobManager.recoverExpiredLeases({ onRecovered: event => identity.recordAuditEvent("compute.admin.mutation", owner.principal_id, owner.principal_id, event) }), 1);
  assert.equal(jobManager.getJob(created.jobId).status, "retry_wait");
});
