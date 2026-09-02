"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const inventory = JSON.parse(fs.readFileSync(path.join(root, "docs", "compatibility-pack-inventory.json"), "utf8"));
const discoveredManifests = fs.readdirSync(path.join(root, "packs"), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, "packs", entry.name, "sidekick.pack.json")))
  .map(entry => JSON.parse(fs.readFileSync(path.join(root, "packs", entry.name, "sidekick.pack.json"), "utf8")));
assert.strictEqual(inventory.schema, "sidekick.compatibility-pack-inventory.v1");
assert.strictEqual(inventory.pack_count, discoveredManifests.length);
assert.strictEqual(inventory.packs.length, inventory.pack_count);
assert.deepStrictEqual(inventory.packs.map(pack => pack.name), discoveredManifests.map(pack => pack.name).sort());
for (const pack of inventory.packs) {
  assert.ok(pack.version && pack.purpose && pack.manifest);
  assert.ok(Array.isArray(pack.tools));
  assert.ok(Array.isArray(pack.workflows) && pack.workflows.every(workflow => workflow.present));
  assert.ok(Array.isArray(pack.knowledge) && pack.knowledge.every(asset => asset.present));
  assert.ok(Array.isArray(pack.maturity_gaps));
  assert.ok(pack.health_readiness && typeof pack.health_readiness.behavior === "string");
  assert.ok(Array.isArray(pack.overlaps));
  assert.ok(pack.workflow_contract && Number.isInteger(pack.workflow_contract.total));
  assert.strictEqual(pack.evidence_status, "not_evaluated");
  assert.ok(pack.capability_matrix);
  assert.deepStrictEqual(Object.keys(pack.capability_matrix.lifecycle_coverage), [
    "discovery", "inventory", "analysis", "diagnosis", "planning", "execution", "verification",
    "recovery", "health", "workflows", "composition", "security", "fixtures", "docs", "certification",
  ]);
  assert.ok(Array.isArray(pack.capability_matrix.intended_users));
  assert.ok(Array.isArray(pack.capability_matrix.jobs));
  assert.ok(Array.isArray(pack.capability_matrix.weaknesses));
  assert.ok(Array.isArray(pack.capability_matrix.selected_improvements));
  assert.ok(Array.isArray(pack.capability_matrix.deferred_items));
  assert.ok(pack.capability_matrix.current_implementation_coverage);
  assert.strictEqual(pack.capability_matrix.lifecycle_coverage.certification.status, "not_evaluated");
  assert.strictEqual(pack.capability_matrix.evidence_status, "not_evaluated");
}
console.log("Pack inventory tests passed");
