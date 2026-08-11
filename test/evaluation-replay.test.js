"use strict";
const assert = require("assert");
const { digest, createReplayRecord, evaluateReplay } = require("../src/platform/evaluation-replay");

console.log("Running Evaluation Replay Tests...\n");
const input = { references: ["execution:synthetic-1", "artifact:synthetic-observation"], observations: [{ status: "completed", value: "fixture" }] };
const first = createReplayRecord(input);
const second = createReplayRecord({ observations: [{ value: "fixture", status: "completed" }], references: input.references });
assert.strictEqual(first.input_digest, second.input_digest, "canonical replay digest should be order-stable for object keys");
assert.strictEqual(evaluateReplay(first, { input_digest: first.input_digest }).ok, true);
assert.deepStrictEqual(evaluateReplay(first).actions, [], "replay must never produce actions");
assert.throws(() => createReplayRecord({ references: ["https://example.test/evidence"], observations: [] }), /opaque/);
assert.throws(() => evaluateReplay({ schema: "replay-v1", side_effects: true, actions: [] }), /side-effect safe/);
assert.ok(digest({ synthetic: true }).startsWith("sha256:"));
console.log("Evaluation replay tests passed.");
