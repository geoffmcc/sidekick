"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-escalation-review-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_API_KEY = "synthetic-escalation-test-api-key";
process.env.SIDEKICK_AGENT_PROXY_KEY = "synthetic-escalation-test-proxy-key";
process.env.GROQ_API_KEY = "synthetic-test-key";

const dbStore = require("../src/db");
const identity = require("../src/core/identity");
const projectAccess = require("../src/core/project-access");
const { createTask } = require("../src/agent/task-model");
const taskStore = require("../src/agent/task-store");
const durableOperations = require("../src/agent/durable-operations");
const { createAgentProxyHeaders } = require("../src/security/agent-proxy-auth");
const { registerAgentProxyRoutes } = require("../src/dashboard/agent-proxy-routes");
const { createOwnerContext } = require("./helpers/authorized-context");
const agent = require("../src/agent");

const ownerContext = createOwnerContext({ project: "escalation_review_test" });
const project = ownerContext.project;
const task = createTask({
  task_id: "c0ffee01",
  objective: "Review escalation authorization",
  profile: "standard",
  project_id: project,
  actor_principal_id: ownerContext.authIdentity.principal_id,
  requested_by_principal_id: ownerContext.authIdentity.principal_id,
});
taskStore.insertTask(task);
const escalation = durableOperations.createEscalation({
  task_id: task.task_id,
  requested_operation: "Inspect the ambiguous operation outcome",
  reason: "The operation result could not be confirmed",
  target_ref: "resource:review-test",
  risk_class: "high",
  effect_class: "external",
});

const reviewer = identity.createPrincipal({ type: "human", displayName: "Synthetic escalation reviewer" });
identity.assignRole(reviewer.principal_id, "administrator", ownerContext.authIdentity.principal_id);
projectAccess.grantProjectAccess({
  actorPrincipalId: ownerContext.authIdentity.principal_id,
  principalId: reviewer.principal_id,
  project,
  accessLevel: "read",
});

let server;
let port;
function request(method, route, body, principalId, scopes) {
  const serialized = body === undefined ? "" : JSON.stringify(body);
  const headers = createAgentProxyHeaders({
    secret: process.env.SIDEKICK_AGENT_PROXY_KEY,
    method,
    path: route,
    body: serialized,
    principalId,
    scopes,
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: route, method, agent: false,
      headers: { ...headers, ...(serialized ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(serialized) } : {}) },
    }, res => {
      let response = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { response += chunk; });
      res.on("end", () => {
        let data = response;
        try { data = JSON.parse(response); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    if (serialized) req.write(serialized);
    req.end();
  });
}

test.before(async () => {
  server = agent.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  port = server.address().port;
});

test("authorized independent project reviewer can decide an escalation without inheriting task authority", async () => {
  const reviewerScopes = ["agent.tasks.read", "approvals.grant"];
  const { canReviewUnownedTask } = require("../src/agent/task-access");
  assert.ok(taskStore.getTask(task.task_id), "fixture task was persisted in the Agent store");
  assert.equal(canReviewUnownedTask({ principal_id: reviewer.principal_id, scopes: reviewerScopes }, task), true, JSON.stringify({ reviewer: identity.getPrincipal(reviewer.principal_id), task }));
  const taskRoute = `/api/agent/tasks/${task.task_id}`;
  const controlRoom = await request("GET", `${taskRoute}/control-room`, undefined, reviewer.principal_id, reviewerScopes);
  assert.equal(controlRoom.status, 200, `project-authorized approver can inspect the task escalation: ${JSON.stringify(controlRoom.data)}`);
  assert.ok(controlRoom.data.escalations.some(item => item.escalation_id === escalation.escalation_id));

  const listed = await request("GET", "/api/agent/tasks", undefined, reviewer.principal_id, reviewerScopes);
  assert.ok(listed.data.tasks.some(item => item.task_id === task.task_id), "reviewer task list includes reviewable project tasks");

  const decisionRoute = `${taskRoute}/escalations/${escalation.escalation_id}/decision`;
  const borrowedReference = await request("POST", decisionRoute, {
    decision: "approved", approval_ref: "approval:unrelated-tool-action",
  }, reviewer.principal_id, reviewerScopes);
  assert.equal(borrowedReference.status, 400, "caller-supplied unrelated approval references are rejected");

  const selfApproval = await request("POST", decisionRoute, { decision: "approved" }, ownerContext.authIdentity.principal_id, reviewerScopes);
  assert.equal(selfApproval.status, 403, "the task requester cannot self-approve");

  const approved = await request("POST", decisionRoute, { decision: "approved", reason: "Reviewed this escalation" }, reviewer.principal_id, reviewerScopes);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.escalation.state, "approved");
  assert.equal(approved.data.escalation.decided_by_principal_id, `principal:${reviewer.principal_id}`);
  assert.equal(approved.data.escalation.approval_ref, `approval:escalation:${escalation.escalation_id}`);
  const replayedDecision = await request("POST", decisionRoute, { decision: "denied", reason: "attempt to replace the closed decision" }, reviewer.principal_id, reviewerScopes);
  assert.equal(replayedDecision.status, 409, "a later decision cannot overwrite a closed escalation");
  assert.equal(durableOperations.getEscalation(escalation.escalation_id).state, "approved", "the original approved state remains authoritative");

  const viewer = identity.createPrincipal({ type: "human", displayName: "Synthetic non-reviewer" });
  identity.assignRole(viewer.principal_id, "viewer", ownerContext.authIdentity.principal_id);
  const denied = await request("GET", `${taskRoute}/control-room`, undefined, viewer.principal_id, ["agent.tasks.read"]);
  assert.equal(denied.status, 404, "project outsiders without approval authority cannot inspect the task");
});

test("Dashboard exposes only the signed escalation decision relay", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/dashboard/agent-proxy-routes.js"), "utf8");
  assert.match(source, /app\.post\("\/api\/agent\/tasks\/:taskId\/escalations\/:escalationId\/decision", relay\("POST", true\)\)/);
});

test("Dashboard Agent relay preserves independent reviewer identity for escalation decisions", async () => {
  const relayApp = express();
  relayApp.use(express.json());
  relayApp.use((req, _res, next) => {
    req.authPrincipal = { principal_id: reviewer.principal_id, scopes: ["agent.tasks.read", "approvals.grant"] };
    next();
  });
  registerAgentProxyRoutes({
    app: relayApp,
    http,
    agentPort: port,
    agentProxySecret: process.env.SIDEKICK_AGENT_PROXY_KEY,
    errorResponse(_req, res, error) { res.status(502).json({ error: error.message }); },
  });
  const relay = relayApp.listen(0, "127.0.0.1");
  await new Promise(resolve => relay.once("listening", resolve));
  try {
    const proxyTask = createTask({
      task_id: "c0ffee02",
      objective: "Review escalation through Dashboard proxy",
      profile: "standard",
      project_id: project,
      actor_principal_id: ownerContext.authIdentity.principal_id,
      requested_by_principal_id: ownerContext.authIdentity.principal_id,
    });
    taskStore.insertTask(proxyTask);
    const proxyEscalation = durableOperations.createEscalation({
      task_id: proxyTask.task_id,
      requested_operation: "Restart the isolated test service",
      reason: "An independent reviewer must decide",
      target_ref: "resource:proxy-review-test",
      risk_class: "medium",
      effect_class: "reversible",
    });
    const route = `/api/agent/tasks/${proxyTask.task_id}/escalations/${proxyEscalation.escalation_id}/decision`;
    const response = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ decision: "approved", reason: "Reviewed through Dashboard proxy" });
      const req = http.request({ hostname: "127.0.0.1", port: relay.address().port, path: route, method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.escalation.decided_by_principal_id, `principal:${reviewer.principal_id}`);
    assert.equal(response.data.escalation.approval_ref, `approval:escalation:${proxyEscalation.escalation_id}`);
  } finally {
    await new Promise(resolve => relay.close(resolve));
  }
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  dbStore.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
