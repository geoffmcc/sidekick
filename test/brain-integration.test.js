"use strict";

// Brain v0.1 integration/flag-safety tests. Boots the real src/agent.js with a
// deterministic injected LLM and drives a task through the HTTP surface, once
// with Brain DISABLED (must behave exactly like the pre-Brain Agent Bridge)
// and once with Brain ENABLED (plans → validates → executes via the dispatcher
// → synthesizes). Tasks are awaited via the durable transcript (as
// agent-bridge-followup.test.js does), not SSE, to avoid subscriber races. No
// live model, network, or hardware.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-brain-"));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_ENVIRONMENT = "test";
process.env.GROQ_API_KEY = "test-fake-key";
delete process.env.SIDEKICK_BRAIN_ENABLED;

delete require.cache[require.resolve("../src/agent")];
const agent = require("../src/agent");

console.log("Running Brain v0.1 integration tests...\n");

let passed = 0, failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack || e}`); }
}

let server, port;
function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, r => {
      let out = ""; r.on("data", c => out += c); r.on("end", () => resolve({ status: r.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
function transcriptPath(id) { return path.join(agent.CONV_DIR, id + ".json"); }
async function waitForTranscript(id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(transcriptPath(id))) return JSON.parse(fs.readFileSync(transcriptPath(id), "utf-8"));
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for transcript " + id);
}
async function runGoal(goal) {
  const res = await post("/api/agent/run", { goal });
  assert.ok(res.body.taskId, "task started");
  return waitForTranscript(res.body.taskId);
}
function stepText(t) { return (t.steps || []).map(s => s.text || "").join("\n"); }

(async () => {
  server = agent.app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  port = server.address().port;

  // ---- Brain DISABLED: preserves current Agent Bridge behavior (T8) --------
  await ok("disabled flag: conceptual goal routes to direct answer, transcript has no Brain marker", async () => {
    agent.__setLLMOverrideForTests(async () => ({ response: "Paris is the capital of France.", provider: "test", model: "test" }));
    const t = await runGoal("What is the capital of France?");
    assert.strictEqual(t.status, "completed");
    assert.strictEqual(t.routing.requires_tools, false, "conceptual routing preserved");
    assert.strictEqual(t.brain, null, "Brain field is null when disabled");
    // The disabled path stores the same done-step shape as before (no Brain step ids).
    assert.ok(!t.steps.some(s => s.id), "no Brain-shaped steps");
    agent.__setLLMOverrideForTests(null);
  });

  await ok("disabled flag: evidence goal uses the existing tool loop, not Brain", async () => {
    agent.__setLLMOverrideForTests(async (messages) => {
      const already = messages.some(m => /Called/.test(m.content || ""));
      return { response: already ? JSON.stringify({ done: true, result: "Service is active." }) : JSON.stringify({ tool: "respond", arguments: { text: "Service is active." } }), provider: "test", model: "test" };
    });
    const t = await runGoal("Is the sidekick service currently running?");
    assert.ok(t.status === "completed" || t.status === "failed", "reached terminal");
    assert.strictEqual(t.brain, null, "Brain must not engage when disabled");
    agent.__setLLMOverrideForTests(null);
  });

  // ---- Brain ENABLED: plans → validates → executes → synthesizes -----------
  await ok("enabled flag: evidence goal plans, executes a real tool, and synthesizes", async () => {
    process.env.SIDEKICK_BRAIN_ENABLED = "1";
    agent.__setLLMOverrideForTests(async (messages, options) => {
      const sys = (options && options.systemPrompt) || "";
      if (/planning module/.test(sys)) {
        return { response: JSON.stringify({ version: 1, goal: "check git status", steps: [
          { id: "s1", type: "tool", tool: "git", arguments: { action: "status" }, purpose: "evidence" },
          { id: "s2", type: "synthesis", depends_on: ["s1"] },
        ] }), provider: "test", model: "test" };
      }
      return { response: "The repository status was retrieved.", provider: "test", model: "test" };
    });
    const t = await runGoal("Show the current git status of the repo");
    assert.ok(t.brain && t.brain.enabled === true, "Brain engaged (durable marker)");
    assert.ok(["completed", "failed"].includes(t.status), "reached a terminal state honestly");
    // The git tool step is recorded with a Brain step id, proving execution went
    // through the plan (not the legacy loop). Must not fabricate on failure.
    assert.ok(t.steps.some(s => s.type === "tool" && s.id === "s1" && s.tool === "git"), "git tool step executed via the plan");
    if (t.status === "completed") assert.strictEqual(t.brain.state, "completed");
    delete process.env.SIDEKICK_BRAIN_ENABLED;
    agent.__setLLMOverrideForTests(null);
  });

  await ok("enabled flag: a plan naming a disallowed tool fails closed (no execution)", async () => {
    process.env.SIDEKICK_BRAIN_ENABLED = "1";
    agent.__setLLMOverrideForTests(async (messages, options) => {
      const sys = (options && options.systemPrompt) || "";
      if (/planning module/.test(sys)) {
        return { response: JSON.stringify({ version: 1, goal: "x", steps: [
          { id: "s1", type: "tool", tool: "definitely_not_a_tool", arguments: {} },
          { id: "s2", type: "synthesis", depends_on: ["s1"] },
        ] }), provider: "test", model: "test" };
      }
      return { response: "should not synthesize", provider: "test", model: "test" };
    });
    const t = await runGoal("Do something with a fake tool");
    assert.strictEqual(t.status, "failed", "invalid plan fails closed");
    assert.ok(t.brain && t.brain.state === "failed", "Brain reported failure");
    assert.ok(!t.steps.some(s => s.type === "tool"), "no tool executed for a rejected plan");
    delete process.env.SIDEKICK_BRAIN_ENABLED;
    agent.__setLLMOverrideForTests(null);
  });

  server.close();
  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
