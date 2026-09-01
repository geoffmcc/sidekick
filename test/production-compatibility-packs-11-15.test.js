"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../packs");
const packs = [
  ["documentation-knowledge", "documentation-knowledge-tools", "documentation_audit"],
  ["software-supply-chain", "software-supply-chain-tools", "supply_chain_audit"],
  ["local-ai-model-operations", "local-ai-model-tools", "model_readiness"],
  ["mcp-development-compatibility", "mcp-development-tools", "mcp_compatibility"],
  ["security-lab-reproduction", "security-lab-tools", "lab_preflight"],
];
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const response = value => ({ content: [{ type: "text", text: JSON.stringify(value || {}) }] });
const spy = calls => async (name, args) => { calls.push({ name, args }); return response({ ok: true, name }); };

for (const [pack, module, tool] of packs) {
  const root = path.join(ROOT, pack);
  const manifest = json(path.join(root, "sidekick.pack.json"));
  const moduleRoot = path.join(root, "modules", module);
  const moduleManifest = json(path.join(moduleRoot, "manifest.json"));
  const runtime = require(path.join(moduleRoot, "entry.js"));
  assert.strictEqual(manifest.name, pack);
  assert.strictEqual(manifest.pack_api, 1);
  assert.ok(manifest.workflows.length > 0 && manifest.knowledge.length > 0);
  assert.ok(moduleManifest.tools[tool]);
  assert.deepStrictEqual(manifest.permissions.map(item => item.tool).sort(), moduleManifest.permissions.map(item => item.tool).sort());
  assert.strictEqual(runtime.healthCheck({ config: manifest.configuration.defaults }).ok, true);
}

(async () => {
  const docsCalls = [];
  const docs = require(path.join(ROOT, packs[0][0], "modules", packs[0][1], "entry.js"));
  const docsTool = docs.buildDescriptors({ config: {}, dispatch: spy(docsCalls) })[0];
  assert.strictEqual(docsTool.schema.safeParse({ metadata: "{}", max_chars: 1000 }).success, true);
  await docsTool.handler({ metadata: "{}", metadata_format: "json", topic: "runbook" });
  assert.deepStrictEqual(docsCalls.map(call => call.name), ["semantic_repo", "knowledge", "parse"]);

  const aiCalls = [];
  const ai = require(path.join(ROOT, packs[2][0], "modules", packs[2][1], "entry.js"));
  await ai.buildDescriptors({ config: {}, dispatch: spy(aiCalls) })[0].handler({ capability: "chat", max_models: 2 });
  assert.deepStrictEqual(aiCalls.map(call => call.name), ["compute", "compute_models", "compute_providers", "compute_nodes", "compute_jobs"]);

  const labCalls = [];
  const lab = require(path.join(ROOT, packs[4][0], "modules", packs[4][1], "entry.js"));
  const labTool = lab.buildDescriptors({ config: {}, dispatch: spy(labCalls) })[0];
  const publicTarget = await labTool.handler({ snapshot_id: "scope-1", network_scope: "lab-main", target: "https://example.com", target_kind: "hostname", operation: "observe", isolated: true });
  assert.strictEqual(publicTarget.isError, true);
  assert.match(publicTarget.content[0].text, /public_target_denied/);
  assert.strictEqual(labCalls.length, 0);
  const publicIp = await labTool.handler({ snapshot_id: "scope-1", network_scope: "lab-main", target: "8.8.8.8", target_kind: "private_ip", operation: "observe", isolated: true });
  assert.strictEqual(publicIp.isError, true);
  assert.match(publicIp.content[0].text, /public_target_denied/);
  assert.strictEqual(labCalls.length, 0);
  const unnamedScope = await labTool.handler({ snapshot_id: "scope-1", network_scope: "not a scope", target: "10.20.0.4", target_kind: "private_ip", operation: "observe", isolated: true });
  assert.strictEqual(unnamedScope.isError, true);
  assert.match(unnamedScope.content[0].text, /named_network_scope_required/);
  assert.strictEqual(labCalls.length, 0);
  const nonIsolated = await labTool.handler({ snapshot_id: "scope-1", network_scope: "lab-main", target: "10.20.0.4", target_kind: "private_ip", operation: "observe", isolated: false });
  assert.strictEqual(nonIsolated.isError, true);
  assert.match(nonIsolated.content[0].text, /isolation_required/);

  const failingAi = require(path.join(ROOT, packs[2][0], "modules", packs[2][1], "entry.js"));
  const aiFailure = failingAi.buildDescriptors({ config: {}, dispatch: async (name) => name === "compute_nodes" ? { isError: true, content: [{ type: "text", text: "unavailable" }] } : response({ ok: true }) })[0];
  assert.strictEqual(JSON.parse((await aiFailure.handler({ capability: "chat" })).content[0].text).ok, false);
  console.log("Production compatibility packs 11-15 focused tests passed.");
})().catch(error => { console.error(error.stack || error); process.exit(1); });
