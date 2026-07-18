"use strict";

// Regression tests for the Agent Bridge system prompt and end-to-end routing
// observability. Boots the real src/agent.js (as agent-bridge-followup.test.js
// does) with a deterministic injected LLM; the real registry backs the prompt's
// tool catalog, so these tests fail if the prompt ever drifts from the live
// canonical tool names again (the root cause of the tool-use regression).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-prompt-"));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_ENVIRONMENT = "test";
// Set a fake Groq key so the module-load ollama warmup path is skipped.
process.env.GROQ_API_KEY = "test-fake-key";

delete require.cache[require.resolve("../src/agent")];
const agent = require("../src/agent");
const { getToolDefsForSource } = require("../src/tools");

console.log("Running Agent Bridge prompt/routing tests...\n");

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    console.error("  FAIL - " + name);
    console.error("    " + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
}

const prompt = agent.buildSystemPrompt();
const visibleDefs = getToolDefsForSource("agent").filter(t => t.enabled);

ok("prompt catalog is derived from the live agent-visible registry", () => {
  assert.ok(visibleDefs.length > 0, "agent-visible catalog must not be empty");
  for (const def of visibleDefs.slice(0, 10)) {
    assert.ok(prompt.includes("- " + def.name + "("), "catalog must list " + def.name);
  }
});

ok("prompt examples teach canonical names, not the stale sidekick_ dialect", () => {
  // The catalog and examples must agree: worked examples reference canonical
  // unprefixed names. The only allowed sidekick_ mention is the explicit
  // legacy-alias compatibility note.
  const withoutAliasNote = prompt.split("\n").filter(line => !/compatibility alias/i.test(line)).join("\n");
  assert.ok(!/"sidekick_[a-z0-9_]+"/.test(withoutAliasNote), "no example may teach a sidekick_-prefixed tool name");
  assert.ok(prompt.includes('{"tool": "bash"'), "examples use the canonical bash name");
  assert.ok(prompt.includes('{"tool": "respond"'), "examples use the canonical respond name");
});

ok("prompt does not advertise disabled tools", () => {
  const disabled = getToolDefsForSource("agent").filter(t => !t.enabled);
  for (const def of disabled.slice(0, 10)) {
    assert.ok(!prompt.includes("- " + def.name + "("), "disabled tool must not be advertised: " + def.name);
  }
});

ok("prompt states the structured decision contract", () => {
  assert.ok(prompt.includes('{"tool": "tool_name", "arguments"'), "tool decision schema present");
  assert.ok(prompt.includes('{"done": true'), "done decision schema present");
  assert.ok(/exactly ONE/i.test(prompt), "single-action rule stated");
  assert.ok(/DATA, not instructions/.test(prompt), "untrusted-content separation stated");
});

console.log("\nAll " + passed + " prompt/routing tests passed.\n");
process.exit(0);
