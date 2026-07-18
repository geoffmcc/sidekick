const assert = require("assert");
const {
  parseAgentDecision,
  resolveAgentToolName,
  decisionFingerprint,
  trackDecisionRepetition,
  selectBestModelName,
  buildChatMessages,
  classifyEvidenceRequirement,
  requiresToolUse
} = require("../src/agent-protocol");

console.log("Running Agent Bridge protocol tests...\n");

// --- decision parsing: accepted shapes -------------------------------------

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

// Canonical (unprefixed) action names are accepted too — the pre-fix parser
// only recognized action values with the legacy sidekick_ prefix.
const canonicalAction = parseAgentDecision('{"action": "respond", "text": "Hello"}');
assert.deepStrictEqual(canonicalAction, {
  tool: "respond",
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

const canonicalTool = parseAgentDecision('{"tool": "bash", "arguments": {"command": "df -h"}}');
assert.deepStrictEqual(canonicalTool, { tool: "bash", arguments: { command: "df -h" } });

const thought = parseAgentDecision('{"thought":"Inspect the project first"}');
assert.deepStrictEqual(thought, { think: "Inspect the project first" });

const responseOnly = parseAgentDecision('{"response":"agent smoke test passed"}');
assert.deepStrictEqual(responseOnly, { done: true, result: "agent smoke test passed" });

const malformed = parseAgentDecision("not valid JSON");
assert.deepStrictEqual(malformed, { think: "not valid JSON" });

// --- decision parsing: hardened rejections ----------------------------------

// Prototype-pollution-shaped structures are rejected outright, wherever the
// forbidden key appears. (Raw JSON strings: an object literal with __proto__
// would set the prototype instead of an own key and mask the test.)
for (const payload of [
  '{"tool": "get", "__proto__": {"polluted": true}, "key": "x"}',
  '{"tool": "bash", "arguments": {"__proto__": {"polluted": true}}}',
  '{"tool": "bash", "arguments": {"nested": {"constructor": {"prototype": {"x": 1}}}}}',
  '{"done": true, "result": "ok", "prototype": {}}',
]) {
  const rejected = parseAgentDecision(payload);
  assert.strictEqual(rejected.invalid, true, "must reject: " + payload);
  assert.strictEqual(rejected.reason, "forbidden_key");
  assert.strictEqual(({}).polluted, undefined);
}

// Conflicting multi-action decisions are rejected — exactly one action per turn.
for (const payload of [
  '{"tool": "respond", "done": true, "result": "fake"}',
  '{"tool": "bash", "think": "and also run this"}',
  '{"done": true, "result": "x", "think": "hidden"}',
]) {
  const rejected = parseAgentDecision(payload);
  assert.strictEqual(rejected.invalid, true, "must reject: " + payload);
  assert.strictEqual(rejected.reason, "conflicting_actions");
}

// done without a usable string result never becomes a claimed success.
for (const payload of ['{"done": true}', '{"done": true, "result": ""}', '{"done": true, "result": {"nested": 1}}']) {
  const rejected = parseAgentDecision(payload);
  assert.strictEqual(rejected.invalid, true, "must reject: " + payload);
  assert.strictEqual(rejected.reason, "done_without_result");
}

// Malformed tool names are rejected before any lookup.
for (const payload of ['{"tool": "Bash", "arguments": {}}', '{"tool": "sidekick_", "arguments": {}}', '{"tool": 42, "arguments": {}}', '{"tool": "' + "x".repeat(200) + '", "arguments": {}}']) {
  const rejected = parseAgentDecision(payload);
  assert.strictEqual(rejected.invalid, true, "must reject: " + payload);
  assert.strictEqual(rejected.reason, "invalid_tool_name");
}

// An action value that is prose (not a plausible tool name) is not a tool call.
const proseAction = parseAgentDecision('{"action": "run the disk check now please"}');
assert.ok(!proseAction.tool, "prose action must not become a tool call");

// --- canonical tool-name resolution -----------------------------------------

const DEFS = [{ name: "bash", enabled: true }, { name: "respond", enabled: true }];
assert.strictEqual(resolveAgentToolName("bash", DEFS).name, "bash");
const aliased = resolveAgentToolName("sidekick_bash", DEFS);
assert.strictEqual(aliased.name, "bash", "legacy alias resolves to the canonical catalog name");
assert.strictEqual(aliased.alias, true);
assert.strictEqual(resolveAgentToolName("nonexistent", DEFS), null);
assert.strictEqual(resolveAgentToolName("sidekick_nonexistent", DEFS), null);
assert.strictEqual(resolveAgentToolName("__proto__", DEFS), null);
assert.strictEqual(resolveAgentToolName("sidekick___proto__", DEFS), null);
assert.strictEqual(resolveAgentToolName("Bash", DEFS), null, "names are case-sensitive lowercase");
assert.strictEqual(resolveAgentToolName("", DEFS), null);
assert.strictEqual(resolveAgentToolName(null, DEFS), null);
// A catalog that (defensively) still contains prefixed names keeps resolving.
const LEGACY_DEFS = [{ name: "sidekick_bash", enabled: true }];
assert.strictEqual(resolveAgentToolName("bash", LEGACY_DEFS).name, "sidekick_bash");
assert.strictEqual(resolveAgentToolName("sidekick_bash", LEGACY_DEFS).name, "sidekick_bash");

// --- repetition tracking -----------------------------------------------------

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

// Invalid decisions also track repetition so persistent invalid output aborts.
let invalidState = { fingerprint: "", repeats: 0 };
const invalidDecision = parseAgentDecision('{"done": true}');
invalidState = trackDecisionRepetition(invalidState, invalidDecision);
invalidState = trackDecisionRepetition(invalidState, parseAgentDecision('{"done": true}'));
assert.strictEqual(invalidState.repeated, true);

// --- model selection / chat assembly ----------------------------------------

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

// --- evidence classification --------------------------------------------------

assert.strictEqual(requiresToolUse("How many tools does this Sidekick project have?"), true);
assert.strictEqual(requiresToolUse("List the available Sidekick tools."), true);
assert.strictEqual(requiresToolUse("What Sidekick services are currently running?"), true);
assert.strictEqual(requiresToolUse("Use sidekick_tools to search for database schema helpers."), true);
assert.strictEqual(requiresToolUse("What Sidekick tools are available?"), true);
assert.strictEqual(requiresToolUse("Explain how Sidekick memory recall works."), false);
assert.strictEqual(requiresToolUse("Draft a better prompt for the Sidekick deploy helper."), false);
assert.strictEqual(requiresToolUse("How should Sidekick phrase a blocked-tool warning?"), false);
assert.strictEqual(requiresToolUse("Review the Sidekick routing heuristics for edge cases."), false);
assert.strictEqual(requiresToolUse("What tools should we build next for Sidekick?"), false);
assert.strictEqual(requiresToolUse("Which models should Sidekick support next?"), false);
assert.strictEqual(requiresToolUse("What is the capital of France?"), false);
assert.strictEqual(requiresToolUse("Explain quantum entanglement in simple terms."), false);

// System-inspection requests must route to the tool loop, not the direct-answer
// path — otherwise the Agent tab only explains commands instead of running them.
assert.strictEqual(requiresToolUse("check disk usage"), true);
assert.strictEqual(requiresToolUse("How much free memory is available right now?"), true);
assert.strictEqual(requiresToolUse("What is the current CPU load?"), true);
assert.strictEqual(requiresToolUse("Show running processes on the server."), true);
assert.strictEqual(requiresToolUse("Check system uptime."), true);
assert.strictEqual(requiresToolUse("Is swap being used?"), true);
assert.strictEqual(requiresToolUse("List the open ports."), true);
assert.strictEqual(requiresToolUse("Check disk usage and tell me which mounted filesystem has the least free space."), true);
assert.strictEqual(requiresToolUse("How much disk space is currently free?"), true);
assert.strictEqual(requiresToolUse("Is the Sidekick service running?"), true);
assert.strictEqual(requiresToolUse("Show the current Git status."), true);
assert.strictEqual(requiresToolUse("How full is the drive?"), true);
assert.strictEqual(requiresToolUse("Which mounted volume has the least space left?"), true);
// Conceptual questions about the same resources stay conversational.
assert.strictEqual(requiresToolUse("Explain how disk usage works."), false);
assert.strictEqual(requiresToolUse("Describe what CPU load average means."), false);
assert.strictEqual(requiresToolUse("How can I check disk usage on Linux?"), false);
assert.strictEqual(requiresToolUse("Explain filesystem capacity."), false);
assert.strictEqual(requiresToolUse("What does system load mean?"), false);

// The classifier exposes a stable reason for observability and tests.
assert.deepStrictEqual(classifyEvidenceRequirement("check disk usage"),
  { requiresTools: true, reason: "system_inspection" });
assert.deepStrictEqual(classifyEvidenceRequirement("Use sidekick_tools to search for database schema helpers."),
  { requiresTools: true, reason: "explicit_tool_reference" });
assert.deepStrictEqual(classifyEvidenceRequirement("Explain quantum entanglement in simple terms."),
  { requiresTools: false, reason: "conceptual_prompt" });
assert.deepStrictEqual(classifyEvidenceRequirement("What is the capital of France?"),
  { requiresTools: false, reason: "no_evidence_signals" });
assert.deepStrictEqual(classifyEvidenceRequirement(""),
  { requiresTools: false, reason: "empty_goal" });
assert.strictEqual(classifyEvidenceRequirement("What Sidekick services are currently running?").reason, "local_resource_signal");

console.log("Agent Bridge protocol tests passed");
