"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const inventory = JSON.parse(fs.readFileSync(path.join(root, "docs", "compatibility-pack-inventory.json"), "utf8"));
assert.strictEqual(inventory.schema, "sidekick.compatibility-pack-inventory.v1");
assert.strictEqual(inventory.pack_count, 27);
assert.strictEqual(inventory.packs.length, inventory.pack_count);
assert.strictEqual(new Set(inventory.packs.map(pack => pack.name)).size, inventory.pack_count);
for (const pack of inventory.packs) {
  assert.ok(pack.version && pack.purpose && pack.manifest);
  assert.ok(Array.isArray(pack.tools));
  assert.ok(Array.isArray(pack.workflows) && pack.workflows.every(workflow => workflow.present));
  assert.ok(Array.isArray(pack.knowledge) && pack.knowledge.every(asset => asset.present));
  assert.ok(Array.isArray(pack.maturity_gaps));
  assert.strictEqual(pack.evidence_status, "not_evaluated");
}
assert.strictEqual(inventory.packs.reduce((count, pack) => count + pack.knowledge.length, 0), 95);
assert.strictEqual(inventory.packs.reduce((count, pack) => count + pack.workflows.length, 0), 80);
console.log("Pack inventory tests passed");
