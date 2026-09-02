"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "dashboard.html"), "utf8");
const js = fs.readFileSync(path.join(root, "static", "dashboard.js"), "utf8");
const css = fs.readFileSync(path.join(root, "static", "dashboard-theme.css"), "utf8");

assert.match(js, /fetchProjects\(\)\.catch\(\(\) => \{\}\)/, "workspace projects load during initialization");
assert.match(js, /selected !== current.*setWorkspace\('global', 'Global workspace'/s, "deleted workspace IDs recover to Global");
assert.match(js, /aria-selected/);
for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]) assert.ok(js.includes("event.key === '" + key + "'"), "workspace/palette handles " + key);
assert.match(js, /window\.dashboardPageReady/);
assert.doesNotMatch(js, /fetchToolCategories\(\)\.then\(\(\) => \{[\s\S]{0,500}else \{/);
assert.match(html, /id="mobileNavClose"/);
assert.match(html, /id="mobileNavBackdrop"/);
assert.match(js, /renderServiceStatus\(null\)/);
assert.match(js, /renderServiceStatus\(null\)/);
assert.match(js, /service-status-item.*esc\(label\).*esc\(value\)/s);
assert.match(css, /\.mobile-nav-backdrop/);
assert.match(css, /\.service-status-list/);
console.log("Dashboard workspace/accessibility tests: passed");
