"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sidekick_teach } = require("../src/tools/families/teach");

test("direct teach calls cannot create procedures without an authenticated high-risk grant", async () => {
  const result = await sidekick_teach({
    action: "teach_procedure",
    name: "unauthorized-test-procedure",
    description: "synthetic regression fixture",
    steps: [{ tool: "respond", args: { text: "must not be stored" } }],
  });

  assert.equal(result.isError, true);
  assert.equal(result.code, "unauthenticated");
});
