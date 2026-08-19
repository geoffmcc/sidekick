"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const securityTest = fs.readFileSync(path.resolve(__dirname, "security.test.js"), "utf8");
const { parseGitExtraArgs } = require(path.resolve(__dirname, "..", "src", "tools", "families", "development.js"));
assert.match(securityTest, /closeDatabase\?\.\(\)/, "security test must close SQLite before Windows cleanup");
assert.match(securityTest, /fs\.rmSync\(TEST_DATA_DIR, \{ recursive: true, force: true \}\)/);
const formatArg = "--pretty=format:%H\u001f%s\u001f%an\u001f%aI";
assert.deepStrictEqual(parseGitExtraArgs(formatArg), [formatArg], "git format separators must remain inside one argument");

console.log("Passed: final security suite closes SQLite before temporary-directory cleanup");
