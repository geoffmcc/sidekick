"use strict";

// Dashboard honesty/governance tests (production-completion audit items):
//   - memory mutation routes return real status codes (404 on unknown ids)
//     and route through the dispatcher's memory tools
//   - DELETE /api/kv/:key reports deleted:true/false instead of blanket ok
//   - /api/evolve/:id/run marks the pre-created execution row failed when the
//     dispatcher answers with an error RESULT (previously stranded `queued`)
//   - /api/db/search routes through the governed db_search tool (audit trail)
//   - /api/internal/error-log answers 204, not a fake {ok:true}
//   - system/summary payloads report the 1m load average honestly (no fake
//     CPU percent, no canned toolStats placeholder)
//
// Boots the real dashboard on a test port like dashboard-api.test.js.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-dash-honesty-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DASHBOARD_PORT = "4101";
process.env.SIDEKICK_DASHBOARD_USER = "test-user";
process.env.SIDEKICK_DASHBOARD_PASS = "test-pass";
process.env.SIDEKICK_API_KEY = "test-sidekick-api-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

process.on("exit", () => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});

const dbStore = require("../src/db");

function makeRequest(method, urlPath, body = null, identityCookie = null) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: "127.0.0.1",
      port: 4101,
      path: urlPath,
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from("test-user:test-pass").toString("base64"),
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        ...(identityCookie ? { Cookie: identityCookie } : {}),
        ...(identityCookie ? { Origin: "http://127.0.0.1:4101" } : {}),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        let parsed = out;
        try { parsed = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await makeRequest("GET", "/api/services");
      if (res.status) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("dashboard did not start");
}

console.log("Running dashboard honesty tests...\n");

require("../src/dashboard");

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    console.error("  FAIL - " + name);
    console.error("    " + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
}

(async () => {
  await waitForServer();

  await ok("error-log endpoint answers 204 (received), not fake {ok:true}", async () => {
    const res = await makeRequest("POST", "/api/internal/error-log", { url: "/x", status: 500, error: "test" });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.data, "");
  });

  await ok("/api/system reports load average honestly (no fake cpu percent)", async () => {
    const res = await makeRequest("GET", "/api/system");
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.data.load_1m === "number", "load_1m should be a number");
    assert.ok(Number.isInteger(res.data.cpu_count) && res.data.cpu_count >= 1, "cpu_count should be reported");
    assert.strictEqual(res.data.cpu, undefined, "the fake cpu percent field is gone");
  });

  await ok("/api/dashboard-summary drops the canned toolStats and names load honestly", async () => {
    const res = await makeRequest("GET", "/api/dashboard-summary");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.toolStats, undefined, "placeholder toolStats removed");
    assert.ok(typeof res.data.health.load_1m === "number");
    assert.ok(typeof res.data.health.load_pct_of_cores === "number");
    assert.strictEqual(res.data.health.cpu, undefined, "the mislabeled cpu field is gone");
  });

  await ok("KV delete reports what happened: deleted:true, then 404 on the second delete", async () => {
    const put = await makeRequest("PUT", "/api/kv/honesty-test-key", { value: "v1" });
    assert.strictEqual(put.status, 200);
    const del = await makeRequest("DELETE", "/api/kv/honesty-test-key");
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.data.ok, true);
    assert.strictEqual(del.data.deleted, true);
    const again = await makeRequest("DELETE", "/api/kv/honesty-test-key");
    assert.strictEqual(again.status, 404);
    assert.strictEqual(again.data.ok, false);
    assert.strictEqual(again.data.deleted, false);
  });

  await ok("memory mutations on unknown ids are 404, not 200 {ok:false}", async () => {
    for (const [method, urlPath] of [
      ["POST", "/api/memories/mem_does_not_exist/disable"],
      ["POST", "/api/memories/mem_does_not_exist/enable"],
      ["DELETE", "/api/memories/mem_does_not_exist"],
    ]) {
      const res = await makeRequest(method, urlPath);
      assert.strictEqual(res.status, 404, method + " " + urlPath + " should be 404, got " + res.status);
      assert.strictEqual(res.data.ok, false);
      assert.ok(res.data.error, "error message should be present");
    }
  });

  await ok("memory routes enforce project grants and conceal inaccessible IDs", async () => {
    const kernel = require("../src/platform/kernel");
    const projectAccess = require("../src/core/project-access");
    const owner = (await makeRequest("GET", "/api/auth/me")).data.principal;
    kernel.registerProject({ project_id: "memory_hidden_project", owner_actor_id: owner.principal_id });
    kernel.registerProject({ project_id: "memory_allowed_project", owner_actor_id: owner.principal_id });

    async function createScopedUser(username, role, password) {
      const created = await makeRequest("POST", "/api/auth/users", { username, password, role });
      assert.strictEqual(created.status, 201, "owner can create a scoped test principal");
      const login = await makeRequest("POST", "/api/auth/login", { username, password });
      assert.strictEqual(login.status, 200);
      const cookie = (login.headers["set-cookie"] || []).find(value => value.startsWith("sidekick_identity="))?.split(";", 1)[0];
      assert.ok(cookie, "login must establish the identity session used by the request");
      return { principal: created.data.principal, cookie };
    }

    const viewer = await createScopedUser("memory-project-viewer", "viewer", "a sufficiently long viewer password");
    const operator = await createScopedUser("memory-project-operator", "operator", "a sufficiently long operator password");
    projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: viewer.principal.principal_id, project: "memory_allowed_project", accessLevel: "read" });
    projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: operator.principal.principal_id, project: "memory_allowed_project", accessLevel: "write" });

    const allowedFact = dbStore.upsertMemory({
      id: "mem-allowed-project-export",
      type: "fact",
      project: "memory_allowed_project",
      content: "authorized project export fact",
      summary: "authorized project export fact",
      confidence: 0.9,
      source: "test",
    });
    const secret = dbStore.upsertMemory({
      id: "mem-hidden-project-enable",
      type: "fact",
      project: "memory_hidden_project",
      content: "hidden project memory",
      summary: "hidden project memory",
      confidence: 0.9,
      source: "test",
    });
    dbStore.disableMemory(secret.id);
    const activeSecret = dbStore.upsertMemory({
      id: "mem-hidden-project-mutations",
      type: "fact",
      project: "memory_hidden_project",
      content: "hidden project mutation target",
      summary: "hidden project mutation target",
      confidence: 0.9,
      source: "test",
    });

    const allowedExport = await makeRequest("POST", "/api/memories/export", { project: "memory_allowed_project" }, operator.cookie);
    assert.strictEqual(allowedExport.status, 200, JSON.stringify(allowedExport.data));
    assert.ok(allowedExport.data.data.memories.some(memory => memory.id === allowedFact.id));
    assert.ok(allowedExport.data.data.memories.every(memory => memory.project === "memory_allowed_project"));
    assert.doesNotMatch(JSON.stringify(allowedExport.data), /hidden project memory/);
    const allowedEvidence = await makeRequest("GET", `/api/memories/${allowedFact.id}/evidence`, null, operator.cookie);
    assert.strictEqual(allowedEvidence.status, 200, JSON.stringify(allowedEvidence.data));
    const deniedEvidence = await makeRequest("GET", `/api/memories/${secret.id}/evidence`, null, operator.cookie);
    const missingEvidence = await makeRequest("GET", "/api/memories/mem-definitely-absent/evidence", null, operator.cookie);
    assert.strictEqual(deniedEvidence.status, 404);
    assert.strictEqual(deniedEvidence.data.error, missingEvidence.data.error, "out-of-project evidence IDs must be indistinguishable from absent IDs");
    const viewerExport = await makeRequest("POST", "/api/memories/export", { project: "memory_allowed_project" }, viewer.cookie);
    assert.strictEqual(viewerExport.status, 403, JSON.stringify(viewerExport.data));
    assert.strictEqual(viewerExport.data.code, "forbidden");
    const deniedExport = await makeRequest("POST", "/api/memories/export", { project: "memory_hidden_project" }, viewer.cookie);
    assert.strictEqual(deniedExport.status, 404, JSON.stringify(deniedExport.data));

    const readOnlyImport = await makeRequest("POST", "/api/memories/import", {
      project: "memory_allowed_project",
      data: { memories: [{ type: "fact", project: "memory_allowed_project", content: "viewer cannot import", confidence: 0.8 }] },
    }, viewer.cookie);
    assert.strictEqual(readOnlyImport.status, 404, JSON.stringify(readOnlyImport.data));
    const scopedImport = await makeRequest("POST", "/api/memories/import", {
      project: "memory_allowed_project",
      data: { memories: [
        { type: "fact", project: "memory_allowed_project", content: "authorized project imported fact", confidence: 0.8 },
        { type: "fact", project: "memory_hidden_project", content: "unauthorized project imported fact", confidence: 0.8 },
      ] },
    }, operator.cookie);
    assert.strictEqual(scopedImport.status, 200, JSON.stringify(scopedImport.data));
    assert.ok(dbStore.searchMemories({ project: "memory_allowed_project", query: "authorized project imported fact", limit: 10 }).length > 0);
    assert.equal(dbStore.searchMemories({ project: "memory_hidden_project", query: "unauthorized project imported fact", limit: 10 }).length, 0);
    const deniedImport = await makeRequest("POST", "/api/memories/import", {
      project: "memory_hidden_project",
      data: { memories: [{ type: "fact", project: "memory_hidden_project", content: "denied hidden import", confidence: 0.8 }] },
    }, operator.cookie);
    assert.strictEqual(deniedImport.status, 404, JSON.stringify(deniedImport.data));
    assert.equal(dbStore.searchMemories({ project: "memory_hidden_project", query: "denied hidden import", limit: 10 }).length, 0);

    const handoff = dbStore.saveHandoff({
      project: "memory_allowed_project",
      title: "Revocation boundary test",
      source: "test",
      content: "Decision: only the current project grant may authorize this handoff read.",
      owner_principal_id: viewer.principal.principal_id,
      created_by_principal_id: viewer.principal.principal_id,
    });
    const beforeRevocation = await makeRequest("GET", `/api/handoffs/${handoff.id}`, null, viewer.cookie);
    assert.strictEqual(beforeRevocation.status, 200, JSON.stringify(beforeRevocation.data));
    projectAccess.revokeProjectAccess({ actorPrincipalId: owner.principal_id, principalId: viewer.principal.principal_id, project: "memory_allowed_project" });
    const afterRevocation = await makeRequest("GET", `/api/handoffs/${handoff.id}`, null, viewer.cookie);
    const missingHandoff = await makeRequest("GET", "/api/handoffs/handoff-definitely-absent", null, viewer.cookie);
    assert.strictEqual(afterRevocation.status, 404, JSON.stringify(afterRevocation.data));
    assert.strictEqual(afterRevocation.data.error, missingHandoff.data.error, "revoked handoff and missing handoff must be indistinguishable");
    const revokedList = await makeRequest("GET", "/api/handoffs?project=memory_allowed_project", null, viewer.cookie);
    assert.equal(revokedList.data.handoffs.some(item => item.id === handoff.id), false);

    const inaccessible = await makeRequest("POST", `/api/memories/${secret.id}/enable`, null, viewer.cookie);
    const nonexistent = await makeRequest("POST", "/api/memories/mem-definitely-absent/enable", null, viewer.cookie);
    assert.strictEqual(inaccessible.status, 404, JSON.stringify(inaccessible.data));
    assert.strictEqual(nonexistent.status, 404, JSON.stringify(nonexistent.data));
    assert.strictEqual(inaccessible.data.code, nonexistent.data.code);
    assert.strictEqual(dbStore.getMemoryById(secret.id, { includeDisabled: true }).enabled, false, "denied enable must not mutate the memory");

    const deniedDisable = await makeRequest("POST", `/api/memories/${activeSecret.id}/disable`, null, viewer.cookie);
    const missingDisable = await makeRequest("POST", "/api/memories/mem-definitely-absent/disable", null, viewer.cookie);
    const deniedDelete = await makeRequest("DELETE", `/api/memories/${activeSecret.id}`, null, viewer.cookie);
    const missingDelete = await makeRequest("DELETE", "/api/memories/mem-definitely-absent", null, viewer.cookie);
    for (const response of [deniedDisable, missingDisable, deniedDelete, missingDelete]) {
      assert.strictEqual(response.status, 404, JSON.stringify(response.data));
      assert.strictEqual(response.data.code, inaccessible.data.code);
    }
    const unchanged = dbStore.getMemoryById(activeSecret.id, { includeDisabled: true });
    assert.strictEqual(unchanged.enabled, true, "denied disable/delete must not mutate the memory");
    assert.strictEqual(unchanged.state, "active");
  });

  await ok("memory disable/enable/delete succeed through the governed tools on a real memory", async () => {
    // The structured-memory schema comes from migrations (as in
    // dashboard-api.test.js); apply the relevant ones to the fresh test DB.
    const db = dbStore.getDb();
    for (const migration of ["003_structured_memory.sql", "004_memory_lifecycle.sql", "005_sync_support.sql", "006_memory_deferred.sql"]) {
      try {
        db.exec(fs.readFileSync(path.join(__dirname, "..", "migrations", migration), "utf8"));
      } catch (error) {
        if (!/duplicate column name|already exists/i.test(error.message)) throw error;
      }
    }
    dbStore.upsertMemory({ type: "fact", content: "dashboard honesty test memory", project: "sk-honesty", confidence: 0.9, source: "test" });
    const rows = dbStore.searchMemories({ project: "sk-honesty", limit: 10 });
    assert.ok(rows.length >= 1, "test memory should exist");
    const id = rows[0].id;

    const disable = await makeRequest("POST", "/api/memories/" + encodeURIComponent(id) + "/disable");
    assert.strictEqual(disable.status, 200);
    assert.strictEqual(disable.data.ok, true);
    // The disable ran through memory_manage → dispatcher, so it must be audited.
    const audited = dbStore.queryToolLogs({ tool: "memory_manage", limit: 10 });
    assert.ok(audited.length >= 1, "memory_manage dispatch should appear in tool logs");

    const enable = await makeRequest("POST", "/api/memories/" + encodeURIComponent(id) + "/enable");
    assert.strictEqual(enable.status, 200);
    assert.strictEqual(enable.data.ok, true);

    const del = await makeRequest("DELETE", "/api/memories/" + encodeURIComponent(id));
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.data.ok, true);
  });

  await ok("memory import rejects unusable payloads with a real status code", async () => {
    const missing = await makeRequest("POST", "/api/memories/import", {});
    assert.strictEqual(missing.status, 400);
    const invalid = await makeRequest("POST", "/api/memories/import", { data: "{not json" });
    assert.strictEqual(invalid.status, 400);
  });

  await ok("memory export routes through memory_export and returns the payload", async () => {
    const res = await makeRequest("POST", "/api/memories/export", { include_disabled: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.ok(res.data.data && Array.isArray(res.data.data.memories), "export payload should carry memories");
    const audited = dbStore.queryToolLogs({ tool: "memory_export", limit: 10 });
    assert.ok(audited.length >= 1, "memory_export dispatch should appear in tool logs");
  });

  await ok("/api/db/search routes through the governed db_search tool", async () => {
    const res = await makeRequest("GET", "/api/db/search?q=honesty");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    const audited = dbStore.queryToolLogs({ tool: "db_search", limit: 10 });
    assert.ok(audited.length >= 1, "db_search dispatch should appear in tool logs (dispatcher audit applies)");
    const empty = await makeRequest("GET", "/api/db/search");
    assert.strictEqual(empty.status, 400, "missing query should be a 400, not 200 {ok:false}");
  });

  await ok("evolve run marks the execution failed when dispatch answers with an error result", async () => {
    // Invalid risk classification makes the dispatcher refuse with an error
    // RESULT (risk_unclassified) before any handler runs — exactly the path
    // that used to strand the pre-created execution row in `queued` forever.
    dbStore.saveGeneratedCapability({
      id: "gc_honesty_1",
      name: "sidekick_generated_honesty_probe",
      state: "trial",
      title: "honesty probe",
      description: "test capability for dispatch-failure marking",
      risk: "bogus-risk",
      parameters: {},
      steps: [],
    });
    const run = await makeRequest("POST", "/api/evolve/gc_honesty_1/run", { args: {} });
    assert.strictEqual(run.status, 200, JSON.stringify(run.data));
    assert.strictEqual(run.data.ok, true);
    const executionId = run.data.execution_id;
    assert.ok(executionId);

    // The dispatch happens on setImmediate; poll until the row is terminal.
    const start = Date.now();
    let execution = null;
    while (Date.now() - start < 5000) {
      const res = await makeRequest("GET", "/api/evolve/executions/" + encodeURIComponent(executionId));
      execution = res.data.execution;
      if (execution && execution.state !== "queued" && execution.state !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(execution, "execution should be readable");
    assert.strictEqual(execution.state, "failed", "row must not stay queued after a refused dispatch");
    assert.ok(execution.final_summary, "failure reason should be recorded");
  });

  console.log("\nAll " + passed + " dashboard honesty tests passed.\n");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
