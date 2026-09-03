"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const transitions = {
  planned: new Set(["running", "cancelled"]),
  running: new Set(["completed", "failed", "cancelled", "awaiting_approval"]),
  awaiting_approval: new Set(["running", "cancelled", "expired"]),
  completed: new Set(), failed: new Set(), cancelled: new Set(), expired: new Set()
};

test("reference task model rejects illegal and non-monotonic transitions", () => {
  let state = "planned";
  for (const next of ["running", "awaiting_approval", "running", "completed"]) {
    assert.equal(transitions[state].has(next), true);
    state = next;
  }
  assert.equal(transitions[state].has("running"), false);
  assert.equal(transitions.cancelled.has("completed"), false);
});
