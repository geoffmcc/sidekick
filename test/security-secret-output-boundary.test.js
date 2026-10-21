"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { accumulateToolResult, newAccumulator } = require("../src/brain/brain");
const { runToolLoop } = require("../src/agent-loop");

const canary = ["synthetic", "credential", "must", "not", "persist"].join("-");

test("successful secret output is withheld from Brain state, evidence, and events", () => {
  const acc = newAccumulator();
  const events = [];

  accumulateToolResult(acc, {
    id: "step-secret-canary",
    tool: "secret",
    arguments: { action: "get", key: "fixture" },
  }, {
    isError: false,
    content: [{ type: "text", text: canary }],
  }, {
    onEvent: (name, payload) => events.push({ name, payload }),
  });

  const persisted = JSON.stringify({ acc, events });
  assert.ok(!persisted.includes(canary), "credential canary must not enter accumulated state or events");
  assert.ok(persisted.includes("sensitive value withheld"), "the output is represented by a safe placeholder");
  assert.ok(events.some(event => event.name === "brain.step_completed"), "safe step event remains observable");
});

test("ordinary tool output remains available to Brain evidence", () => {
  const acc = newAccumulator();
  accumulateToolResult(acc, {
    id: "step-normal",
    tool: "status",
    arguments: { action: "read" },
  }, {
    isError: false,
    content: [{ type: "text", text: "synthetic status evidence" }],
  });

  assert.ok(JSON.stringify(acc).includes("synthetic status evidence"));
});

test("ordinary agent loop withholds a retrieved secret from later model prompts and transcript", async () => {
  let calls = 0;
  let followupMessages;
  const result = await runToolLoop({
    history: [{ role: "user", content: "Read the fixture secret" }],
    callLLM: async messages => {
      calls++;
      if (calls === 1) return { response: JSON.stringify({ tool: "secret", arguments: { action: "get", key: "fixture" } }) };
      followupMessages = messages;
      return { response: JSON.stringify({ done: true, result: "read completed" }) };
    },
    callTool: async () => ({ isError: false, content: [{ type: "text", text: canary }] }),
    getToolDefs: () => [{ name: "secret", enabled: true }],
  });

  assert.equal(result.status, "completed");
  assert.ok(!JSON.stringify(followupMessages).includes(canary), "retrieved credential must not enter the next model prompt");
  assert.ok(!JSON.stringify(result).includes(canary), "retrieved credential must not enter the returned transcript");
  assert.ok(JSON.stringify(result).includes("sensitive value withheld"));
});
