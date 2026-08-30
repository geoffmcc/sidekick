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
process.env.NODE_ENV = "test";
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
const liveContracts = agent.getLiveAgentToolContracts();

ok("prompt catalog is derived from the live agent-visible registry", () => {
  assert.ok(visibleDefs.length > 0, "agent-visible catalog must not be empty");
  for (const def of visibleDefs.slice(0, 10)) {
    assert.ok(prompt.includes("- " + def.name + "("), "catalog must list " + def.name);
  }
});

ok("Agent preflight receives canonical schemas for visible tools", () => {
  assert.ok(liveContracts.length > 0, "canonical Agent contracts must not be empty");
  const contracts = new Map(liveContracts.map(contract => [contract.name, contract]));
  for (const def of visibleDefs) {
    const contract = contracts.get(def.name);
    assert.ok(contract, "canonical contract must exist for " + def.name);
    assert.strictEqual(typeof contract.schema.safeParse, "function", "canonical schema must be available for " + def.name);
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

ok("prompt context describes installed capability packs and lifecycle state", () => {
  const packContext = agent.buildInstalledPackContext({
    listPacks: () => [{ name: "proxmox", state: "enabled" }],
    describePack: () => ({
      name: "proxmox",
      display_name: "Proxmox VE",
      version: "1.0.0",
      state: "enabled",
      description: "Manage Proxmox VE resources through governed operations.",
      tools: ["proxmox"],
      workflows: [{ name: "proxmox/guest-lifecycle" }],
    }),
  });
  assert.ok(packContext.includes("proxmox (Proxmox VE) v1.0.0"), "pack identity and version are visible");
  assert.ok(packContext.includes("state=enabled; usable"), "enabled state is actionable");
  assert.ok(packContext.includes("proxmox/guest-lifecycle"), "pack workflows are visible");
  assert.ok(packContext.includes("knowledge tool"), "pack knowledge guidance is visible");

  const disabledContext = agent.buildInstalledPackContext({
    listPacks: () => [{ name: "proxmox", state: "disabled" }],
    describePack: () => ({ name: "proxmox", state: "disabled" }),
  });
  assert.ok(disabledContext.includes("state=disabled; not usable"), "disabled packs are not advertised as usable");
  assert.ok(!disabledContext.includes("consult the knowledge tool"), "disabled packs do not receive active-use guidance");
});

ok("generic capability descriptions select semantic context for repository questions", () => {
  const catalog = agent.buildSystemPrompt("Profile this repo");
  const semanticAvailable = catalog.includes("- semantic_repo(");
  for (const goal of ["Profile this repo", "Where is authentication implemented?", "What calls authenticate?", "Which tests exercise this module?", "What part of this codebase opens network connections?"]) {
    const shortlist = agent.buildSystemPrompt(goal).split("You have these tools:")[0];
    if (semanticAvailable) {
      assert.ok(shortlist.includes("- semantic_repo:"), "semantic_repo should be discoverable for: " + goal);
    } else {
      assert.ok(!shortlist.includes("- semantic_repo:"), "unavailable semantic_repo must not be advertised: " + goal);
    }
  }
  const unrelatedShortlist = agent.buildSystemPrompt("Tell me a joke").split("You have these tools:")[0];
  assert.ok(!unrelatedShortlist.includes("- semantic_repo:"), "unrelated prompts should not select semantic context");
});

console.log("\nAll " + passed + " prompt/routing tests passed.\n");
process.exit(0);
