"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = process.env.SIDEKICK_TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = "";

assert.ok(process.env.SIDEKICK_DATA_DIR, "run this security integration suite through the repository test runner");

const db = require("../../src/db");
const identity = require("../../src/core/identity");
const authentication = require("../../src/core/authentication");
const projectAccess = require("../../src/core/project-access");
const platformKernel = require("../../src/platform/kernel");
const { createMcpServer } = require("../../src/mcp/server");
const { createModernMcpHandler } = require("../../src/mcp/streamable-http");

let owner;
let writerToken;
let readerToken;
let project;
let sessionId;
let handler;
let requestId = 0;

before(() => {
  db.runPendingMigrations();
  owner = identity.bootstrapOwner({
    username: "scoped-continuity-owner",
    password: "synthetic continuity owner password",
    displayName: "Scoped Continuity Test Owner",
  });

  const caller = identity.createPrincipal({
    type: "service",
    displayName: "Synthetic scoped continuity client",
    createdByPrincipalId: owner.principal_id,
    actorIdentity: owner,
  });
  for (const permission of ["memory.read", "memory.write"]) {
    identity.grantPrincipalPermission(caller.principal_id, permission, owner);
  }

  project = `mcp_continuity_${process.pid}`;
  platformKernel.registerProject({ project_id: project, owner_actor_id: owner.principal_id });
  projectAccess.grantProjectAccess({
    actorPrincipalId: owner.principal_id,
    principalId: caller.principal_id,
    project,
    accessLevel: "write",
  });

  writerToken = authentication.createCredential({
    principalId: caller.principal_id,
    displayName: "Synthetic continuity read/write credential",
    scopes: ["memory.read", "memory.write"],
    createdByPrincipalId: owner.principal_id,
    actorContext: owner,
  }).token;
  readerToken = authentication.createCredential({
    principalId: caller.principal_id,
    displayName: "Synthetic continuity read-only credential",
    scopes: ["memory.read"],
    createdByPrincipalId: owner.principal_id,
    actorContext: owner,
  }).token;
  handler = createModernMcpHandler(createMcpServer);
});

after(() => db.closeDatabase());

async function callTool(token, name, args) {
  const authInfo = authentication.authenticateBearerIdentity(token);
  assert.ok(authInfo, "the synthetic service credential authenticates through the Core identity store");
  const request = new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "scoped-continuity-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const response = await handler.fetch(request, { authInfo });
  const responseText = await response.text();
  assert.equal(response.status, 200, `authorization denials are MCP tool results, not HTTP transport failures: ${responseText}`);
  const payload = JSON.parse(responseText);
  assert.ok(!payload.error, JSON.stringify(payload));
  return payload.result;
}

test("MCP continuity tools honor narrow memory credentials and preserve project gates", async () => {
  assert.deepEqual(
    authentication.authenticateBearerIdentity(writerToken).scopes,
    ["memory.read", "memory.write"],
  );
  assert.equal(
    authentication.authenticateBearerIdentity(writerToken).scopes.includes("tools.execute"),
    false,
    "the continuity credential has no generic tool-execution grant",
  );

  const started = await callTool(writerToken, "session", {
    action: "begin",
    goal: "MCP scoped continuity regression",
    project,
  });
  assert.notEqual(started.isError, true, started.content?.[0]?.text);
  sessionId = JSON.parse(started.content[0].text).session.id;

  const readStatus = await callTool(readerToken, "session", { action: "status", id: sessionId });
  assert.notEqual(readStatus.isError, true, readStatus.content?.[0]?.text);

  const sessionBefore = db.getTaskSession(sessionId);
  const deniedCheckpoint = await callTool(readerToken, "session", {
    action: "checkpoint",
    id: sessionId,
    current_plan: "read-only credentials must not write",
  });
  assert.equal(deniedCheckpoint.isError, true);
  assert.match(deniedCheckpoint.content?.[0]?.text || "", /Authorization denied: forbidden/);
  assert.match(deniedCheckpoint.content?.[0]?.text || "", /required permission: memory\.write/,
    "MCP denial identifies the grant needed without exposing principal role details");
  assert.equal(db.getTaskSession(sessionId).updated_at, sessionBefore.updated_at,
    "a denied checkpoint has no persistent side effect");

  const resumeSet = await callTool(writerToken, "resume", {
    action: "set",
    project,
    summary: "Scoped MCP resume pointer",
    next_step: "Continue the synthetic test",
  });
  assert.notEqual(resumeSet.isError, true, resumeSet.content?.[0]?.text);

  const resumeCheck = await callTool(readerToken, "resume", { action: "check", project });
  assert.notEqual(resumeCheck.isError, true, resumeCheck.content?.[0]?.text);
  assert.match(resumeCheck.content?.[0]?.text || "", /Scoped MCP resume pointer/);

  const resumeBefore = db.loadDocument("resume");
  const deniedResumeWrite = await callTool(readerToken, "resume", {
    action: "set",
    project,
    summary: "must not replace the authorized pointer",
    next_step: "must not persist",
  });
  assert.equal(deniedResumeWrite.isError, true);
  assert.match(deniedResumeWrite.content?.[0]?.text || "", /Authorization denied: forbidden/);
  assert.match(deniedResumeWrite.content?.[0]?.text || "", /required permission: memory\.write/);
  assert.deepEqual(db.loadDocument("resume"), resumeBefore,
    "a denied resume-pointer update has no persistent side effect");
});
