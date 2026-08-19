"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const context = require(path.resolve(__dirname, "..", "src", "tools", "context.js"));
const scope = require(path.resolve(__dirname, "..", "src", "tools", "families", "memory-scope.js"));
const memoryCore = fs.readFileSync(path.resolve(__dirname, "..", "src", "tools", "families", "memory-core.js"), "utf8");
const lifecycle = fs.readFileSync(path.resolve(__dirname, "..", "src", "tools", "families", "memory-lifecycle.js"), "utf8");
const db = fs.readFileSync(path.resolve(__dirname, "..", "src", "db.js"), "utf8");

const bound = context.createTestExecutionContext({ project: "alpha" });
context.runWithContext(bound, () => {
  assert.strictEqual(scope.scopedProject("alpha"), "alpha");
  assert.throws(() => scope.scopedProject("beta"), /scope denied/);
  assert.strictEqual(scope.inScope({ project: "alpha" }), true);
  assert.strictEqual(scope.inScope({ project: "beta" }), false);
  assert.strictEqual(scope.inScope({ project: null }), false, "project-bound reads must not see global records");
});

const portability = fs.readFileSync(path.resolve(__dirname, "..", "src", "tools", "families", "memory-portability.js"), "utf8");
const sync = fs.readFileSync(path.resolve(__dirname, "..", "src", "tools", "families", "memory-sync.js"), "utf8");
assert.match(portability, /options\.projectScope\s*=\s*scopedProject\(\)/);
assert.match(sync, /options\.projectScope\s*=\s*scopedProject\(\)/);
assert.match(memoryCore, /assertInScope\(memory\)/);
assert.match(memoryCore, /project:\s*effectiveProject/);
assert.match(lifecycle, /assertInScope\(memory\)/);
assert.match(db, /raw\.project !== options\.projectScope/);
assert.match(db, /getPendingConfirmations\(options = \{\}\)/);
assert.match(db, /processAutoExpirations\(options = \{\}\)/);

console.log("Passed: project-bound memory scope rejects cross-project reads and imports");
