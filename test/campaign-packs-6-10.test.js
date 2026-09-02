"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const cases = [
  ["database-administration", "database-administration-tools", "database_admin"],
  ["ci-cd-release-engineering", "ci-cd-release-tools", "release_readiness"],
  ["testing-quality-engineering", "testing-quality-tools", "quality_gate"],
  ["api-engineering", "api-engineering-tools", "api_contract_check"],
  ["infrastructure-as-code", "infrastructure-as-code-tools", "iac_plan"],
];

function response(value) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }
function body(value) { return JSON.parse(value.content[0].text); }

for (const [pack, moduleName, toolName] of cases) {
  const packRoot = path.join(root, "packs", pack);
  const manifest = JSON.parse(fs.readFileSync(path.join(packRoot, "sidekick.pack.json"), "utf8"));
  const moduleManifest = JSON.parse(fs.readFileSync(path.join(packRoot, "modules", moduleName, "manifest.json"), "utf8"));
  assert.strictEqual(manifest.name, pack);
  assert.ok(moduleManifest.tools[toolName]);
  assert.deepStrictEqual(manifest.permissions, moduleManifest.permissions);
  for (const workflow of manifest.workflows) {
    const definition = JSON.parse(fs.readFileSync(path.join(packRoot, workflow.path), "utf8"));
    assert.ok(definition.name.startsWith(`${pack}/`));
    assert.ok(definition.steps.length > 0);
  }
}

const manifestExpectations = {
  "api-engineering": { required: [], optional: ["web_check"], permissions: ["web_check"] },
  "database-administration": { required: ["db_schema", "db_stats", "db_query", "db_migrate"], optional: [], permissions: ["db_schema", "db_stats", "db_query", "db_migrate"] },
  "ci-cd-release-engineering": { required: ["dev_repo_profile", "dev_verify", "changelog"], optional: [], permissions: ["dev_repo_profile", "dev_verify", "changelog"] },
  "infrastructure-as-code": { required: [], optional: ["compose", "parse"], permissions: ["compose", "parse"] },
  "testing-quality-engineering": { required: ["dev_repo_profile", "dev_verify", "semantic_repo"], optional: [], permissions: ["dev_repo_profile", "dev_verify", "semantic_repo"] },
  "container-operations": { required: [], optional: [], permissions: [] },
  "network-firewall": { required: [], optional: [], permissions: [] },
};

for (const [pack, expected] of Object.entries(manifestExpectations)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "packs", pack, "sidekick.pack.json"), "utf8"));
  assert.deepStrictEqual(manifest.requires.tools, expected.required, `${pack} required tools`);
  assert.deepStrictEqual(manifest.requires.optional_tools, expected.optional, `${pack} optional tools`);
  assert.deepStrictEqual(manifest.permissions.map(permission => permission.tool), expected.permissions, `${pack} permissions`);
}

const calls = [];
const services = {
  config: { default_database: "sqlite", max_rows: 10, verification_mode: "standard", default_mode: "standard", max_assertions: 5, allow_apply: false },
  dispatch: async (name, args) => {
    calls.push({ name, args });
    if (name === "web_check") return response({ ok: true });
    if (name === "parse") return response({ parsed: true });
    if (name === "compose") return response({ ok: true, state: "validated" });
    if (["dev_verify", "dev_repo_profile", "semantic_repo"].includes(name)) return response({ ok: true, verdict: "passed" });
    if (name === "changelog") return response("fixture notes");
    if (name === "db_query") return response([{ id: 1 }]);
    if (["db_schema", "db_stats", "db_migrate"].includes(name)) return response({ ok: true });
    throw new Error(`unexpected dependency ${name}`);
  },
};
function tool(pack, moduleName, name) {
  return require(path.join(root, "packs", pack, "modules", moduleName, "entry.js")).entry
    .buildDescriptors(services).find(item => item.name === name);
}

(async () => {
  const database = tool("database-administration", "database-administration-tools", "database_admin");
  assert.strictEqual(body(await database.handler({ action: "query", sql: "SELECT * FROM fixture WHERE id = ?", params: [1] })).ok, true);
  assert.strictEqual(body(await database.handler({ action: "query", sql: "DELETE FROM fixture", params: [], readonly: false })).code, "invalid_input");
  assert.strictEqual(body(await database.handler({ action: "query", sql: "SELECT * FROM fixture", params: [] })).code, "invalid_input");
  assert.strictEqual(body(await database.handler({ action: "query", sql: "UPDATE fixture SET name = ?", params: ["x"] })).code, "invalid_input");
  assert.strictEqual(body(await database.handler({ action: "query", sql: "SELECT * FROM fixture; SELECT * FROM fixture", params: [1] })).code, "invalid_input");

  const api = tool("api-engineering", "api-engineering-tools", "api_contract_check");
  assert.strictEqual(body(await api.handler({ url: "https://fixture.test/health", assertions: [{ kind: "url_contains", value: "health" }] })).code, "network_scope_required");
  assert.strictEqual(body(await api.handler({ url: "https://fixture.test/health", network_scope: "fixture-scope", assertions: [{ kind: "url_contains", value: "health" }] })).ok, true);
  assert.strictEqual(calls.find(call => call.name === "web_check").args.network_scope, "fixture-scope");

  const iac = tool("infrastructure-as-code", "infrastructure-as-code-tools", "iac_plan");
  const plan = body(await iac.handler({ profile: "fixture", manifest: "services:\n  api:\n    image: example/api:1", format: "yaml" }));
  assert.strictEqual(plan.plan_only, true);
  assert.strictEqual(plan.not_performed.includes("apply"), true);

  const quality = tool("testing-quality-engineering", "testing-quality-tools", "quality_gate");
  assert.strictEqual(body(await quality.handler({ path: root, dry_run: true, intents: ["syntax"] })).ok, true);
  const failingServices = { ...services, dispatch: async (name, args) => name === "dev_verify" ? response({ ok: false, verdict: "failed" }) : services.dispatch(name, args) };
  const failingQuality = require(path.join(root, "packs/testing-quality-engineering/modules/testing-quality-tools/entry.js"))
    .entry.buildDescriptors(failingServices).find(item => item.name === "quality_gate");
  assert.strictEqual(body(await failingQuality.handler({ path: root, dry_run: true, intents: ["syntax"] })).ok, false);
  const failureServices = { ...services, dispatch: async () => ({ isError: true, code: "provider_unavailable", content: [{ type: "text", text: "unavailable" }] }) };
  const failureQuality = require(path.join(root, "packs/testing-quality-engineering/modules/testing-quality-tools/entry.js"))
    .entry.buildDescriptors(failureServices).find(item => item.name === "quality_gate");
  const unavailableQuality = body(await failureQuality.handler({ path: root, dry_run: true, intents: ["syntax"] }));
  assert.strictEqual(unavailableQuality.ok, false);
  assert.strictEqual(unavailableQuality.code, "provider_unavailable");
  assert.strictEqual(unavailableQuality.dependency, "dev_verify");
  console.log("Campaign packs 6-10 focused tests passed.");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
