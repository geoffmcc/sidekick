const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.SIDEKICK_API_KEY = "mcp-v2-runtime-test-key";
process.env.SIDEKICK_AGENT_PROXY_KEY = "mcp-v2-runtime-agent-proxy-test-key";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-mcp-v2-"));
process.env.SIDEKICK_DATA_DIR = dataDir;

console.log("MCP v2 test: loading Sidekick");
const { app } = require("../src/index");
console.log("MCP v2 test: Sidekick loaded");

function modernRequest(port, id, method, params, headers = {}) {
  const protocolVersion = headers.protocolVersion || "2026-07-28";
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
      authorization: `Bearer ${headers.authToken || "mcp-v2-runtime-test-key"}`,
      ...(headers.name ? { "Mcp-Name": headers.name } : {}),
      ...(headers.sessionId ? { "Mcp-Session-Id": headers.sessionId } : {}),
    },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {
      ...(params || {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": protocolVersion,
        "io.modelcontextprotocol/clientInfo": { name: "sidekick-v2-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    } })
  });
}

(async () => {
  const server = app.listen(0, "127.0.0.1");
  let passed = false;
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const port = server.address().port;

    console.log("MCP v2 test: browser-session bearer identity on live HTTP routes");
    const identity = require("../src/core/identity");
    const authentication = require("../src/core/authentication");
    const owner = identity.bootstrapOwner({
      username: "mcp_v2_session_owner",
      password: "synthetic browser session test password",
      displayName: "MCP v2 Session Owner",
    });
    const browserSession = authentication.createSession(owner.principal_id);
    const browserInitialization = await modernRequest(port, "session-owner-initialize", "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "sidekick-session-auth-test", version: "1.0.0" },
    }, {
      authToken: browserSession.token,
      protocolVersion: "2025-03-26",
    });
    assert.strictEqual(browserInitialization.status, 200);
    assert.strictEqual(browserInitialization.headers.get("cache-control"), "no-store",
      "MCP responses must not be cached");
    const browserSessionId = browserInitialization.headers.get("mcp-session-id");
    assert.ok(browserSessionId, "a current browser session can initialize a live MCP session");

    const unauthenticatedHealth = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(unauthenticatedHealth.status, 200);
    assert.strictEqual(Object.hasOwn(await unauthenticatedHealth.json(), "sessionDetails"), false,
      "public health must omit MCP session identifiers and client metadata");

    const authenticatedHealth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${browserSession.token}` },
    });
    assert.strictEqual(authenticatedHealth.status, 200);
    const authenticatedHealthBody = await authenticatedHealth.json();
    assert.ok(Array.isArray(authenticatedHealthBody.sessionDetails),
      "a live authorized browser principal can access protected health details");
    assert.ok(authenticatedHealthBody.sessionDetails.some(entry => entry.id === browserSessionId),
      "the authorized detail response includes the authenticated MCP session created above");

    const admin = require("./helpers/authorized-identity").createHumanUser(identity, {
      username: "mcp_v2_health_admin", password: "synthetic admin health test password", displayName: "Health Administrator",
    }, owner);
    identity.assignRole(admin.principal_id, "administrator", owner);
    const adminSession = authentication.createSession(admin.principal_id);
    const adminHealth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${adminSession.token}` },
    });
    assert.ok(Array.isArray((await adminHealth.json()).sessionDetails),
      "an Administrator with dashboard.operations.read can access Dashboard health diagnostics");

    const viewer = require("./helpers/authorized-identity").createHumanUser(identity, {
      username: "mcp_v2_health_viewer", password: "synthetic viewer health test password", displayName: "Health Viewer",
    }, owner);
    identity.assignRole(viewer.principal_id, "viewer", owner);
    const viewerSession = authentication.createSession(viewer.principal_id);
    const viewerHealth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${viewerSession.token}` },
    });
    assert.strictEqual(Object.hasOwn(await viewerHealth.json(), "sessionDetails"), false,
      "a Viewer cannot access Dashboard health diagnostics");

    assert.strictEqual(authentication.invalidateSession(browserSession.token, owner.principal_id), true);
    const revokedHealth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${browserSession.token}` },
    });
    assert.strictEqual(revokedHealth.status, 200);
    assert.strictEqual(Object.hasOwn(await revokedHealth.json(), "sessionDetails"), false,
      "a revoked browser session loses protected health details on the next request");

    const revokedMcpRequest = await modernRequest(port, "revoked-session-call", "ping", {}, {
      authToken: browserSession.token,
      protocolVersion: "2025-03-26",
      sessionId: browserSessionId,
    });
    assert.strictEqual(revokedMcpRequest.status, 401,
      "a revoked browser session cannot authenticate a subsequent MCP request");

    console.log("MCP v2 test: discovery");
    const discoverResponse = await modernRequest(port, 1, "server/discover", {});
    assert.strictEqual(discoverResponse.status, 200);
    const discover = await discoverResponse.json();
    assert.ok(discover.result.supportedVersions.includes("2026-07-28"));
    assert.strictEqual(discover.result.capabilities.tools.listChanged, true);

    console.log("MCP v2 test: tools/list");
    const listResponse = await modernRequest(port, 2, "tools/list", {});
    assert.strictEqual(listResponse.status, 200);
    const list = await listResponse.json();
    const tools = list.result.tools;
    assert.ok(tools.length > 0);
    const readTool = tools.find(tool => tool.name === "read");
    const destructiveTool = tools.find(tool => tool.name === "delete");
    assert.ok(readTool && destructiveTool);
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.strictEqual(typeof readTool.annotations[key], "boolean", `read annotations.${key}`);
      assert.strictEqual(typeof destructiveTool.annotations[key], "boolean", `delete annotations.${key}`);
    }
    assert.strictEqual(readTool.annotations.readOnlyHint, true);
    assert.strictEqual(destructiveTool.annotations.destructiveHint, true);

    const handoffTool = tools.find(tool => tool.name === "handoff");
    const resumeTool = tools.find(tool => tool.name === "resume");
    assert.ok(handoffTool && resumeTool, "handoff and resume must be MCP-visible");
    assert.strictEqual(handoffTool.inputSchema.additionalProperties, false, "handoff schema must reject unknown legacy fields");
    assert.strictEqual(resumeTool.inputSchema.additionalProperties, false, "resume schema must reject unknown legacy fields");

    console.log("MCP v2 test: tools/call");
    const callResponse = await modernRequest(port, 3, "tools/call", { name: "tools", arguments: { action: "get", name: "read" } }, { name: "tools" });
    assert.strictEqual(callResponse.status, 200);
    assert.strictEqual(callResponse.headers.get("cache-control"), "no-store",
      "MCP tool results must not be cached");
    const call = await callResponse.json();
    assert.ok(!call.error, JSON.stringify(call));
    assert.ok(Array.isArray(call.result.content));

    const packClient = identity.createPrincipal({
      type: "service",
      displayName: "Synthetic MCP pack reader",
      createdByPrincipalId: owner.principal_id,
      actorIdentity: owner,
    });
    identity.grantPrincipalPermission(packClient.principal_id, "packs.read", owner);
    const packCredential = authentication.createCredential({
      principalId: packClient.principal_id,
      displayName: "Synthetic MCP pack reader",
      scopes: ["packs.read"],
      createdByPrincipalId: owner.principal_id,
      actorContext: owner,
    });
    const coreAuthorization = require("../src/core/authorization");
    const packCredentialIdentity = authentication.authenticateCredential(packCredential.token);
    assert.equal(coreAuthorization.authorize({
      principalId: packCredentialIdentity.principal_id,
      permission: "packs.read",
      credentialScopes: packCredentialIdentity.scopes,
    }).ok, true);
    assert.equal(coreAuthorization.authorize({
      principalId: packCredentialIdentity.principal_id,
      permission: "packs.manage",
      credentialScopes: packCredentialIdentity.scopes,
    }).ok, false);
    const packListResponse = await modernRequest(port, "scoped-pack-list", "tools/call", {
      name: "capability", arguments: { action: "list" },
    }, { authToken: packCredential.token, name: "capability" });
    assert.strictEqual(packListResponse.status, 200);
    const packList = await packListResponse.json();
    assert.ok(!packList.result?.isError, `a scoped service principal with packs.read can list packs: ${JSON.stringify(packList)}`);
    assert.match(packList.result?.content?.[0]?.text || "", /"action":\s*"list"/);

    const packUpgradeResponse = await modernRequest(port, "scoped-pack-upgrade-denied", "tools/call", {
      name: "capability", arguments: { action: "upgrade", name: "__synthetic_missing_pack__", allow_same_version: true },
    }, { authToken: packCredential.token, name: "capability" });
    assert.strictEqual(packUpgradeResponse.status, 200);
    const packUpgrade = await packUpgradeResponse.json();
    assert.ok(packUpgrade.result?.isError, "packs.read must not authorize lifecycle mutations");
    assert.match(packUpgrade.result?.content?.[0]?.text || "", /Authorization denied: forbidden/);

    console.log("MCP v2 test: oversized tool input rejected before dispatch");
    const oversizedInputResponse = await modernRequest(port, 6, "tools/call", {
      name: "memory",
      arguments: { action: "remember", project: "mcp_v2_runtime", content: "bounded test", tags: Array.from({ length: 10_001 }, () => "synthetic") }
    }, { name: "memory" });
    assert.strictEqual(oversizedInputResponse.status, 200);
    const oversizedInput = await oversizedInputResponse.json();
    assert.strictEqual(oversizedInput.result?.isError, true, "MCP must reject inputs over the configured element limit");
    assert.match(oversizedInput.result?.content?.[0]?.text || "", /maximum of 10000 elements/);

    console.log("MCP v2 test: oversized HTTP body rejected");
    const oversizedBodyResponse = await modernRequest(port, 7, "tools/call", {
      name: "memory",
      arguments: { action: "remember", project: "mcp_v2_runtime", content: "x".repeat(1024 * 1024) }
    }, { name: "memory" });
    assert.strictEqual(oversizedBodyResponse.status, 413, "MCP HTTP body must remain bounded at 1 MiB");

    console.log("MCP v2 test: legacy handoff fields rejected at protocol boundary");
    const legacyHandoffResponse = await modernRequest(port, 4, "tools/call", {
      name: "handoff",
      arguments: { action: "create", key: "legacy-key-must-not-be-accepted", project: "mcp_v2_runtime", content: "must reject" }
    }, { name: "handoff" });
    assert.strictEqual(legacyHandoffResponse.status, 200);
    const legacyHandoff = await legacyHandoffResponse.json();
    assert.ok(legacyHandoff.error || legacyHandoff.result?.isError, "legacy handoff key must be rejected, not stripped");

    const legacyResumeResponse = await modernRequest(port, 5, "tools/call", {
      name: "resume",
      arguments: { action: "set", project: "mcp_v2_runtime", summary: "must reject", handoff_key: "legacy-key-must-not-be-accepted" }
    }, { name: "resume" });
    assert.strictEqual(legacyResumeResponse.status, 200);
    const legacyResume = await legacyResumeResponse.json();
    assert.ok(legacyResume.error || legacyResume.result?.isError, "legacy resume key must be rejected, not stripped");
    console.log("MCP v2 runtime: discovery, tool listing, annotations, and governed invocation passed");
    passed = true;
  } finally {
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
  if (passed) process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
