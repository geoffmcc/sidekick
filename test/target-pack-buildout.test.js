"use strict";
const assert = require("assert");
const path = require("path");
const root = path.join(__dirname, "..");

function response(value) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }
function body(value) { return JSON.parse(value.content[0].text); }
const calls = [];
const services = {
  config: { max_assertions: 20, default_database: "sqlite", max_rows: 10, verification_mode: "standard" },
  dispatch: async (name, args) => {
    calls.push({ name, args });
    if (name === "web_check") return response({ ok: true, assertions: args.assertions });
    if (["context", "memory", "handoff"].includes(name)) return response({ source: name, items: [] });
    if (name === "db_diff") return response({ equal: true, changes: [] });
    if (name === "db_migrate") return response({ pending: 0 });
    if (name === "db_schema") return response({ tables: [] });
    if (name === "db_stats") return response({ size: 1 });
    if (name === "dev_repo_profile") return response({ ci: {}, verification: {} });
    if (name === "dev_change_summary") return response({ findings: [], kinds: [] });
    if (name === "semantic_repo") return response({ symbols: [], relationships: [] });
    if (name === "dev_verify") return response({ ok: true, verdict: "passed", selected: [] });
    if (name === "process") return response({ ok: true, processes: [{ pid: 1 }] });
    if (name === "compute_route") return response({ ok: true, selected_provider: "fixture-provider" });
    if (name === "tools") return response({ ok: true, tools: [{ name: "fixture_tool" }] });
    if (["network", "dhcp", "vpn", "nginx", "black_box"].includes(name)) return response({ ok: true, fixture: true });
    throw new Error(`unexpected dependency ${name}`);
  },
};
function descriptor(pack, moduleName, name) {
  const module = require(path.join(root, "packs", pack, "modules", moduleName, "entry.js"));
  return (module.entry || module).buildDescriptors(services).find(item => item.name === name);
}

(async () => {
  const matrix = descriptor("api-engineering", "api-engineering-tools", "api_contract_matrix");
  assert.strictEqual(body(await matrix.handler({ network_scope: "fixture", targets: [{ url: "https://fixture.test/a", assertions: [{ kind: "url_contains", value: "fixture.test" }] }] })).ok, true);
  const snapshot = descriptor("assumptions-unknowns", "assumptions-unknowns-tools", "assumptions_snapshot");
  assert.strictEqual(body(await snapshot.handler({ project: "fixture_project", assumptions: ["service is healthy"] })).supplied_items[0].status, "requires_validation");
  const preflight = descriptor("backup-restore-dr", "backup-restore-tools", "backup_restore_preflight");
  assert.strictEqual(body(await preflight.handler({ snapshot_a: "backup-a.db", snapshot_b: "backup-b.db" })).restore.attempted, false);
  const gate = descriptor("change-impact", "change-impact-tools", "change_impact_gate");
  assert.strictEqual(body(await gate.handler({ path: root, max_findings: 10 })).gate.passed, true);
  const release = descriptor("ci-cd-release-engineering", "ci-cd-release-tools", "release_gate");
  assert.strictEqual(body(await release.handler({ path: root, execute: false })).execution.performed, false);
  const review = descriptor("database-administration", "database-administration-tools", "database_migration_review");
  assert.strictEqual(body(await review.handler({ database: "sqlite" })).readiness, "evidence_collected");
  assert.ok(calls.some(call => call.name === "db_diff"));
  assert.ok(calls.some(call => call.name === "dev_verify"));
  const processAudit = descriptor("linux-systems-administration", "linux-systems-tools", "linux_process_inspection");
  assert.strictEqual(body(await processAudit.handler({ action: "list" })).ok, true);
  const route = descriptor("local-ai-model-operations", "local-ai-model-tools", "model_route_explain");
  assert.strictEqual(body(await route.handler({ workload_class: "chat" })).ok, true);
  const catalog = descriptor("mcp-development-compatibility", "mcp-development-tools", "mcp_catalog_operation");
  assert.strictEqual(body(await catalog.handler({ action: "overview" })).ok, true);
  const inventory = descriptor("network-services", "network-services-tools", "network_service_inventory");
  assert.strictEqual(body(await inventory.handler({ area: "leases" })).ok, true);
  const incident = descriptor("observability-incident-response", "observability-incident-tools", "observability_incident_operation");
  assert.strictEqual(body(await incident.handler({ action: "list_incidents" })).ok, true);
  console.log("Target pack build-out fixture tests passed.");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
