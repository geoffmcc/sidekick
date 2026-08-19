"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const workflow = fs.readFileSync(path.resolve(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");

assert.match(workflow, /^permissions:\s*\{\}/m);
assert.match(workflow, /jobs:\s*\n\s+test:\s*\n\s+permissions:\s*\n\s+contents:\s+read/m);
assert.match(workflow, /persist-credentials:\s*false/);
assert.doesNotMatch(workflow, /pull_request_target|secrets\./);

console.log("Passed: CI uses explicit least privilege and fork-safe checkout");
