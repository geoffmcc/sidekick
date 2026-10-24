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
  const anonymousRead = await browserTool.sidekick_browser({ action: "status" });
  assert.strictEqual(anonymousRead.code, "unauthenticated");
  const anonymousOpen = await browserTool.sidekick_browser({ action: "open", url: "https://example.invalid" });
  assert.strictEqual(anonymousOpen.code, "unauthenticated");

  const { createOwnerContext } = require("./helpers/authorized-context");
  const { runWithContext } = require("../src/tools/context");
  const authenticated = createOwnerContext({ source: "mcp" });
  const directRead = await runWithContext(authenticated, () => browserTool.sidekick_browser({ action: "status" }));
  assert.strictEqual(directRead.code, "canonical_dispatch_required");
});
