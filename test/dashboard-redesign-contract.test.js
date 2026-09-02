"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "dashboard.html"), "utf8");
const client = fs.readFileSync(path.join(root, "static", "dashboard.js"), "utf8");
const controls = fs.readFileSync(path.join(root, "static", "dashboard-controls.js"), "utf8");

assert.ok(!/\son(?:click|change|input|submit)=/i.test(html), "page markup must not contain inline event handlers");
assert.ok(!/\son(?:click|change|input|submit)=/i.test(client), "dynamic dashboard markup must not contain inline event handlers");
assert.ok(!/\sstyle\s*=/i.test(client), "dynamic dashboard markup must not contain inline styles");
assert.match(html, /dashboard-controls\.js/, "delegated dashboard controller must be loaded");
for (const action of ["data-dashboard-action", "data-dashboard-input", "data-dashboard-change"]) {
  assert.ok(html.includes(action), action + " contract must be used by page controls");
}
for (const primitive of ["viewState", "renderRecordList", "renderInspector"]) {
  assert.match(client, new RegExp("function " + primitive + "\\("), primitive + " shared primitive is required");
}
assert.match(controls, /event\.target\.closest\("\[data-dashboard-action\]"\)/);
assert.match(controls, /data-dashboard-change/);
assert.match(client, /esc\(String\(s \|\| ''\)\)/);
assert.match(client, /function attr\(/);
assert.match(client, /function jsArg\(/);
console.log("Dashboard redesign source contracts: passed");
