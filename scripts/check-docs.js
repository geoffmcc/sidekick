#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = path.resolve(__dirname, "..");
const required = [
  ["docs/architecture-boundaries.md", "npm run check:architecture"],
  ["docs/metrics.md", "/api/dashboard-performance"],
  ["docs/dashboard.md", "src/dashboard/database-routes.js"],
  ["docs/tool-architecture.md", "src/tools/dispatcher.js"],
];
const missing = required.filter(([file, text]) => !fs.readFileSync(path.join(root, file), "utf8").includes(text));
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const inventoryPath = path.join(root, "docs", "compatibility-pack-inventory.json");
let inventory;
try { inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8")); } catch (error) { missing.push(["docs/compatibility-pack-inventory.json", "valid JSON"]); }
if (inventory) {
  const hash = crypto.createHash("sha256");
  for (const file of walk(path.join(root, "packs")).filter(file => fs.statSync(file).isFile()).sort()) hash.update(path.relative(root, file).split(path.sep).join("/")).update("\0").update(fs.readFileSync(file)).update("\0");
  const fingerprint = `sha256:${hash.digest("hex")}`;
  if (inventory.source_fingerprint !== fingerprint) missing.push(["docs/compatibility-pack-inventory.json", "current bundled pack source fingerprint"]);
  if (!inventory.source_commit || !inventory.source_commit_date) missing.push(["docs/compatibility-pack-inventory.json", "verified source commit and date"]);
}
if (missing.length) { console.error(JSON.stringify({ missing }, null, 2)); process.exitCode = 1; } else console.log("Documentation drift checks passed");
