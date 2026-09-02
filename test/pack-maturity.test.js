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

const candidate = bundled.getBundledPack("api-engineering");
assert.ok(candidate, "the fixture pack must be bundled");
const installed = bundled.installBundledPack("api-engineering");
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "foundation");

const operational = lifecycle.enable(installed.pack.name);
assert.strictEqual(operational.health.ok, true);
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "operational");

const task = taskStore.insertTask(taskModel.createTask({ objective: "pack verification fixture", project_id: "pack-maturity", actor_id: "test", actor_principal_id: "test-principal" }));
const receipt = receiptStore.createReceipt({ task_id: task.task_id, action_fingerprint: "pack-maturity-fingerprint", capability: "api_contract_check", capability_version: "1", args: { url: "https://example.test" }, project_ref: "pack-maturity", effect_class: "read_only", risk_class: "low" });
receiptStore.transitionReceipt(receipt.receipt_id, "dispatched");
receiptStore.transitionReceipt(receipt.receipt_id, "finalized");
const evidence_refs = ["canonical_dispatch", "agent_discovery", "workflow", "single_pack", "cross_pack", "skeptical_verification"].map(role => ({ type: "receipt", id: receipt.receipt_id, role }));
const verified = lifecycle.recordVerification(installed.pack.name, { actor_ref: "test-principal", project_ref: "pack-maturity", recipe_version: "pack-proving-v1", evidence_refs });
assert.strictEqual(verified.maturity.level, "certified");
assert.strictEqual(verified.maturity.evidence_freshness, "fresh");
assert.strictEqual(verified.maturity.evidence[0].current, true);

const stale = lifecycle.recordVerification(installed.pack.name, { actor_ref: "test-principal", project_ref: "pack-maturity", recipe_version: "pack-proving-v1", observed_at: "2020-01-01T00:00:00Z", expires_at: "2020-02-01T00:00:00Z", evidence_refs });
assert.strictEqual(stale.maturity.level, "certified", "a stale historical entry must not erase the current fresh entry");
assert.ok(stale.maturity.evidence.some(entry => entry.observed_at.startsWith("2020-") && entry.current === false));

lifecycle.disable(installed.pack.name);
lifecycle.enable(installed.pack.name);
assert.strictEqual(lifecycle.maturity(installed.pack.name).evidence_freshness, "stale", "lifecycle transitions invalidate prior verification");

lifecycle.configure(installed.pack.name, { max_assertions: 10 });
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "operational", "configuration changes invalidate verification without disabling the pack");
assert.strictEqual(lifecycle.maturity(installed.pack.name).evidence_freshness, "stale");

assert.throws(() => lifecycle.recordVerification(installed.pack.name, { checks: { certified: true }, source: "caller" }), /evidence_refs/);

console.log("Pack maturity tests passed");
