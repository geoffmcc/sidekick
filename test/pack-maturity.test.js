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

const candidate = bundled.getBundledPack("api-engineering");
assert.ok(candidate, "the fixture pack must be bundled");
const installed = bundled.installBundledPack("api-engineering");
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "foundation");

const operational = lifecycle.enable(installed.pack.name);
assert.strictEqual(operational.health.ok, true);
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "operational");

const checks = {
  canonical_dispatch: true,
  agent_discovery: true,
  workflow: true,
  single_pack: true,
  cross_pack: true,
  skeptical_verification: true,
};
const verified = lifecycle.recordVerification(installed.pack.name, { source: "deterministic_fixture", checks });
assert.strictEqual(verified.maturity.level, "certified");
assert.strictEqual(verified.maturity.evidence_freshness, "fresh");
assert.strictEqual(verified.maturity.evidence[0].current, true);

const stale = lifecycle.recordVerification(installed.pack.name, { source: "old-fixture", observed_at: "2020-01-01T00:00:00Z", checks });
assert.strictEqual(stale.maturity.level, "certified", "a stale historical entry must not erase the current fresh entry");
assert.ok(stale.maturity.evidence.some(entry => entry.source === "old-fixture" && entry.current === false));

lifecycle.disable(installed.pack.name);
lifecycle.enable(installed.pack.name);
assert.strictEqual(lifecycle.maturity(installed.pack.name).evidence_freshness, "stale", "lifecycle transitions invalidate prior verification");

lifecycle.configure(installed.pack.name, { max_assertions: 10 });
assert.strictEqual(lifecycle.maturity(installed.pack.name).level, "operational", "configuration changes invalidate verification without disabling the pack");
assert.strictEqual(lifecycle.maturity(installed.pack.name).evidence_freshness, "stale");

assert.throws(() => lifecycle.recordVerification(installed.pack.name, { checks }), /attributed source/);

console.log("Pack maturity tests passed");
