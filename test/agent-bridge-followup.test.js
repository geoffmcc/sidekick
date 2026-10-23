"use strict";

// API + security tests for the Agent Bridge follow-up feature. Boots the real
// src/agent.js express app on a test port (as dashboard-api.test.js boots the
// dashboard) and drives the follow-up endpoint end to end with a deterministic
// injected LLM. The real callAgentTool dispatcher is used so tool policy still
// runs; no live model or network is required.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-followup-"));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(TEST_DATA_DIR, "sidekick-test.db");
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_ENVIRONMENT = "test";
process.env.SIDEKICK_API_KEY = "agent-bridge-followup-test-api-key";
process.env.SIDEKICK_AGENT_PROXY_KEY = "agent-bridge-followup-dedicated-proxy-key";
// Set a fake Groq key so the module-load ollama warmup path is skipped.
process.env.GROQ_API_KEY = "test-fake-key";

const dbStore = require("../src/db");
assert.strictEqual(path.dirname(dbStore.DB_FILE), TEST_DATA_DIR, "Agent Bridge tests must use their fresh temporary database");
let port;

delete require.cache[require.resolve("../src/agent")];
const agent = require("../src/agent");
const { getExecutionContext } = require("../src/tools/context");
const { createAgentProxyHeaders } = require("../src/security/agent-proxy-auth");
const authenticatedTestPrincipal = require("./helpers/authorized-context").createOwnerContext({
  source: "agent",
  scopes: ["agent.tasks.read", "tools.execute", "tools.execute_high", "memory.read", "memory.write", "workflows.execute"],
  project: "agent_test_project",
});
const authenticatedTestHeaders = {
  "X-Sidekick-Principal-ID": authenticatedTestPrincipal.authIdentity.principal_id,
  "X-Sidekick-Principal-Scopes": JSON.stringify(authenticatedTestPrincipal.authIdentity.scopes),
};

console.log("Running Agent Bridge follow-up API/security tests...\n");

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

function request(method, urlPath, body, extraHeaders = {}, signed = true, signingSecret = process.env.SIDEKICK_AGENT_PROXY_KEY, service = "dashboard-proxy") {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const principalId = extraHeaders["X-Sidekick-Principal-ID"] || "";
    const scopes = extraHeaders["X-Sidekick-Principal-Scopes"] ? JSON.parse(extraHeaders["X-Sidekick-Principal-Scopes"]) : [];
    const delegationId = extraHeaders["X-Sidekick-Delegation-ID"] || "";
    const proxyHeaders = signed ? createAgentProxyHeaders({ secret: signingSecret, method, path: urlPath, body: data || "", principalId, scopes, delegationId, service }) : {};
    const req = http.request({
      hostname: "127.0.0.1", port, path: urlPath, method,
      // These scenarios can spend many seconds waiting for durable Agent work.
      // Avoid reusing an idle keep-alive socket that the test server may have
      // closed during that wait.
      agent: false,
      headers: { "Content-Type": "application/json", ...proxyHeaders, ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}), ...extraHeaders },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        let parsed = out;
        try { parsed = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Deterministic LLM. Reassign `fake` per test. Records the last messages seen on
// each routing path so tests can assert the continuation brief reached them.
const seen = { direct: null, tool: null };
const seenInferencePrincipals = [];
let fake = null;
agent.__setLLMOverrideForTests((messages, options) => {
  seenInferencePrincipals.push(getExecutionContext()?.authIdentity?.principal_id || null);
  const isToolLoop = options && options.format === "json";
  if (isToolLoop) seen.tool = messages; else seen.direct = messages;
  return Promise.resolve(fake(messages, options, isToolLoop));
});

// Default: direct path returns text; tool path returns a terminal done.
function fakeDirect(text) {
  return () => ({ response: text, provider: "test", model: "test-model" });
}
function fakeToolThenDone(decisions) {
  let i = 0;
  return (messages, options, isToolLoop) => {
    if (!isToolLoop) return { response: "direct", provider: "test", model: "test-model" };
    const d = decisions[Math.min(i, decisions.length - 1)];
    i++;
    return { response: JSON.stringify(d), provider: "test", model: "test-model" };
  };
}

function transcriptPath(id) {
  return path.join(agent.CONV_DIR, id + ".json");
}
async function waitForTranscript(id, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(transcriptPath(id))) {
      try {
        const transcript = JSON.parse(fs.readFileSync(transcriptPath(id), "utf-8"));
        if (["completed", "failed", "iteration_limit", "timed_out", "cancelled"].includes(transcript.status)) return transcript;
      } catch {
        // The writer may still be publishing the record; retry until terminal.
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for transcript " + id);
}
async function runRootTask(goal) {
  const res = await request("POST", "/api/agent/run", { goal });
  assert.strictEqual(res.status, 200);
  await waitForTranscript(res.data.taskId);
  return res.data.taskId;
}

let server;
(async () => {
  server = agent.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;

  // 1) Existing POST /api/agent/run behavior remains compatible.
  await ok("1) POST /api/agent/run still creates a task (backward compatible)", async () => {
    fake = fakeDirect("hello there");
    const res = await request("POST", "/api/agent/run", { goal: "Say hello" });
    assert.strictEqual(res.status, 200);
    assert.match(res.data.taskId, /^[0-9a-f]{8}$/);
    assert.strictEqual(res.data.parentTaskId, undefined, "root task has no parent field");
    await waitForTranscript(res.data.taskId);
  });

  await ok("1c) project-scoped tasks require active project membership at creation", async () => {
    fake = fakeDirect("project task completed");
    const denied = await request("POST", "/api/agent/run", { goal: "must not create an out-of-project task", project: "agent_test_project" }, { "X-Sidekick-Principal-ID": "principal_without_project_membership", "X-Sidekick-Principal-Scopes": JSON.stringify(["agent.tasks.read"]) });
    assert.strictEqual(denied.status, 403, "a signed principal without a real project grant cannot create a project-scoped task");
    const created = await request("POST", "/api/agent/run", { goal: "create a task within the owned project", project: "agent_test_project" }, authenticatedTestHeaders);
    assert.strictEqual(created.status, 200);
    const detail = await request("GET", "/api/agent/tasks/" + created.data.taskId, null, authenticatedTestHeaders);
    assert.strictEqual(detail.status, 200, "the authorized task owner can read its project task");
    await waitForTranscript(created.data.taskId);
  });

  await ok("1c-service) Certification task submission stays read-only when the caller omits its envelope", async () => {
    fake = fakeDirect("certification read only");
    const created = await request("POST", "/api/agent/run", { goal: "Certification task without caller envelope" }, {}, true, process.env.SIDEKICK_AGENT_PROXY_KEY, "certification");
    assert.strictEqual(created.status, 200);
    const detail = await request("GET", "/api/agent/tasks/" + created.data.taskId);
    assert.strictEqual(detail.status, 200);
    assert.deepStrictEqual(detail.data.task.authority_envelope.allowed_effects, ["read_only"]);
    assert.strictEqual(detail.data.task.authority_envelope.changes_allowed, false);
    assert.strictEqual(detail.data.task.authority_envelope.external_effects_allowed, false);
    assert.strictEqual(detail.data.task.authority_envelope.production_allowed, false);
    assert.strictEqual(detail.data.task.authority_envelope.child_task_count, 0);
    await waitForTranscript(created.data.taskId);
  });

  await ok("1c-handoff) task handoff attachment rechecks current project and memory-write authority", async () => {
    const principalId = authenticatedTestPrincipal.authIdentity.principal_id;
    const handoff = dbStore.saveHandoff({
      project: "agent_test_project",
      title: "Scoped Agent handoff fixture",
      content: "Synthetic continuity data for authorization regression",
      source: "test",
      owner_principal_id: principalId,
      created_by_principal_id: principalId,
    });
    const missingProject = await request("POST", "/api/agent/run", { goal: "must not attach another project's handoff", handoff_id: handoff.id }, authenticatedTestHeaders);
    assert.notStrictEqual(missingProject.status, 200, "project handoff cannot attach to an unscoped task");

    const readOnlyHeaders = {
      "X-Sidekick-Principal-ID": principalId,
      "X-Sidekick-Principal-Scopes": JSON.stringify(["agent.tasks.read"]),
    };
    const noMemoryWrite = await request("POST", "/api/agent/run", { goal: "must not mutate a handoff without memory write", project: "agent_test_project", handoff_id: handoff.id }, readOnlyHeaders);
    assert.notStrictEqual(noMemoryWrite.status, 200, "task creation read authority cannot authorize handoff continuity writes");
    assert.strictEqual(dbStore.getHandoff(handoff.id).version, handoff.version, "denied attempts leave the handoff unchanged");
  });

  await ok("1c-handoff-identity) identical task continuity records remain task-specific", async () => {
    fake = fakeDirect("same continuity result");
    const first = await request("POST", "/api/agent/run", { goal: "Same continuity goal", project: "agent_test_project" }, authenticatedTestHeaders);
    assert.strictEqual(first.status, 200);
    await waitForTranscript(first.data.taskId);
    const second = await request("POST", "/api/agent/run", { goal: "Same continuity goal", project: "agent_test_project" }, authenticatedTestHeaders);
    assert.strictEqual(second.status, 200);
    await waitForTranscript(second.data.taskId);
    const firstTask = await request("GET", "/api/agent/tasks/" + first.data.taskId, null, authenticatedTestHeaders);
    const secondTask = await request("GET", "/api/agent/tasks/" + second.data.taskId, null, authenticatedTestHeaders);
    assert.notStrictEqual(firstTask.data.task.handoff_id, secondTask.data.task.handoff_id, "deduplicated continuity content must not merge distinct task ownership");
    assert.strictEqual(dbStore.getHandoff(firstTask.data.task.handoff_id).task_id, first.data.taskId);
    assert.strictEqual(dbStore.getHandoff(secondTask.data.task.handoff_id).task_id, second.data.taskId);
  });

  await ok("1b) POST /api/agent/run rejects a missing/blank goal", async () => {
    const a = await request("POST", "/api/agent/run", {});
    assert.strictEqual(a.status, 400);
    const b = await request("POST", "/api/agent/run", { goal: "   " });
    assert.strictEqual(b.status, 400);
    const expanded = await request("POST", "/api/agent/run", { goal: "unauthenticated mutation", authority_envelope: { allowed_effects: ["workspace_reversible"], changes_allowed: true } });
    assert.strictEqual(expanded.status, 403);
  });

  await ok("1b-goal-spec) structured criteria persist through the real Agent submission route", async () => {
    fake = fakeDirect("criteria answer");
    const created = await request("POST", "/api/agent/run", { goal: "Answer with a bounded criterion", goal_spec: { normalized_objective: "Answer with one criterion", success_criteria: ["criteria answer"], stopping_conditions: ["budget exhausted"] } });
    assert.strictEqual(created.status, 200);
    await waitForTranscript(created.data.taskId);
    const detail = await request("GET", "/api/agent/tasks/" + created.data.taskId);
    assert.strictEqual(detail.status, 200);
    assert.deepStrictEqual(detail.data.task.goal.success_criteria, ["criteria answer"]);
    assert.strictEqual(detail.data.task.goal.normalized_objective, "Answer with one criterion");
  });

  await ok("1b-auth-context) authenticated principal is preserved through agent inference", async () => {
    fake = fakeDirect("authenticated inference context");
    const before = seenInferencePrincipals.length;
    const created = await request("POST", "/api/agent/run", { goal: "Answer with authenticated context" }, authenticatedTestHeaders);
    assert.strictEqual(created.status, 200);
    await waitForTranscript(created.data.taskId);
    assert.ok(seenInferencePrincipals.slice(before).includes(authenticatedTestPrincipal.authIdentity.principal_id), "agent inference must retain the initiating authenticated principal");
  });

  await ok("1c) authenticated task projections cannot cross principal ownership", async () => {
    fake = fakeDirect("owned task");
    const created = await request("POST", "/api/agent/run", { goal: "Principal-owned task" }, { "X-Sidekick-Principal-ID": "principal_alpha" });
    assert.strictEqual(created.status, 200);
    await waitForTranscript(created.data.taskId);
    const allowed = await request("GET", "/api/agent/tasks/" + created.data.taskId, null, { "X-Sidekick-Principal-ID": "principal_alpha" });
    assert.strictEqual(allowed.status, 200);
    const forged = await request("GET", "/api/agent/tasks/" + created.data.taskId, null, { "X-Sidekick-Principal-ID": "principal_alpha" }, false);
    assert.strictEqual(forged.status, 401, "loopback caller cannot forge a Dashboard principal header");
    const unsignedList = await request("GET", "/api/agent/tasks", null, {}, false);
    assert.strictEqual(unsignedList.status, 401, "unsigned loopback callers cannot enumerate durable tasks");
    const mcpKeySpoof = await request("GET", "/api/agent/tasks/" + created.data.taskId, null, { "X-Sidekick-Principal-ID": "principal_alpha" }, true, process.env.SIDEKICK_API_KEY);
    assert.strictEqual(mcpKeySpoof.status, 401, "the shared MCP client key cannot forge Dashboard proxy identity");
    const denied = await request("GET", "/api/agent/tasks/" + created.data.taskId, null, { "X-Sidekick-Principal-ID": "principal_beta" });
    assert.strictEqual(denied.status, 404);
    const legacyDenied = await request("GET", "/api/agent/run/" + created.data.taskId, null, { "X-Sidekick-Principal-ID": "principal_beta" });
    assert.strictEqual(legacyDenied.status, 404, "legacy task detail must retain principal scoping");
    const streamDenied = await request("GET", "/api/agent/stream/" + created.data.taskId, null, { "X-Sidekick-Principal-ID": "principal_beta" });
    assert.strictEqual(streamDenied.status, 404, "SSE must retain principal scoping");
    const followupDenied = await request("POST", "/api/agent/run/" + created.data.taskId + "/follow-up", { goal: "read another principal's result" }, { "X-Sidekick-Principal-ID": "principal_beta" });
    assert.strictEqual(followupDenied.status, 404, "follow-up must retain principal scoping");
  });

  // 2/3) A valid follow-up creates a distinct child with correct parent/root ids.
  let rootId, childId;
  await ok("2/3) follow-up creates a distinct child with correct parent+root ids", async () => {
    fake = fakeDirect("root answer: disk 92%");
    rootId = await runRootTask("Say the disk summary");
    fake = fakeDirect("summary done");
    const res = await request("POST", "/api/agent/run/" + rootId + "/follow-up", { goal: "Summarize that result." });
    assert.strictEqual(res.status, 200);
    childId = res.data.taskId;
    assert.match(childId, /^[0-9a-f]{8}$/);
    assert.notStrictEqual(childId, rootId, "child is a new task");
    assert.strictEqual(res.data.parentTaskId, rootId);
    assert.strictEqual(res.data.rootTaskId, rootId);
    await waitForTranscript(childId);
    const parentDetail = await request("GET", "/api/agent/tasks/" + rootId);
    const childDetail = await request("GET", "/api/agent/tasks/" + childId);
    assert.strictEqual(childDetail.status, 200);
    assert.strictEqual(childDetail.data.task.authority_envelope.child_task_count, Math.max(0, Number(parentDetail.data.task.authority_envelope.child_task_count) - 1), "follow-up receives a narrowed fan-out envelope");
  });

  await ok("2b) act-on cannot amplify the parent resource profile", async () => {
    fake = fakeDirect("should not run");
    const res = await request("POST", "/api/agent/tasks/" + rootId + "/act-on", { kind: "continue", goal: "broaden budget", profile: "persistent" });
    assert.strictEqual(res.status, 403);
    assert.match(JSON.stringify(res.data), /broaden|profile/i);
  });

  // 4) The parent transcript remains byte-for-byte unchanged.
  await ok("4) parent transcript is unchanged by a follow-up", async () => {
    fake = fakeDirect("p");
    const pid = await runRootTask("Say parent");
    const before = fs.readFileSync(transcriptPath(pid));
    fake = fakeDirect("c");
    const res = await request("POST", "/api/agent/run/" + pid + "/follow-up", { goal: "Summarize that." });
    assert.strictEqual(res.status, 200);
    await waitForTranscript(res.data.taskId);
    const after = fs.readFileSync(transcriptPath(pid));
    assert.ok(before.equals(after), "parent transcript bytes must not change");
  });

  // 5) The child transcript records correct lineage.
  await ok("5) child transcript records correct lineage", async () => {
    const raw = JSON.parse(fs.readFileSync(transcriptPath(childId), "utf-8"));
    assert.strictEqual(raw.parent_task_id, rootId);
    assert.strictEqual(raw.root_task_id, rootId);
    assert.strictEqual(raw.continuation_depth, 1);
    // v3 added the authoritative top-level result/error. The change is additive
    // — v2 transcripts stay readable and resolve their answer from `steps` —
    // but the version moves so a reader knows whether `result` can be trusted
    // directly or must fall back.
    assert.strictEqual(raw.v, 3);
    assert.ok("result" in raw, "v3 transcripts carry a top-level result");
  });

  // 6) A follow-up of a follow-up retains the original root.
  await ok("6) follow-up of a follow-up retains the original root", async () => {
    fake = fakeDirect("second child");
    const res = await request("POST", "/api/agent/run/" + childId + "/follow-up", { goal: "And summarize again." });
    assert.strictEqual(res.status, 200);
    const child2 = res.data.taskId;
    assert.strictEqual(res.data.rootTaskId, rootId, "root stays the original root");
    assert.strictEqual(res.data.parentTaskId, childId);
    await waitForTranscript(child2);
    const raw = JSON.parse(fs.readFileSync(transcriptPath(child2), "utf-8"));
    assert.strictEqual(raw.root_task_id, rootId);
    assert.strictEqual(raw.continuation_depth, 2);
  });

  // 7) An invalid task id is rejected.
  await ok("7) invalid task id is rejected (400)", async () => {
    for (const bad of ["ZZZZZZZZ", "a1b2c3d", "not-an-id", "%2e%2e"]) {
      const res = await request("POST", "/api/agent/run/" + bad + "/follow-up", { goal: "x" });
      assert.strictEqual(res.status, 400, "expected 400 for " + bad + " got " + res.status);
    }
  });

  // 8) Path-traversal forms are rejected (never reach the filesystem as a path).
  await ok("8) path-traversal forms are rejected", async () => {
    for (const bad of ["..", "aaaa..aa", "aaaaaaaa%2f", "%2f%2f%2f%2f"]) {
      const res = await request("POST", "/api/agent/run/" + bad + "/follow-up", { goal: "x" });
      assert.ok(res.status === 400 || res.status === 404, "traversal rejected for " + bad + " got " + res.status);
      if (typeof res.data === "object") {
        assert.doesNotMatch(JSON.stringify(res.data), /conversations|\/data|ENOENT|at Object|\.js:/, "no path/stack leak");
      }
    }
  });

  // 9) A nonexistent (but well-formed) task returns not-found.
  await ok("9) nonexistent task returns 404", async () => {
    const res = await request("POST", "/api/agent/run/deadbeef/follow-up", { goal: "x" });
    assert.strictEqual(res.status, 404);
  });

  // 10) An active parent returns a conflict.
  await ok("10) an actively-running parent returns 409 conflict", async () => {
    // Make the LLM hang for this task so no transcript is written while running.
    fake = () => new Promise(() => {});
    const started = await request("POST", "/api/agent/run", { goal: "hang for a while" });
    assert.strictEqual(started.status, 200);
    // Transcript not yet written; the parent is mid-run.
    const res = await request("POST", "/api/agent/run/" + started.data.taskId + "/follow-up", { goal: "x" });
    assert.strictEqual(res.status, 409);
    assert.match(JSON.stringify(res.data), /still running/);
  });

  // 11) A malformed parent transcript is handled safely.
  await ok("11) malformed parent transcript handled safely (422, no leak)", async () => {
    const badId = "beefbeef";
    fs.writeFileSync(transcriptPath(badId), "{ this is not valid json", "utf-8");
    const res = await request("POST", "/api/agent/run/" + badId + "/follow-up", { goal: "x" });
    assert.strictEqual(res.status, 422);
    assert.doesNotMatch(JSON.stringify(res.data), /conversations|ENOENT|\.js:|SyntaxError/);
  });

  // 12/13) Failed and iteration-limited parents may be followed up.
  await ok("12/13) failed and iteration-limited parents may be followed up", async () => {
    for (const status of ["failed", "iteration_limit"]) {
      const id = status === "failed" ? "faafaafa" : "17171717";
      fs.writeFileSync(transcriptPath(id), JSON.stringify({
        goal: "prior " + status, status,
        steps: [{ type: "error", text: "boom" }],
        t: new Date().toISOString(), v: 2, root_task_id: id, continuation_depth: 0,
      }), "utf-8");
      fake = fakeDirect("continued from " + status);
      const res = await request("POST", "/api/agent/run/" + id + "/follow-up", { goal: "Explain the failure." });
      assert.strictEqual(res.status, 200, status + " parent should be continuable");
      assert.strictEqual(res.data.parentTaskId, id);
      await waitForTranscript(res.data.taskId);
    }
  });

  // 14) The continuation brief reaches the direct-answer path.
  await ok("14) continuation brief reaches the direct-answer path", async () => {
    fake = fakeDirect("root gave: mount /data is full");
    const pid = await runRootTask("Say the mount status");
    fake = fakeDirect("summarized");
    seen.direct = null;
    const res = await request("POST", "/api/agent/run/" + pid + "/follow-up", { goal: "Summarize that in one sentence." });
    assert.strictEqual(res.status, 200);
    await waitForTranscript(res.data.taskId);
    assert.ok(seen.direct, "direct path LLM was invoked");
    const all = seen.direct.map(m => m.content).join("\n");
    assert.match(all, /UNTRUSTED/, "continuation brief present on direct path");
    assert.match(all, /Say the mount status/, "prior goal present on direct path");
    // The untrusted brief must not ride on a system-role message.
    const sys = seen.direct.filter(m => m.role === "system").map(m => m.content).join("\n");
    assert.doesNotMatch(sys, /UNTRUSTED/, "brief must not be a system message");
  });

  // 15/16) The brief reaches the tool loop, and child tool calls pass through callAgentTool.
  await ok("15/16) brief reaches the tool loop and tool calls go through callAgentTool", async () => {
    fake = fakeDirect("root: service X restarted");
    const pid = await runRootTask("Say the service state");
    seen.tool = null;
    // A tool-requiring follow-up ("disk"/"current") + emit a real tool call.
    fake = fakeToolThenDone([{ tool: "sidekick_respond", arguments: { text: "checked" } }]);
    const res = await request("POST", "/api/agent/run/" + pid + "/follow-up", {
      goal: "Now check the current disk usage of that service's mount.",
    });
    await waitForTranscript(res.data.taskId);
    assert.ok(seen.tool, "tool-loop LLM was invoked (tool path taken)");
    const all = seen.tool.map(m => m.content).join("\n");
    assert.match(all, /UNTRUSTED/, "continuation brief present on tool path");
    const child = JSON.parse(fs.readFileSync(transcriptPath(res.data.taskId), "utf-8"));
    const toolStep = child.steps.find(s => s.type === "tool");
    assert.ok(toolStep, "a tool step was recorded");
    // A dispatcher-produced result string proves the call went through callAgentTool
    // rather than being fabricated by the loop.
    assert.strictEqual(typeof toolStep.result, "string");
  });

  await ok("15b) a read-only Agent task runs a registered workflow that dispatches a core tool", async () => {
    const workflows = require("../src/workflows/repository");
    const dbStore = require("../src/db");
    const readName = "core/agent-task-read-fixture";
    workflows.registerWorkflowDefinition({
      name: readName, version: "1.0.0", title: "Agent task core read", description: "A read-only workflow composed with the canonical core tools",
      mode: "read_only", inputs: {},
      steps: [{ name: "catalog", tool: "tools", args: { action: "overview" }, expect: "text" }],
      result: { catalog: "${steps.catalog.text}" },
    }, { ownerKind: "core" });
    fake = fakeToolThenDone([
      { tool: "workflow", arguments: { action: "run", name: readName, inputs: {} } },
      { done: true, result: "I inspected the registered core catalog workflow." },
    ]);
    const allowed = await request("POST", "/api/agent/run", {
      goal: "Inspect the tool catalog through the registered workflow and summarize it",
      goal_spec: { read_only: true, success_criteria: ["the registered workflow returned catalog evidence"] },
    }, authenticatedTestHeaders);
    assert.equal(allowed.status, 200);
    const readTranscript = await waitForTranscript(allowed.data.taskId);
    const workflowCall = readTranscript.steps.find(step => step.type === "tool" && step.tool === "workflow");
    assert.ok(workflowCall && !/^Error:/.test(workflowCall.result || ""), `the read-only workflow dispatch must succeed: ${JSON.stringify(workflowCall)}`);
    const readRun = dbStore.getDb().prepare("SELECT workflow_id FROM platform_workflows WHERE name = ? ORDER BY created_at DESC LIMIT 1").get(readName)?.workflow_id;
    assert.ok(readRun, "the workflow tool created a durable run");
    const readRecord = dbStore.getDb().prepare("SELECT state FROM platform_workflows WHERE workflow_id = ?").get(readRun);
    assert.equal(readRecord.state, "completed");
    const coreStep = dbStore.getDb().prepare("SELECT state FROM platform_workflow_steps WHERE workflow_id = ? AND step_index = 0").get(readRun);
    assert.equal(coreStep.state, "completed", "the nested core `tools` capability really dispatched");
  });

  // 17) A blocked / non-visible tool remains blocked in a follow-up.
  await ok("17) a tool not visible to the agent source stays blocked in a follow-up", async () => {
    fake = fakeDirect("root");
    const pid = await runRootTask("Say something");
    fake = fakeToolThenDone([
      { tool: "sidekick_totally_not_a_real_tool", arguments: {} },
      { done: true, result: "gave up" },
    ]);
    const res = await request("POST", "/api/agent/run/" + pid + "/follow-up", { goal: "Now inspect the current logs." });
    await waitForTranscript(res.data.taskId);
    const child = JSON.parse(fs.readFileSync(transcriptPath(res.data.taskId), "utf-8"));
    const toolStep = child.steps.find(s => s.type === "tool" && s.tool === "sidekick_totally_not_a_real_tool");
    assert.ok(toolStep, "unknown tool call recorded");
    assert.match(String(toolStep.result || ""), /is not available to this agent/i, "unknown tool must be rejected");
  });

  // 18) No earlier approval is inherited: the follow-up endpoint ignores any
  // client-supplied approval fields and only honors `goal`.
  await ok("18) follow-up ignores client-supplied approval fields (no inherited approval)", async () => {
    fake = fakeDirect("root");
    const pid = await runRootTask("Say ok");
    fake = fakeDirect("child ok");
    const res = await request("POST", "/api/agent/run/" + pid + "/follow-up", {
      goal: "Summarize that.", approve: true, approvalId: "appr_forged", approved: true,
    });
    assert.strictEqual(res.status, 200);
    await waitForTranscript(res.data.taskId);
    const child = JSON.parse(fs.readFileSync(transcriptPath(res.data.taskId), "utf-8"));
    assert.strictEqual(child.approvalId, undefined);
    assert.strictEqual(child.approve, undefined);
  });

  // 19) Child SSE streaming works through the existing stream endpoint.
  await ok("19) child SSE stream works via the existing endpoint", async () => {
    fake = fakeDirect("root");
    const pid = await runRootTask("Say hi");
    // Delay the child's LLM so the stream can attach before terminal events fire.
    fake = () => new Promise((r) => setTimeout(() => r({ response: "streamed answer", provider: "test", model: "test-model" }), 250));
    const res = await request("POST", "/api/agent/run/" + pid + "/follow-up", { goal: "Summarize that." });
    const childTaskId = res.data.taskId;
    const events = await new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const streamPath = "/api/agent/stream/" + childTaskId;
      const req = http.request({ hostname: "127.0.0.1", port, path: streamPath, method: "GET", headers: createAgentProxyHeaders({ secret: process.env.SIDEKICK_AGENT_PROXY_KEY, method: "GET", path: streamPath }) }, (r) => {
        r.on("data", (c) => {
          chunks.push(c.toString());
          const output = chunks.join("");
          if (output.includes('"type":"done"')) {
            finish(output);
            req.destroy();
          }
        });
        r.on("end", () => finish(chunks.join("")));
      });
      req.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      req.end();
      // Wait for the actual terminal frame instead of cutting off a healthy
      // stream after a fixed delay. Context assembly, durable verification,
      // and memory recording can be slow under coverage instrumentation.
      timer = setTimeout(() => {
        const output = chunks.join("");
        finish(output);
        req.destroy();
      }, 60000);
    });
    assert.match(events, /data:/, "SSE data frames were streamed");
    assert.match(events, /"type":"done"/, "SSE delivered the terminal done event");
    await waitForTranscript(childTaskId);
  });

  await ok("19b) SSE closes when project membership is revoked", async () => {
    const identity = require("../src/core/identity");
    const projectAccess = require("../src/core/project-access");
    const principal = identity.createHumanUser({ username: "sse_revocation_reader", password: "a sufficiently long sse reader password" });
    identity.assignRole(principal.principal_id, "operator", authenticatedTestPrincipal.authIdentity.principal_id);
    projectAccess.grantProjectAccess({ actorPrincipalId: authenticatedTestPrincipal.authIdentity.principal_id, principalId: principal.principal_id, project: "agent_test_project", accessLevel: "read" });
    const headers = { "X-Sidekick-Principal-ID": principal.principal_id, "X-Sidekick-Principal-Scopes": JSON.stringify(["agent.tasks.read"]) };
    fake = () => new Promise((resolve) => setTimeout(() => resolve({ response: "must not reach a revoked stream", provider: "test", model: "test-model" }), 4000));
    const created = await request("POST", "/api/agent/run", { goal: "verify stream membership revocation", project: "agent_test_project" }, headers);
    assert.strictEqual(created.status, 200);
    const streamPath = "/api/agent/stream/" + created.data.taskId;
    let connected;
    const attached = new Promise(resolve => { connected = resolve; });
    const ended = new Promise((resolve, reject) => {
      let body = "";
      const req = http.request({ hostname: "127.0.0.1", port, path: streamPath, method: "GET", headers: createAgentProxyHeaders({ secret: process.env.SIDEKICK_AGENT_PROXY_KEY, method: "GET", path: streamPath, principalId: principal.principal_id, scopes: ["agent.tasks.read"] }) }, (res) => {
        res.on("data", chunk => { body += chunk.toString(); connected(); });
        res.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.end();
    });
    await attached;
    assert.equal(projectAccess.revokeProjectAccess({ actorPrincipalId: authenticatedTestPrincipal.authIdentity.principal_id, principalId: principal.principal_id, project: "agent_test_project" }), true);
    const body = await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error("revoked SSE connection remained open")), 1500))]);
    assert.doesNotMatch(body, /data:/, "revoked stream emits no task content after admission");
    await waitForTranscript(created.data.taskId);
  });

  // 20) History and task detail expose lineage without breaking old tasks.
  await ok("20) history and detail expose lineage; old tasks still load", async () => {
    // Write an OLD-style transcript with no lineage fields. Use a high-sorting id
    // so it lands in the history top-N (history sorts by filename descending).
    const oldId = "ffffffff";
    fs.writeFileSync(transcriptPath(oldId), JSON.stringify({ goal: "legacy task", status: "completed", steps: [{ type: "done", text: "done" }], t: new Date().toISOString() }), "utf-8");
    const hist = await request("GET", "/api/agent/history");
    assert.strictEqual(hist.status, 200);
    // Every row carries lineage fields (missing optional fields never break the list).
    for (const r of hist.data.runs) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, "parentTaskId"), "row exposes parentTaskId");
      assert.ok(r.rootTaskId, "row exposes rootTaskId");
    }
    const oldRow = hist.data.runs.find(r => r.id === oldId);
    assert.ok(oldRow, "old task appears in history");
    assert.strictEqual(oldRow.parentTaskId, null, "old task normalizes to root (no parent)");
    assert.strictEqual(oldRow.rootTaskId, oldId, "old task roots to itself");

    // Detail endpoint is deterministic (not subject to the history top-N window).
    const oldDetail = await request("GET", "/api/agent/run/" + oldId);
    assert.strictEqual(oldDetail.status, 200);
    assert.strictEqual(oldDetail.data.parent_task_id, null);
    assert.ok(Array.isArray(oldDetail.data.steps), "old detail still returns steps");

    const childDetail = await request("GET", "/api/agent/run/" + childId);
    assert.strictEqual(childDetail.status, 200);
    assert.strictEqual(childDetail.data.parent_task_id, rootId);
    assert.strictEqual(childDetail.data.root_task_id, rootId);
    assert.strictEqual(childDetail.data.continuation_depth, 1);

    // Detail endpoint also validates the id (hardening) without breaking old tasks.
    const badDetail = await request("GET", "/api/agent/run/" + "..%2f..");
    assert.ok(badDetail.status === 400 || badDetail.status === 404);
  });

  // Security: oversized follow-up goal is rejected.
  await ok("security) oversized follow-up goal is rejected (422)", async () => {
    fake = fakeDirect("root");
    const pid = await runRootTask("Say ok");
    const res = await request("POST", "/api/agent/run/" + pid + "/follow-up", { goal: "x".repeat(50000) });
    assert.strictEqual(res.status, 422);
  });

  // Security: excessive continuation depth is rejected.
  await ok("security) excessive continuation depth is rejected (422)", async () => {
    const deepId = "deadc0de";
    const max = require("../src/agent-continuation").CONTINUATION_LIMITS.MAX_CONTINUATION_DEPTH;
    fs.writeFileSync(transcriptPath(deepId), JSON.stringify({
      goal: "deep parent", status: "completed", steps: [{ type: "done", text: "d" }],
      t: new Date().toISOString(), v: 2, root_task_id: "aaaaaaaa", parent_task_id: null, continuation_depth: max,
    }), "utf-8");
    const res = await request("POST", "/api/agent/run/" + deepId + "/follow-up", { goal: "go deeper" });
    assert.strictEqual(res.status, 422);
    assert.match(JSON.stringify(res.data), /depth/i);
  });

  await ok("security) restart recovery blocks a revoked task identity before invoking the Agent loop", async () => {
    const identity = require("../src/core/identity");
    const authentication = require("../src/core/authentication");
    const taskStore = require("../src/agent/task-store");
    const { createTask } = require("../src/agent/task-model");
    const principal = identity.createPrincipal({ type: "human", displayName: "Synthetic recovered-task principal" });
    const issued = authentication.createCredential({
      principalId: principal.principal_id,
      displayName: "Synthetic recovered-task credential",
      scopes: ["agent.tasks.read", "tools.execute"],
    });
    const taskId = "agt_security_recovery_launch01";
    taskStore.insertTask(createTask({
      task_id: taskId,
      objective: "synthetic recovery must not reach the runner",
      actor_principal_id: principal.principal_id,
      requested_by_principal_id: principal.principal_id,
      principal_context: { credential_id: issued.credential.credential_id, credential_scopes: issued.credential.scopes },
    }));
    taskStore.updateTask(taskId, { state: "planning" });
    taskStore.updateTask(taskId, { state: "ready" });
    taskStore.updateTask(taskId, { state: "running" });
    taskStore.updateTask(taskId, { state: "interrupted" });
    assert.strictEqual(authentication.revokeCredential(issued.credential.credential_id), true);

    let runnerCalls = 0;
    const launched = agent.__launchRecoveredDurableTaskForTests(taskId, {
      runAgentImpl: async () => { runnerCalls++; },
    });
    assert.strictEqual(launched, false);
    assert.strictEqual(runnerCalls, 0, "revoked authority must be rejected before the Agent loop can run");
    const blocked = taskStore.getTask(taskId);
    assert.strictEqual(blocked.state, "blocked");
    assert.strictEqual(blocked.phase, "recovery");
    assert.strictEqual(blocked.last_error_code, "recovery_authorization_denied");
  });

  console.log("\nAll " + passed + " follow-up API/security tests passed.\n");
  server.close();
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try { server && server.close(); } catch {}
  process.exit(1);
});
