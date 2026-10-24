"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../..");

test("test launchers filter ambient credentials and loader hooks before starting child processes", () => {
  for (const [file, expectedOverride] of [
    ["scripts/test-flake.js", "SIDEKICK_PROPERTY_SEED"],
    ["scripts/test-coverage.js", "NODE_ENV"],
    ["scripts/test-mutation.js", "SIDEKICK_TEST_MUTATION_NODE_PATH"],
    ["scripts/generate-pack-inventory.js", null],
    ["scripts/generate-test-baseline.js", null],
    ["scripts/test-changed.js", null],
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /require\(["']\.\.\/src\/security\/child-process["']\)/, `${file} must use the shared child environment policy`);
    assert.match(source, /env:\s*childProcessEnv\(/, `${file} must pass a filtered environment to the child`);
    if (expectedOverride) assert.match(source, new RegExp(expectedOverride), `${file} must preserve its required explicit setting`);
    assert.doesNotMatch(source, /env:\s*\{\s*\.\.\.process\.env/, `${file} must not forward the ambient environment directly`);
  }
});
