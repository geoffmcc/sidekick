"use strict";

// Phase 12 regression: remote download metadata is untrusted output and must
// not become an unbounded or control-character-bearing session record.
const assert = require("assert");
const { test } = require("node:test");
const { safeDownloadFilename } = require("../src/browser/sessions");
const browserTool = require("../src/tools/families/browser");

assert.strictEqual(safeDownloadFilename("report\r\nX-Injected: yes"), "report__X-Injected: yes");
assert.strictEqual(safeDownloadFilename("x".repeat(1000)).length, 200);
assert.strictEqual(safeDownloadFilename(""), "download");
assert.strictEqual(safeDownloadFilename(null), "download");
console.log("Phase 12 browser download metadata security test passed.");

test("browser handlers cannot bypass the canonical dispatcher or execution identity", async () => {
  const read = await browserTool.sidekick_browser({ action: "status" });
  assert.strictEqual(read.code, "canonical_dispatch_required");
  const navigate = await browserTool.sidekick_browser({ action: "open", url: "https://example.invalid" });
  assert.strictEqual(navigate.code, "unauthenticated");
});
