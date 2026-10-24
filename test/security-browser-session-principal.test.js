"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-browser-principal-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "synthetic-browser-principal-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_BROWSER_ENABLED = "true";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const platformKernel = require("../src/platform/kernel");
const projectAccess = require("../src/core/project-access");
const tools = require("../src/tools");
const browserDriver = require("../src/browser/driver");
const browserEgress = require("../src/browser/egress");
const browserSessions = require("../src/browser/sessions");

test("browser sessions are principal-owned and project access is rechecked on reads and close", async t => {
  const { createOwnerContext } = require("./helpers/authorized-context");
  const ownerContext = createOwnerContext({ source: "mcp" });
  const owner = identity.getPrincipal(ownerContext.authIdentity.principal_id);
  const project = "browser_session_scope";
  platformKernel.registerProject({ project_id: project, owner_actor_id: owner.principal_id, source: "test" });
  const peer = require("./helpers/authorized-identity").createPrincipal(identity, {
    type: "service",
    displayName: "Browser session peer",
    actorPrincipalId: owner.principal_id,
  });
  identity.assignRole(peer.principal_id, "operator", owner);
  identity.grantPrincipalPermission(peer.principal_id, "tools.execute_high", owner);
  projectAccess.grantProjectAccess({
    actorPrincipalId: owner.principal_id,
    principalId: peer.principal_id,
    project,
    accessLevel: "read",
  });

  const original = {
    getBrowser: browserDriver.getBrowser,
    closeBrowser: browserDriver.closeBrowser,
    createSessionProxy: browserEgress.createSessionProxy,
  };
  const fakePage = new EventEmitter();
  fakePage.close = async () => {};
  const fakeContext = new EventEmitter();
  fakeContext.setDefaultTimeout = () => {};
  fakeContext.setDefaultNavigationTimeout = () => {};
  fakeContext.route = async () => {};
  fakeContext.newPage = async () => fakePage;
  fakeContext.close = async () => {};
  browserDriver.getBrowser = async () => ({ newContext: async () => fakeContext });
  browserDriver.closeBrowser = async () => {};
  browserEgress.createSessionProxy = async () => ({ url: "http://127.0.0.1:1", close: async () => {} });

  let sessionId;
  t.after(async () => {
    if (sessionId) await browserSessions.closeSession(sessionId, { reason: "test_cleanup" });
    browserDriver.getBrowser = original.getBrowser;
    browserDriver.closeBrowser = original.closeBrowser;
    browserEgress.createSessionProxy = original.createSessionProxy;
    db.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const opened = await tools.callMcpTool("browser", { action: "open", project }, { ...ownerContext, project });
  assert.equal(opened.isError, undefined, opened.content?.[0]?.text);
  sessionId = JSON.parse(opened.content[0].text).session.id;

  for (const action of ["list", "status"]) {
    const anonymous = await tools.callMcpTool("browser", { action }, {});
    assert.equal(anonymous.isError, true);
    assert.equal(anonymous.code, "unauthenticated");
  }

  const peerContext = {
    authIdentity: { principal_id: peer.principal_id, principal_type: "service", scopes: null },
    project,
  };
  const mismatchedProject = await tools.callMcpTool("browser", {
    action: "open",
    project: "browser_session_foreign",
  }, peerContext);
  assert.equal(mismatchedProject.isError, true);
  assert.equal(mismatchedProject.code, "project_scope_denied");

  const ungrantedProject = await tools.callMcpTool("browser", {
    action: "open",
    project: "browser_session_foreign",
  }, { authIdentity: peerContext.authIdentity });
  assert.equal(ungrantedProject.isError, true);
  assert.equal(ungrantedProject.code, "project_access_denied");

  const listed = await tools.callMcpTool("browser", { action: "list", project }, peerContext);
  assert.equal(listed.isError, undefined, listed.content?.[0]?.text);
  assert.ok(!JSON.parse(listed.content[0].text).sessions.some(session => session.id === sessionId));

  for (const action of ["pages", "close"]) {
    const result = await tools.callMcpTool("browser", { action, project, session: sessionId }, peerContext);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, "browser_session_not_found");
  }
  const status = await tools.callMcpTool("browser", { action: "status", project }, peerContext);
  assert.equal(status.isError, undefined);
  assert.equal(JSON.parse(status.content[0].text).sessions.open, 0);

});
