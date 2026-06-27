const assert = require("assert");
const {
  parseAgentDecision,
  decisionFingerprint,
  trackDecisionRepetition,
  selectBestModelName,
  buildChatMessages,
  requiresToolUse
} = require("../src/agent-protocol");

console.log("Running Agent Bridge protocol tests...\n");

const fencedAction = parseAgentDecision(`\`\`\`json
{
  "action": "sidekick_respond",
  "text": "Hello"
}
\`\`\``);
assert.deepStrictEqual(fencedAction, {
  tool: "sidekick_respond",
  arguments: { text: "Hello" }
});

const multilineTool = parseAgentDecision(`{
  "tool": "sidekick_project",
  "arguments": {
    "name": "sidekick",
    "include": "kv,context"
  }
}`);
assert.deepStrictEqual(multilineTool, {
  tool: "sidekick_project",
  arguments: { name: "sidekick", include: "kv,context" }
});

const thought = parseAgentDecision('{"thought":"Inspect the project first"}');
assert.deepStrictEqual(thought, { think: "Inspect the project first" });

const responseOnly = parseAgentDecision('{"response":"agent smoke test passed"}');
assert.deepStrictEqual(responseOnly, { done: true, result: "agent smoke test passed" });

const malformed = parseAgentDecision("not valid JSON");
assert.deepStrictEqual(malformed, { think: "not valid JSON" });

assert.strictEqual(
  decisionFingerprint({ tool: "sidekick_get", arguments: { project: "sidekick", key: "a" } }),
  decisionFingerprint({ arguments: { key: "a", project: "sidekick" }, tool: "sidekick_get" })
);

let repeatState = { fingerprint: "", repeats: 0 };
const repeatedDecision = { think: "Inspect the project" };
repeatState = trackDecisionRepetition(repeatState, repeatedDecision);
assert.strictEqual(repeatState.repeated, false);
repeatState = trackDecisionRepetition(repeatState, repeatedDecision);
assert.strictEqual(repeatState.repeated, true);
assert.strictEqual(repeatState.abort, false);
repeatState = trackDecisionRepetition(repeatState, repeatedDecision);
assert.strictEqual(repeatState.abort, true);

assert.strictEqual(
  selectBestModelName(["qwen2.5-coder:7b", "llama3.1:8b"]),
  "llama3.1:8b"
);
assert.strictEqual(
  selectBestModelName(["qwen2.5-coder:7b", "llama3.1:8b"], "custom:latest"),
  "custom:latest"
);

assert.deepStrictEqual(
  buildChatMessages("system rules", [
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" }
  ]),
  [
    { role: "system", content: "system rules" },
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" }
  ]
);

assert.strictEqual(requiresToolUse("How many tools does this Sidekick project have?"), true);
assert.strictEqual(requiresToolUse("List the available Sidekick tools."), true);
assert.strictEqual(requiresToolUse("What Sidekick services are currently running?"), true);
assert.strictEqual(requiresToolUse("Use sidekick_tools to search for database schema helpers."), true);
assert.strictEqual(requiresToolUse("Explain how Sidekick memory recall works."), false);
assert.strictEqual(requiresToolUse("Draft a better prompt for the Sidekick deploy helper."), false);
assert.strictEqual(requiresToolUse("How should Sidekick phrase a blocked-tool warning?"), false);
assert.strictEqual(requiresToolUse("Review the Sidekick routing heuristics for edge cases."), false);
assert.strictEqual(requiresToolUse("What is the capital of France?"), false);
assert.strictEqual(requiresToolUse("Explain quantum entanglement in simple terms."), false);

console.log("Agent Bridge protocol tests passed");
