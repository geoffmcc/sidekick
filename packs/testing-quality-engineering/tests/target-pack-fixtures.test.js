"use strict";
const assert = require("assert");
const path = require("path");
const root = path.join(__dirname, "../../..");
function response(value, error = false) { return { content: [{ type: "text", text: JSON.stringify(value) }], ...(error ? { isError: true } : {}) }; }
const calls = [];
const services = { config: { max_manifest_chars: 50000, default_mode: "standard" }, dispatch: async (name, args) => { calls.push({ name, args }); if (name === "status") return response({ disk: { percent_used: 85 } }); if (name === "research_compare") return response({ comparison: { equal: args.baseline === args.candidate } }); if (name === "research_run") return response({ run: { state: args.action === "cancel" ? "cancelled" : "planned" } }); if (name === "parse") return response({ bomFormat: "CycloneDX", components: [] }); if (name === "hash") return response({ algorithm: "sha256", digest: "fixture-digest" }); if (name === "dev_verify") return response({ ok: true, verdict: "passed", commands: [] }); if (name === "dev_repo_profile") return response({ ok: true }); if (name === "semantic_repo") return response({ ok: true }); if (name === "health") return response({ ok: true }); if (name === "snapshot") return response({ ok: true }); if (name === "network_scopes") return response({ ok: true }); if (name === "research_scope") return response({ ok: true }); throw new Error(`unexpected dependency ${name}`); } };
function descriptor(pack, module, name) { const loaded = require(path.join(root, "packs", pack, "modules", module, "entry.js")); return loaded.buildDescriptors(services).find(item => item.name === name); }
(async () => {
  assert.ok(descriptor("reproducibility", "reproducibility-tools", "reproducibility_compare"));
  assert.strictEqual(JSON.parse((await descriptor("security-lab-reproduction", "security-lab-tools", "lab_run_lifecycle").handler({ action: "plan", snapshot_id: "scope-1", network_scope: "fixture" })).content[0].text).ok, true);
  assert.strictEqual(JSON.parse((await descriptor("skeptical-verifier", "skeptical-verifier-tools", "skeptical_compare").handler({ baseline: { a: 1 }, candidate: { a: 1 }, mode: "json" })).content[0].text).ok, true);
  assert.strictEqual(JSON.parse((await descriptor("software-supply-chain", "software-supply-chain-tools", "supply_chain_provenance").handler({ sbom: '{"bomFormat":"CycloneDX"}', lockfile: "fixture-lock", format: "json" })).content[0].text).ok, true);
  assert.strictEqual(JSON.parse((await descriptor("storage-filesystems", "storage-filesystem-tools", "storage_threshold_check").handler({})).content[0].text).state, "warning");
  assert.strictEqual(JSON.parse((await descriptor("testing-quality-engineering", "testing-quality-tools", "quality_result_normalize").handler({ result: response({ ok: true, verdict: "passed" }) })).content[0].text).verdict, "passed");
  assert.ok(calls.some(call => call.name === "research_compare") && calls.some(call => call.name === "hash"));
  console.log("Target pack deterministic fixture tests passed.");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
