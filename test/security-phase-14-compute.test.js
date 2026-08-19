"use strict";

// Static contract guard for the production worker renewal seam. The dynamic
// adversarial assertion lives beside the Compute lease state-machine fixture;
// this test prevents the HTTP route from silently dropping worker identity in
// a future refactor.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
assert.match(source, /renewLease\(req\.params\.jobId, req\.computeWorker\.workerId,/,
  "worker renewal route must bind renewal to the authenticated worker identity");

console.log("Passed: Compute worker renewal route preserves authenticated worker ownership");
