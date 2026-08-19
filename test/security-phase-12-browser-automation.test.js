"use strict";

// Phase 12 regression: remote download metadata is untrusted output and must
// not become an unbounded or control-character-bearing session record.
const assert = require("assert");
const { safeDownloadFilename } = require("../src/browser/sessions");

assert.strictEqual(safeDownloadFilename("report\r\nX-Injected: yes"), "report__X-Injected: yes");
assert.strictEqual(safeDownloadFilename("x".repeat(1000)).length, 200);
assert.strictEqual(safeDownloadFilename(""), "download");
assert.strictEqual(safeDownloadFilename(null), "download");
console.log("Phase 12 browser download metadata security test passed.");
