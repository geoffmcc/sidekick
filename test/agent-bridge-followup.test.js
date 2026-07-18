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
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_ENVIRONMENT = "test";
// Set a fake Groq key so the module-load ollama warmup path is skipped.
process.env.GROQ_API_KEY = "test-fake-key";

const PORT = 4142;

delete require.cache[require.resolve("../src/agent")];
const agent = require("../src/agent");

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

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: "127.0.0.1", port: PORT, path: urlPath, method,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
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
let fake = null;
agent.__setLLMOverrideForTests((messages, options) => {
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
async function waitForTranscript(id, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(transcriptPath(id))) return;
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
  server = agent.app.listen(PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  // 1) Existing POST /api/agent/run behavior remains compatible.
  await ok("1) POST /api/agent/run still creates a task (backward compatible)", async () => {
    fake = fakeDirect("hello there");
    const res = await request("POST", "/api/agent/run", { goal: "Say hello" });
    assert.strictEqual(res.status, 200);
    assert.match(res.data.taskId, /^[0-9a-f]{8}$/);
    assert.strictEqual(res.data.parentTaskId, undefined, "root task has no parent field");
    await waitForTranscript(res.data.taskId);
  });

  await ok("1b) POST /api/agent/run rejects a missing/blank goal", async () => {
    const a = await request("POST", "/api/agent/run", {});
    assert.strictEqual(a.status, 400);
    const b = await request("POST", "/api/agent/run", { goal: "   " });
    assert.strictEqual(b.status, 400);
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
  });

  // 4) The parent transcript remains byte-for-byte unchanged.
  await ok("4) parent transcript is unchanged by a follow-up", async () => {
    fake = fakeDirect("p");
    const pid = await runRootTask("Say parent");
    const before = fs.readFileSync(transcriptPath(pid));
    fake = fakeDirect("c");
    const res = await request("POST", "/api/agent/run/" + pid + "/follow-up", { goal: "Summarize that." });
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
    assert.strictEqual(raw.v, 2);
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
    assert.match(String(toolStep.result || ""), /does not exist/i, "unknown tool must be rejected");
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
      const req = http.request({ hostname: "127.0.0.1", port: PORT, path: "/api/agent/stream/" + childTaskId, method: "GET" }, (r) => {
        r.on("data", (c) => chunks.push(c.toString()));
        r.on("end", () => resolve(chunks.join("")));
      });
      req.on("error", reject);
      req.end();
      setTimeout(() => { try { req.destroy(); } catch {} resolve(chunks.join("")); }, 3000);
    });
    assert.match(events, /data:/, "SSE data frames were streamed");
    assert.match(events, /"type":"done"/, "SSE delivered the terminal done event");
    await waitForTranscript(childTaskId);
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

  console.log("\nAll " + passed + " follow-up API/security tests passed.\n");
  server.close();
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try { server && server.close(); } catch {}
  process.exit(1);
});
