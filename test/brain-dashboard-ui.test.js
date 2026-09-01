"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "..", "static", "dashboard.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "static", "dashboard.css"), "utf8");

assert.match(html, /id="nav-brain"/);
assert.match(html, /id="page-brain"/);
for (const id of ["brainGraphCoverage", "brainVerificationGates", "brainRoleRouting", "brainLearningCandidates"]) assert.match(html, new RegExp(`id="${id}"`));
assert.match(js, /\/api\/agent\/tasks\/' \+ encodeURIComponent\(taskId\) \+ '\/control-room/);
assert.match(js, /\/api\/agent\/learning-candidates\?project=/);
assert.match(js, /No role-routing decisions recorded/);
assert.match(js, /candidate\.state \|\| 'proposal'/);
assert.match(css, /\.brain-projection/);
assert.match(css, /\.brain-row/);
console.log("Brain Dashboard UI projections: passed");
