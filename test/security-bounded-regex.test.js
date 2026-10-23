"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BoundedRegex, MAX_PATTERN_LENGTH } = require("../src/core/bounded-regex");

test("bounded regex preserves ordinary matching behavior", () => {
  const matcher = new BoundedRegex("^hello\\s+world$", "i");
  assert.equal(matcher.test("Hello world"), true);
  assert.equal(matcher.test("goodbye"), false);
});

test("bounded replacement retains global replacement semantics", () => {
  const matcher = new BoundedRegex("token");
  assert.equal(matcher.replace("token and token", "[redacted]"), "[redacted] and [redacted]");
});

test("bounded regex rejects invalid, stateful, and oversized patterns", () => {
  assert.throws(() => new BoundedRegex("["), /Invalid regular expression/);
  assert.throws(() => new BoundedRegex("a", "g"), /stateful flags/);
  assert.throws(() => new BoundedRegex("a".repeat(MAX_PATTERN_LENGTH + 1)), /no longer than/);
});

test("catastrophic backtracking is interrupted within the configured match deadline", () => {
  const matcher = new BoundedRegex("(a+)+$", "", { budgetMs: 1000, matchTimeoutMs: 20 });
  const started = Date.now();
  assert.throws(() => matcher.test("a".repeat(100_000) + "!"), /exceeded its time budget/);
  assert.ok(Date.now() - started < 1000, "regex evaluation should not monopolize the event loop");
});

test("catastrophic replacement is interrupted within the configured deadline", () => {
  const matcher = new BoundedRegex("(a+)+$", "", { budgetMs: 1000, matchTimeoutMs: 20 });
  assert.throws(() => matcher.replace("a".repeat(100_000) + "!", "[redacted]"), /exceeded its time budget/);
});

test("repeated regex matches share one total evaluation budget", () => {
  const matcher = new BoundedRegex("a", "", { budgetMs: 50, matchTimeoutMs: 20 });
  for (let index = 0; index < 1000; index++) {
    try { matcher.test("a"); } catch (error) {
      assert.match(error.message, /exceeded its time budget/);
      return;
    }
  }
  assert.fail("repeated regex matches did not exhaust the shared budget");
});
