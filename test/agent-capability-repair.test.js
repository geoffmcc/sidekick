"use strict";

process.env.NODE_ENV = "test";
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";

const assert = require("assert");
const {
  classifyCapabilityFailure,
  preflightCapabilityCall,
  repairGuidance,
} = require("../src/agent/capability-repair");
const { runToolLoop } = require("../src/agent-loop");

function schema(required = []) {
  return {
    safeParse(value) {
      const issues = required.filter(key => value[key] == null).map(key => ({ path: [key], message: "Required" }));
      return issues.length ? { success: false, error: { issues } } : { success: true, data: value };
    },
  };
}

async function main() {
  const invalid = preflightCapabilityCall("media_control", {}, [{ name: "media_control", schema: schema(["action"]) }]);
  assert.strictEqual(invalid.ok, false);
  assert.match(invalid.error, /action/i);

  const mutual = classifyCapabilityFailure({ isError: true, code: "invalid_input", content: [{ text: "session_id, device_id and device_name are mutually exclusive" }] }, { tool: "media_control", args: {}, descriptor: { name: "media_control", risk: "low", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } } });
  assert.strictEqual(mutual.kind, "invalid_arguments");
  assert.strictEqual(mutual.retryable, true);
  assert.match(repairGuidance(mutual, { tool: "media_control" }), /exact live schema|mutually exclusive/i);

  const missingDescriptor = classifyCapabilityFailure({ isError: true, code: "invalid_input", content: [{ text: "invalid action" }] }, { tool: "workspace", args: { action: "write" } });
  assert.strictEqual(missingDescriptor.retryable, false, "missing canonical metadata must fail closed for retries");

  const policy = classifyCapabilityFailure({ isError: true, code: "forbidden", content: [{ text: "policy denied" }] }, { tool: "write", args: {} });
  assert.strictEqual(policy.kind, "policy_denied");
  assert.strictEqual(policy.retryable, false);

  const calls = [];
  let generation = 0;
  const outcome = await runToolLoop({
    history: [{ role: "user", content: "inspect the target" }],
    callLLM: async () => {
      generation++;
      return generation === 1
        ? { response: JSON.stringify({ tool: "inspect", arguments: { profile: "human target" } }) }
        : { response: JSON.stringify({ done: true, result: "Verified after discovery." }) };
    },
    callTool: async (_name, args) => {
      calls.push(args);
      return { isError: true, code: "profile_not_found", content: [{ text: "profile not found" }] };
    },
    getToolDefs: () => [{ name: "inspect", enabled: true }, { name: "respond", enabled: true }],
    maxIterations: 3,
    requireEvidence: false,
  });
  assert.strictEqual(outcome.status, "completed");
  assert.strictEqual(calls.length, 1, "a failed target lookup must not be blindly repeated");
  assert.ok(outcome.steps.some(step => step.type === "tool" && /profile not found/i.test(step.result)));

  console.log("Agent capability repair tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
