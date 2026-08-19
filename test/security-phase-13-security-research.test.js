"use strict";

// Phase 13 regression coverage: report-material custody paths must remain
// unique under concurrent requests. This is intentionally a pure unit test;
// the full pack integration suite remains CI-owned.
const assert = require("assert");
const path = require("path");

const report = require(path.resolve(__dirname, "..", "packs", "security-research", "modules", "security-research-tools", "lib", "report.js"));

const first = report.materialFilename(1700000000000);
const second = report.materialFilename(1700000000000);

assert.notStrictEqual(first, second, "same-millisecond report materialization must not reuse a custody path");
assert.match(first, /^report-material-1700000000000-[0-9a-f]{16}\.json$/);
assert.match(second, /^report-material-1700000000000-[0-9a-f]{16}\.json$/);

console.log("Passed: report material filenames remain unique under same-millisecond concurrency");
