"use strict";
const assert = require("assert");
const { verifyTaskResult } = require("../src/agent/verification");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { console.error(`  ✗ ${name}: ${error.message}`); process.exitCode = 1; } }
test("requires current evidence for live tasks", () => { assert.strictEqual(verifyTaskResult({ requires_live_evidence: true, result: "ok" }).status, "unable_to_verify"); });
test("does not accept result text as evidence", () => { assert.strictEqual(verifyTaskResult({ criteria: ["healthy"], result: "healthy" }).status, "unable_to_verify"); });
test("marks criteria with attributable evidence", () => { const out = verifyTaskResult({ criteria: ["healthy"], result: "Service is healthy", evidence: [{ tool: "health", id: "ev1", ok: true, text: "healthy" }] }); assert.strictEqual(out.status, "verified"); assert.strictEqual(out.criteria_covered, 1); });
test("contradiction and terminal conditions remain honest", () => { assert.strictEqual(verifyTaskResult({ result: "x", evidence: [{ tool: "health", id: "e", ok: false, text: "error unavailable" }] }).status, "contradicted"); assert.strictEqual(verifyTaskResult({ terminal_state: "timed_out", result: "x" }).status, "budget_exhausted"); });
console.log(`Agent verification: ${passed} passed`);
