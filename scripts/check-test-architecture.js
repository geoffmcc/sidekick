#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const testRoot = path.join(root, "test");
const errors = [];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "spike-openvino-python" && entry.name !== "node_modules" && !entry.name.startsWith("test-data-")) walk(full);
    else if (entry.isFile() && /\.test\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(full);
  }
}
walk(testRoot);
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file).replaceAll(path.sep, "/");
  const modernDomain = /^(?:test\/(?:core|security|agent|brain|approvals|packs|workflows|dashboard|compute|persistence|memory|handoffs|browser|integration|e2e)\/)/.test(rel);
  if (modernDomain && /(?:from|require\s*\()\s*["'](?:jest|mocha|vitest|tap|ava|testcafe|@playwright\/test)/.test(text)) errors.push(`${rel}: unapproved third-party test framework`);
  if (modernDomain && !/node:test/.test(text) && !/run-all\.test/.test(rel)) {
    // Existing standalone suites are compatibility inputs; new suites must use node:test.
    errors.push(`${rel}: domain suites must import node:test`);
  }
  if (modernDomain && /listen\s*\(\s*\d{2,5}\b/.test(text) && !/exclusive-port/.test(text)) errors.push(`${rel}: hard-coded test port`);
  if (modernDomain && /rmSync\([^\n]*recursive:\s*true/.test(text) && !/helpers\//.test(rel)) errors.push(`${rel}: unsafe recursive cleanup`);
  if (modernDomain && /https?:\/\/(?!127\.0\.0\.1|localhost|example\.invalid)/.test(text) && !/live/.test(rel)) errors.push(`${rel}: uncontrolled network URL`);
}
if (files.length === 0) errors.push("no test suites discovered");
if (errors.length) { console.error(JSON.stringify({ errors }, null, 2)); process.exitCode = 1; }
else console.log(`Test architecture OK (${files.length} suites checked)`);
