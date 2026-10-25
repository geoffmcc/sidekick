"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-pack-maturity-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "pack-maturity-test-secret-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const bundled = require("../src/packs/bundled");
const lifecycle = require("../src/packs/lifecycle");
const taskModel = require("../src/agent/task-model");
const taskStore = require("../src/agent/task-store");
const receiptStore = require("../src/agent/receipt-store");
const maturity = require("../src/packs/maturity");

const candidate = bundled.getBundledPack("api-engineering");
assert.ok(candidate, "the fixture pack must be bundled");
const installed = bundled.installBundledPack("api-engineering");
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "foundation");

const operational = lifecycle.enable(installed.pack.name);
assert.strictEqual(operational.health.ok, true);
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "operational");

const observedAt = new Date().toISOString();
const legacyId = "legacy-caller-labeled-verification";
db.getDb().prepare(`INSERT INTO platform_pack_verification_evidence
  (verification_id, pack_name, pack_version, package_hash, config_fingerprint, lifecycle_epoch,
   health_fingerprint, recipe_version, evidence_json, result_digest, actor_ref, project_ref,
   scope_revision, provider_json, status, observed_at, expires_at, legacy, created_at)
  VALUES (?, ?, ?, ?, ?, 0, ?, 'pack-proving-v1', ?, 'legacy-digest', 'test-principal',
   'pack-maturity', NULL, '{}', 'verified', ?, ?, 0, ?)`)
  .run(legacyId, installed.pack.name, installed.pack.version, installed.pack.package_hash,
    maturity.configFingerprint(installed.pack), maturity.healthFingerprint(installed.pack),
    JSON.stringify({ refs: [], checks: { canonical_dispatch: true, agent_discovery: true, workflow: true, single_pack: true, cross_pack: true, skeptical_verification: true } }),
    observedAt, new Date(Date.now() + 86400000).toISOString(), observedAt);
const legacyProjection = lifecycle.maturity(installed.pack.name);
assert.equal(legacyProjection.level, "operational", "a historical caller-labeled row cannot continue to certify a pack");
assert.equal(legacyProjection.evidence_freshness, "malformed");
assert.ok(db.getDb().prepare("SELECT 1 FROM platform_pack_verification_evidence WHERE verification_id = ?").get(legacyId), "the historical row remains available for inspection");

const task = taskStore.insertTask(taskModel.createTask({ objective: "pack verification fixture", project_id: "pack-maturity", actor_id: "test", actor_principal_id: "test-principal" }));
const receipt = receiptStore.createReceipt({ task_id: task.task_id, action_fingerprint: "pack-maturity-fingerprint", capability: "api_contract_check", capability_version: "1", args: { url: "https://example.test" }, project_ref: "pack-maturity", principal_ref: "test-principal", effect_class: "read_only", risk_class: "low" });
receiptStore.transitionReceipt(receipt.receipt_id, "dispatched");
receiptStore.transitionReceipt(receipt.receipt_id, "finalized");
assert.throws(() => lifecycle.recordVerification(installed.pack.name, {
  actor_ref: "test-principal",
  project_ref: "pack-maturity",
  recipe_version: "pack-proving-v1",
  evidence_refs: [
    { type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" },
    { type: "receipt", id: receipt.receipt_id, role: "agent_discovery" },
    { type: "receipt", id: receipt.receipt_id, role: "workflow" },
    { type: "receipt", id: receipt.receipt_id, role: "single_pack" },
    { type: "receipt", id: receipt.receipt_id, role: "cross_pack" },
    { type: "receipt", id: receipt.receipt_id, role: "skeptical_verification" },
  ],
}), /server-verifiable evidence source|cannot support multiple verification roles/);
assert.throws(() => lifecycle.recordVerification(installed.pack.name, {
  actor_ref: "test-principal",
  project_ref: "pack-maturity",
  evidence_refs: [{ type: "receipt", id: receipt.receipt_id, role: "canonical_dispatch" }],
}), error => error.message.includes("required evidence role missing: agent_discovery")
  && !error.message.includes("required evidence role missing: canonical_dispatch"),
"a same-actor, same-project receipt for a pack-owned tool substantiates only canonical dispatch");
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "operational", "caller-selected roles cannot elevate a pack to certified");

const evaluatedAt = Date.parse("2026-01-15T00:00:00Z");
const record = { state: "enabled", version: "1.0.0", package_hash: "hash", config: {}, metadata: { maturity_lifecycle_epoch: 0 }, health: { ok: true, status: "healthy" } };
const fingerprints = { config: maturity.configFingerprint(record), health: maturity.healthFingerprint(record) };
function checkTimestamp(observed_at, expires_at) {
  const entry = { observed_at, pack_version: record.version, package_hash: record.package_hash, config_fingerprint: fingerprints.config, lifecycle_epoch: 0, health_fingerprint: fingerprints.health, evidence_contract_version: 2, checks: {} };
  if (expires_at !== undefined) entry.expires_at = expires_at;
  return maturity.evaluate({ ...record, verified_evidence: [entry] }, { now: evaluatedAt });
}
assert.equal(checkTimestamp("2026-01-14T00:00:00Z", "not-a-timestamp").evidence_freshness, "malformed");
assert.equal(checkTimestamp("2026-01-14T00:00:00Z", "2026-01-15T00:00:00Z").evidence_freshness, "fresh");
assert.equal(checkTimestamp("2026-01-14T00:00:00Z", "2026-01-14T00:00:00Z").evidence_freshness, "expired");
assert.equal(checkTimestamp("2026-01-15T00:00:01Z").evidence_freshness, "stale");
assert.equal(checkTimestamp("not-a-timestamp").evidence_freshness, "malformed");
assert.equal(maturity.classifyEvidence({ observed_at: "2026-01-14T00:00:00Z", pack_version: record.version, package_hash: record.package_hash, config_fingerprint: "dirty", lifecycle_epoch: 0, health_fingerprint: fingerprints.health, evidence_contract_version: 2, checks: {} }, record, evaluatedAt), "dirty");
assert.equal(maturity.classifyEvidence({ observed_at: "2026-01-14T00:00:00Z", pack_version: record.version, package_hash: record.package_hash, config_fingerprint: fingerprints.config, lifecycle_epoch: 0, health_fingerprint: fingerprints.health, evidence_contract_version: 2, checks: {}, expires_at: "2026-01-14T00:00:00Z" }, record, evaluatedAt), "expired");
assert.equal(maturity.classifyEvidence({ observed_at: "2026-01-14T00:00:00Z", pack_version: record.version, package_hash: record.package_hash, config_fingerprint: fingerprints.config, lifecycle_epoch: 0, health_fingerprint: fingerprints.health, checks: {} }, record, evaluatedAt), "malformed", "pre-contract caller-labeled evidence cannot remain current");
assert.equal(maturity.classifyEvidence({ observed_at: "not-a-timestamp" }, record, evaluatedAt), "malformed");
assert.equal(maturity.evaluate({ ...record, health: { ok: false, status: "healthy" } }, { now: evaluatedAt }).level, "foundation");

assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "operational");

lifecycle.configure(installed.pack.name, { max_assertions: 10 });
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "operational", "configuration changes invalidate verification without disabling the pack");
assert.strictEqual(lifecycle.maturity(installed.pack.name).evidence_freshness, "malformed", "the retained pre-contract row remains historical and unusable after configuration changes");

assert.throws(() => lifecycle.recordVerification(installed.pack.name, { checks: { certified: true }, source: "caller" }), /evidence_refs/);

console.log("Pack maturity tests passed");
