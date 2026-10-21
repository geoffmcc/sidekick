"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sidekick_evolve } = require("../src/tools/families/evolve");

test("direct evolve operations cannot inspect or change capability state without identity", async () => {
  const result = await sidekick_evolve({ action: "list" });
  assert.equal(result.isError, true);
  assert.equal(result.code, "unauthenticated");
});
