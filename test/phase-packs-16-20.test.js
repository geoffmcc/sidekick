"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PACKS = [
  ["change-impact", "change-impact-tools", "change_impact", ["dev_change_summary", "semantic_repo"]],
  ["skeptical-verifier", "skeptical-verifier-tools", "skeptical_verify", ["dev_repo_profile", "semantic_repo", "health"]],
  ["reproducibility", "reproducibility-tools", "reproducibility", ["dev_repo_profile", "semantic_repo", "research_evidence"]],
  ["assumptions-unknowns", "assumptions-unknowns-tools", "assumptions", ["context", "memory", "handoff"]],
  ["operational-readiness", "operational-readiness-tools", "operational_readiness", ["research_evidence", "health", "dev_repo_profile", "handoff"]],
];
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const responseJson = response => JSON.parse(response.content[0].text);

for (const [packName, moduleName, toolName, dispatches] of PACKS) {
  const dir = path.join(ROOT, "packs", packName);
  const pack = read(path.join(dir, "sidekick.pack.json"));
  const module = read(path.join(dir, "modules", moduleName, "manifest.json"));
  assert.strictEqual(pack.pack_api, 1);
  assert.strictEqual(pack.name, packName);
  assert.ok(pack.workflows.length && pack.knowledge.length);
  assert.ok(module.tools[toolName]);
  assert.deepStrictEqual(pack.permissions, module.permissions, `${packName}: permission parity`);
  const source = fs.readFileSync(path.join(dir, "modules", moduleName, "entry.js"), "utf8");
  for (const dependency of dispatches) assert.match(source, new RegExp(`dispatch\\(\\s*["']${dependency}["']`));
}

(async () => {
  const readiness = read(path.join(ROOT, "packs/operational-readiness/sidekick.pack.json"));
  const moduleDir = path.join(ROOT, "packs/operational-readiness", readiness.modules[0].path);
  const entry = require(path.join(moduleDir, readiness.modules[0].entry_point));
  const descriptor = entry.buildDescriptors({ dispatch: async () => { throw new Error("dispatch must be gated"); } })[0];
  const result = responseJson(await descriptor.handler({ project: "test", path: ROOT, evidence: [] }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.code, "evidence_required");
  const evidenceFailure = responseJson(await descriptor.handler({ project: "test", path: ROOT, evidence: ["missing"] }));
  assert.strictEqual(evidenceFailure.ok, false);
  assert.strictEqual(evidenceFailure.ready, false);
  console.log("Packs 16-20 manifest and fail-closed tests passed");
})().catch(error => { console.error(error.stack || error); process.exit(1); });
