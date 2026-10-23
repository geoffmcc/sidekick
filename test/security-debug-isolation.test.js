"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-debug-isolation-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
const db = require("../src/db");
const identity = require("../src/core/identity");
const platformKernel = require("../src/platform/kernel");
const projectAccess = require("../src/core/project-access");
const context = require("../src/tools/context");
const { sidekick_debug_tool } = require("../src/tools/families/meta");
const { callInternalTool, dispatchTool } = require("../src/tools/dispatcher");
const invokeDebug = (actionArgs, principalId) => dispatchTool({ name: "debug_tool", args: actionArgs, context: {
  source: "mcp", project: "debug_alpha", authIdentity: principalId ? { principal_id: principalId, principal_type: "service", scopes: null } : null,
} });

db.runPendingMigrations();
const owner = identity.bootstrapOwner({ username: "debug_isolation_owner", password: "debug isolation owner password" });
const principalA = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Debug A" });
const principalB = require('./helpers/authorized-identity').createPrincipal(identity, { type: "service", displayName: "Debug B" });
identity.assignRole(principalA.principal_id, "operator", owner.principal_id);
identity.assignRole(principalB.principal_id, "operator", owner.principal_id);
platformKernel.registerProject({ project_id: "debug_alpha", owner_actor_id: principalA.principal_id, source: "test" });
projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: principalB.principal_id, project: "debug_alpha", accessLevel: "read" });

function asPrincipal(principalId, fn) {
  return context.runWithContext(context.createTestExecutionContext({
    source: "test",
    authIdentity: { principal_id: principalId, principal_type: "service", scopes: null },
    project: "debug_alpha",
  }), fn);
}

(async () => {
  const anonymous = await callInternalTool("debug_tool", { action: "recall" });
  assert.strictEqual(anonymous.isError, true, "persistent debug recall must reject identityless dispatch");

  const direct = await asPrincipal(principalA.principal_id, () => sidekick_debug_tool({ action: "recall", service: "synthetic" }));
  assert.strictEqual(direct.code, "canonical_dispatch_required", "raw debug handler calls must not bypass the dispatcher");

  const stored = await invokeDebug({ action: "store", service: "synthetic", issue: "isolation", value: "private debug value" }, principalA.principal_id);
  assert.strictEqual(stored.isError, undefined);
  const ownRecall = await invokeDebug({ action: "recall", service: "synthetic" }, principalA.principal_id);
  assert.match(ownRecall.content[0].text, /private debug value/);

  const crossPrincipal = await invokeDebug({ action: "recall", service: "synthetic" }, principalB.principal_id);
  assert.doesNotMatch(crossPrincipal.content[0].text, /private debug value/);

  await dispatchTool({ name: "store", args: { key: "only_a", value: "private project KV", project: "debug_alpha" }, context: {
    source: "mcp", project: "debug_alpha", authIdentity: { principal_id: principalA.principal_id, principal_type: "service", scopes: null },
  } });
  const projectContextA = await dispatchTool({ name: "project", args: { name: "debug_alpha", include: "kv" }, context: {
    source: "mcp", project: "debug_alpha", authIdentity: { principal_id: principalA.principal_id, principal_type: "service", scopes: null },
  } });
  const projectContextB = await dispatchTool({ name: "project", args: { name: "debug_alpha", include: "kv" }, context: {
    source: "mcp", project: "debug_alpha", authIdentity: { principal_id: principalB.principal_id, principal_type: "service", scopes: null },
  } });
  assert.match(projectContextA.content[0].text, /private project KV/);
  assert.doesNotMatch(projectContextB.content[0].text, /private project KV/, "project KV context must respect principal namespaces even for shared projects");

  await invokeDebug({ action: "start", session_name: "shared" }, principalA.principal_id);
  await invokeDebug({ action: "cache", session_name: "shared", key: "secret", value: "session private" }, principalA.principal_id);
  const crossSession = await invokeDebug({ action: "get", session_name: "shared", key: "secret" }, principalB.principal_id);
  assert.strictEqual(crossSession.isError, true, "debug sessions must be principal scoped");

  console.log("debug storage and session isolation tests passed");
  db.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
