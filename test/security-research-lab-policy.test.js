"use strict";
const assert = require("assert");
const { evaluateLabPolicy, assertLabPolicy } = require("../src/security-research/lab-policy");

console.log("Running Security Research Lab Policy Tests...\n");
const safe = { kind: "disposable", isolation: "isolated", network_mode: "fixture", production_access: false };
assert.strictEqual(evaluateLabPolicy(safe, { destructive: false }).ok, true, "isolated fixture labs should be allowed");
assert.deepStrictEqual(evaluateLabPolicy({ ...safe, production_access: true }, {}).reasons, ["production_access_not_explicitly_disabled"]);
assert.strictEqual(evaluateLabPolicy(safe, { destructive: true }).ok, false, "destructive actions require approval");
assert.strictEqual(evaluateLabPolicy(safe, { destructive: true, approved: true, requires_snapshot: true, snapshot_present: true }).ok, true);
assert.throws(() => assertLabPolicy({ network_mode: "fixture" }, {}), /lab policy denied/);
console.log("Lab policy tests passed.");
