"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { validateArchiveEntryNames } = require("../src/tools/families/process-mgmt");

for (const entry of [
  "../outside.txt",
  "nested/../../outside.txt",
  "/etc/passwd",
  "C:/Windows/System32/config/SAM",
  "nested\\..\\outside.txt"
]) {
  assert.throws(() => validateArchiveEntryNames([entry]), /archive contains/, `archive traversal accepted: ${entry}`);
}

assert.strictEqual(validateArchiveEntryNames(["./safe.txt", "nested/file.txt", "nested/"]), true);

const source = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "families", "process-mgmt.js"), "utf8");
assert.match(source, /validateArchiveEntryNames\(listing\.split\("\\n"\)\)/, "archive extraction must validate the complete listing first");
assert.match(source, /const extractTarget = output \? path\.resolve\(output\) : process\.cwd\(\)/, "archive extraction target must be explicit and canonicalized");
assert.match(source, /"-C", extractTarget/, "tar extraction must use the governed extraction target");
assert.match(source, /"-d", extractTarget/, "zip extraction must use the governed extraction target");
console.log("Phase 6 filesystem and archive security tests passed");
