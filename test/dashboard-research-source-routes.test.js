"use strict";

const assert = require("assert");
const { registerResearchSourceRoutes } = require("../src/dashboard/research-source-routes");

const routes = {};
const calls = [];
const app = {
  get(path, handler) { routes[`GET ${path}`] = handler; },
  post(path, handler) { routes[`POST ${path}`] = handler; },
};

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function request(overrides = {}) {
  return { originalUrl: "/api/research/source/test", headers: {}, query: {}, body: {}, params: {}, user: "operator", ...overrides };
}

const dispatcher = async (tool, args) => {
  calls.push({ tool, args });
  if (tool === "research_status") return { content: [{ text: JSON.stringify({ ok: true, pack: "security-research", ready: true, workspace: { state: "configured", root: "/secret/workspace", source: "config" }, capabilities: { present_on_server: { bash: true }, dispatchable_by_pack: { bash: true } }, policy: { local_probes_enabled: false, http_allowed_hosts: 2 }, environments: ["prod-secret"] }) }] };
  if (args.action === "get") return { content: [{ text: JSON.stringify({ ok: true, repository: { repository_id: "repo_1", campaign_id: "campaign_1", project_id: "project_1", name: "Example", state: "active", metadata: { credential_url: "https://user:pass@example.test" } }, snapshot: { snapshot_id: "snap_1", repository_id: "repo_1", campaign_id: "campaign_1", state: "finalized", storage_ref: "projects/campaign_1/sources/repo_1/snap_1", authority: "derived_analysis_input", verification: { verified: true }, metadata: { content: "must not appear", commit: "0123456789abcdef" } } }) }] };
  if (args.action === "remove") return { content: [{ text: JSON.stringify({ ok: true, snapshot: { snapshot_id: "snap_1", storage_ref: "projects/campaign_1/sources/repo_1/snap_1", metadata: { content: "hidden" } }, storage_removed: true }) }] };
  if (args.action === "index") return { content: [{ text: JSON.stringify({ ok: true, verification: { verified: true }, index: { projection: "raw semantic JSON must not appear" }, provenance: { snapshot_id: "snap_1", storage_ref: "/secret/workspace/projects/..." } }) }] };
  return { content: [{ text: JSON.stringify({ ok: true, repositories: [{ repository_id: "repo_1", campaign_id: "campaign_1", name: "Example", state: "active" }], snapshots: [] }) }] };
};

registerResearchSourceRoutes({
  app,
  callDashboardTool: dispatcher,
  dashboardExecutionMetadata: () => ({ actor: "operator" }),
  authenticatedUser: req => req.user || null,
  auditLog: () => {},
  logError: () => {},
});

(async () => {
  let res = response();
  await routes["GET /api/research/source/readiness"](request(), res);
  assert.strictEqual(res.body.readiness.workspace.root, undefined);
  assert.strictEqual(res.body.readiness.environment_count, 1);
  assert.ok(!JSON.stringify(res.body).includes("/secret"));
  assert.ok(!JSON.stringify(res.body).includes("prod-secret"));

  res = response();
  await routes["GET /api/research/source/snapshots/:snapshotId"](request({ params: { snapshotId: "snap_1" }, query: { repository_id: "repo_1" } }), res);
  assert.strictEqual(res.body.snapshot.workspace_ref, "projects/campaign_1/sources/repo_1/snap_1");
  assert.strictEqual(res.body.snapshot.metadata.content, undefined);
  assert.strictEqual(res.body.snapshot.metadata.commit, "0123456789ab");
  assert.ok(!JSON.stringify(res.body).includes("credential_url"));

  res = response();
  await routes["POST /api/research/source/actions/:action"](request({ params: { action: "remove" }, user: "operator", body: { repository_id: "repo_1", snapshot_id: "snap_1" } }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, "confirmation_required");

  res = response();
  await routes["POST /api/research/source/actions/:action"](request({ params: { action: "index" }, user: "operator", body: { repository_id: "repo_1", snapshot_id: "snap_1" } }), res);
  assert.strictEqual(res.body.indexed, true);
  assert.strictEqual(res.body.index, undefined);
  assert.ok(!JSON.stringify(res.body).includes("/secret"));
  assert.strictEqual(calls.at(-1).tool, "research_source");

  console.log("Dashboard research source route tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
