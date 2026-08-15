"use strict";

// Compute migration/runtime schema parity — the compute_% analogue of
// test/kernel-migration-parity.test.js.
//
// Two fresh databases are bootstrapped through the two independent paths that
// both claim to produce the compute schema:
//   A. SQL migrations only (migrations/013_compute.sql and successors).
//   B. The runtime ensureSchema paths only (job-manager, provider-registry,
//      model-registry, worker-manager, compute/index initialize()).
//
// Runtime-bootstrapped databases were missing the indexes migrations create
// (idx_compute_jobs_provider/created, idx_compute_attempts_worker,
// idx_compute_artifacts_type, idx_compute_routing_enabled,
// idx_compute_benchmarks_*, idx_compute_metrics_provider, plus the
// 016/017/022/023 additions) — this test pins table names, column sets, index
// names, and index DDL to the same shape on both paths. Exact table DDL is
// deliberately NOT compared: the runtime path adds late columns via ALTER
// TABLE while newer migrations bake them into CREATE TABLE, so column ORDER
// legitimately differs; the column SET must not.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-compute-migration-parity");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const MIGRATION_DB = path.join(TEST_DATA_DIR, "migrations.sqlite");
const RUNTIME_DB = path.join(TEST_DATA_DIR, "runtime.sqlite");

process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
// The registry contents are irrelevant to schema shape; keep boot B inert.
process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").replace(/\s*([,()])\s*/g, "$1").trim();
}

function captureComputeSchema(db) {
  const objects = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name LIKE 'compute_%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map(r => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: r.sql ? normalizeSql(r.sql) : null }));
  const columns = {};
  for (const table of objects.filter(o => o.type === "table")) {
    columns[table.name] = db.prepare(`PRAGMA table_info(${table.name})`).all().map(c => c.name).sort();
  }
  return { objects, columns };
}

console.log("Running Compute Migration Parity Tests...\n");

(async () => {
  try {
    // --- Boot path A: fresh database bootstrapped purely through migrations. ---
    process.env.SIDEKICK_DATA_DIR = path.join(TEST_DATA_DIR, "data-a");
    process.env.SIDEKICK_DB_FILE = MIGRATION_DB;
    delete require.cache[require.resolve("../src/db")];

    const migrationStore = require("../src/db");
    const migrationResult = migrationStore.runPendingMigrations();
    assert.ok(
      migrationResult.migrations.some(m => m.file === "013_compute.sql"),
      "Migration 013 (compute) should be applied"
    );
    const migrated = captureComputeSchema(migrationStore.getDb());

    console.log(`Test CMP.1: migrations-only boot applies ${migrationResult.applied} migrations`);
    assert.ok(migrated.objects.filter(o => o.type === "table").length >= 10, "compute tables present after migrations");
    console.log("Passed\n");

    // --- Boot path B: fresh database bootstrapped purely through the runtime. ---
    process.env.SIDEKICK_DATA_DIR = path.join(TEST_DATA_DIR, "data-b");
    process.env.SIDEKICK_DB_FILE = RUNTIME_DB;
    delete require.cache[require.resolve("../src/db")];

    // Compute modules were not loaded during boot A, so they bind to the
    // fresh db module here.
    const runtimeStore = require("../src/db");
    const compute = require("../src/compute");
    compute.initialize();
    compute.stopReconciliation();
    const runtime = captureComputeSchema(runtimeStore.getDb());

    console.log("Test CMP.2: both boot paths produce the same compute_% tables and columns");
    const migratedTables = migrated.objects.filter(o => o.type === "table").map(o => o.name);
    const runtimeTables = runtime.objects.filter(o => o.type === "table").map(o => o.name);
    assert.deepStrictEqual(runtimeTables, migratedTables, "compute table sets must match");
    for (const table of migratedTables) {
      assert.deepStrictEqual(
        runtime.columns[table],
        migrated.columns[table],
        `column set mismatch for ${table}`
      );
    }
    console.log("Passed\n");

    console.log("Test CMP.3: both boot paths produce the identical explicit compute_% indexes");
    const migratedIndexes = migrated.objects.filter(o => o.type === "index" && o.sql);
    const runtimeIndexes = runtime.objects.filter(o => o.type === "index" && o.sql);
    const migratedNames = migratedIndexes.map(o => o.name);
    const runtimeNames = runtimeIndexes.map(o => o.name);
    const missing = migratedNames.filter(n => !runtimeNames.includes(n));
    const extra = runtimeNames.filter(n => !migratedNames.includes(n));
    assert.deepStrictEqual(missing, [], `runtime boot is missing migration-created indexes: ${missing.join(", ")}`);
    assert.deepStrictEqual(extra, [], `runtime boot creates indexes migrations do not: ${extra.join(", ")}`);
    for (const idx of migratedIndexes) {
      const counterpart = runtimeIndexes.find(o => o.name === idx.name);
      assert.strictEqual(counterpart.sql, idx.sql, `index DDL mismatch for ${idx.name}`);
    }
    // The audited regression: these must exist on the runtime path by name.
    for (const name of [
      "idx_compute_jobs_provider", "idx_compute_jobs_created",
      "idx_compute_attempts_worker", "idx_compute_artifacts_type",
      "idx_compute_routing_enabled", "idx_compute_benchmarks_provider",
      "idx_compute_benchmarks_type", "idx_compute_benchmarks_created",
      "idx_compute_metrics_provider",
    ]) {
      assert.ok(runtimeNames.includes(name), `runtime boot must create ${name}`);
    }
    console.log("Passed\n");

    console.log("All Compute Migration Parity tests passed.");
    process.exit(0);
  } catch (error) {
    console.error("Compute Migration Parity test failed:", error);
    process.exit(1);
  }
})();
