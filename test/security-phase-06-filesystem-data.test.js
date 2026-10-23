"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { validateArchiveEntryNames, validateArchiveSourceType } = require("../src/tools/families/process-mgmt");

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

const regularFile = { isFile: () => true, isDirectory: () => false };
const directory = { isFile: () => false, isDirectory: () => true };
const specialFile = { isFile: () => false, isDirectory: () => false };
assert.strictEqual(validateArchiveSourceType(regularFile, "list"), null);
assert.strictEqual(validateArchiveSourceType(regularFile, "extract"), null);
assert.strictEqual(validateArchiveSourceType(directory, "create"), null);
assert.strictEqual(validateArchiveSourceType(regularFile, "create"), null);
assert.match(validateArchiveSourceType(directory, "list"), /regular file/);
assert.match(validateArchiveSourceType(specialFile, "create"), /regular file or directory/);
assert.match(validateArchiveSourceType(specialFile, "extract"), /regular file/);
assert.match(validateArchiveSourceType(null, "extract"), /could not be verified/);

const source = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "families", "process-mgmt.js"), "utf8");
assert.match(source, /validateArchiveEntryNames\(listing\.split\("\\n"\)\)/, "archive extraction must validate the complete listing first");
assert.match(source, /sourceStat = fs\.statSync\(sourcePath\)/, "archive source type must be verified before invoking archive commands");
assert.match(source, /validateArchiveSourceType\(sourceStat, action\)/, "archive operations must reject special source files");
assert.match(source, /const extractTarget = output \? path\.resolve\(output\) : process\.cwd\(\)/, "archive extraction target must be explicit and canonicalized");
assert.match(source, /"-C", extractTarget/, "tar extraction must use the governed extraction target");
assert.match(source, /"-d", extractTarget/, "zip extraction must use the governed extraction target");
console.log("Phase 6 filesystem and archive security tests passed");
