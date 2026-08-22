const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-kernel-migration-parity');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const MIGRATION_DB = path.join(TEST_DATA_DIR, 'migrations.sqlite');
const RUNTIME_DB = path.join(TEST_DATA_DIR, 'runtime.sqlite');

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').replace(/\s*([,()])\s*/g, '$1').trim();
}

function capturePlatformSchema(db) {
  const rows = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name LIKE 'platform_%' ORDER BY type, name")
    .all();
  return rows.map(r => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: r.sql ? normalizeSql(r.sql) : null }));
}

// compute_% coverage map: table -> { columns:Set, indexes:Set } for every
// compute table present in the given database.
function captureComputeSchema(db) {
  const map = {};
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'compute_%' ORDER BY name").all();
  for (const t of tables) {
    map[t.name] = {
      columns: new Set(db.prepare(`PRAGMA table_info("${t.name}")`).all().map(c => c.name)),
      indexes: new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name = ?").all(t.name).map(i => i.name)),
    };
  }
  return map;
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name));
}

console.log('Running Platform Kernel Migration Parity Tests...\n');

(async () => {
  try {
    // --- Boot path A: fresh database bootstrapped purely through migrations. ---
    process.env.SIDEKICK_DATA_DIR = path.join(TEST_DATA_DIR, 'data-a');
    process.env.SIDEKICK_DB_FILE = MIGRATION_DB;
    delete require.cache[require.resolve('../src/db')];

    const migrationStore = require('../src/db');
    const migrationResult = migrationStore.runPendingMigrations();
    const migrationApplied = migrationResult.applied;
    assert.ok(migrationApplied >= 36, `Migrations through 037 should apply, got ${migrationApplied}`);
    assert.ok(
      migrationResult.migrations.some(m => m.file === '026_platform_kernel_tables.sql'),
      'Migration 026 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '027_platform_project_projection.sql'),
      'Migration 027 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '030_platform_event_delivery.sql'),
      'Migration 030 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '031_platform_connectors.sql'),
      'Migration 031 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '032_platform_scope_guard.sql'),
      'Migration 032 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '033_security_research_records.sql'),
      'Migration 033 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '034_research_evidence_lineage.sql'),
      'Migration 034 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '035_research_disclosure.sql'),
      'Migration 035 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '036_capability_packs.sql'),
      'Migration 036 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '037_runtime_schema_convergence.sql'),
      'Migration 037 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '038_handoff_versions.sql'),
      'Migration 038 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '039_handoff_resume_packets.sql'),
      'Migration 039 should be applied'
    );
    assert.ok(
      migrationResult.migrations.some(m => m.file === '040_handoff_links.sql'),
      'Migration 040 should be applied'
    );
    const migratedSchema = capturePlatformSchema(migrationStore.getDb());
    const migratedCompute = captureComputeSchema(migrationStore.getDb());

    console.log(`Test KMP.1: migrations-only boot applies ${migrationApplied} migrations`);
    assert.strictEqual(
      migrationStore.getDb().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      String(57),
      'schema_version should be 57'
    );
    console.log('Passed\n');

    console.log('Test KMP.1b: migration 037 owns the formerly runtime-only columns');
    for (const [table, columns] of [
      ['predictions', ['identity_key', 'last_seen_at', 'refresh_count', 'lifecycle_reason']],
      ['prediction_feedback', ['scope_key']],
      ['blackbox_captures', ['diagnostics_json', 'retry_of']],
    ]) {
      const present = tableColumns(migrationStore.getDb(), table);
      for (const column of columns) {
        assert.ok(present.has(column), `migrations-only boot must create ${table}.${column}`);
      }
    }
    console.log('Passed\n');

    // --- Boot path B: fresh database bootstrapped purely through the runtime kernel. ---
    process.env.SIDEKICK_DATA_DIR = path.join(TEST_DATA_DIR, 'data-b');
    process.env.SIDEKICK_DB_FILE = RUNTIME_DB;
    delete require.cache[require.resolve('../src/db')];
    delete require.cache[require.resolve('../src/platform/kernel')];
    delete require.cache[require.resolve('../src/platform/kernel-schema')];
    delete require.cache[require.resolve('../src/redact')];
    for (const mod of ['../src/compute/job-manager', '../src/compute/worker-manager', '../src/compute/provider-registry', '../src/compute/model-registry']) {
      try { delete require.cache[require.resolve(mod)]; } catch {}
    }

    const runtimeStore = require('../src/db');
    const kernel = require('../src/platform/kernel');
    kernel.ensurePlatformKernelSchema();
    // The compute runtime bootstrap surface (the same four ensureSchema calls
    // src/compute/index.js initialize() makes; its remaining inline tables —
    // routing_rules/benchmarks/metrics — are covered by migration 013 and not
    // recreated here because initialize() also starts timers).
    require('../src/compute/provider-registry').ensureSchema();
    require('../src/compute/model-registry').ensureSchema();
    require('../src/compute/worker-manager').ensureSchema();
    require('../src/compute/job-manager').ensureSchema();
    const runtimeSchema = capturePlatformSchema(runtimeStore.getDb());
    const runtimeCompute = captureComputeSchema(runtimeStore.getDb());

    // --- Parity assertions. ---
    console.log('Test KMP.2: both boot paths produce the identical platform_* schema');
    assert.strictEqual(
      migratedSchema.length,
      runtimeSchema.length,
      'Platform object counts must match'
    );
    // Capability Packs v1 (migration 036) adds platform_capability_packs,
    // platform_capability_pack_components and platform_workflow_definitions
    // (31 -> 34 tables) with 11 more explicit indexes (66 -> 77), including
    // the identity owner/actor indexes added by migration 048.
    const expectedTables = 34;
    const expectedIndexes = 77;
    const migratedTables = migratedSchema.filter(o => o.type === 'table').length;
    const migratedIndexes = migratedSchema.filter(o => o.type === 'index' && o.sql).length;
    const migratedAutoindexes = migratedSchema.filter(o => o.type === 'index' && !o.sql).length;
    assert.strictEqual(migratedTables, expectedTables, `Expected ${expectedTables} platform tables`);
    assert.strictEqual(migratedIndexes, expectedIndexes, `Expected ${expectedIndexes} platform indexes`);
    assert.strictEqual(migratedAutoindexes, expectedTables - 1, 'Each TEXT PRIMARY KEY creates one autoindex');
    for (let i = 0; i < migratedSchema.length; i++) {
      const a = migratedSchema[i];
      const b = runtimeSchema[i];
      assert.strictEqual(a.type, b.type, `Type mismatch for ${a.name}`);
      assert.strictEqual(a.name, b.name, 'Object names must match in order');
      assert.strictEqual(a.sql, b.sql, `DDL mismatch for ${a.name}`);
    }
    console.log('Passed\n');

    console.log('Test KMP.3: foreign keys and kernel meta exist in both boot paths');
    const migratedExecutions = migratedSchema.find(o => o.name === 'platform_executions' && o.type === 'table');
    const runtimeExecutions = runtimeSchema.find(o => o.name === 'platform_executions' && o.type === 'table');
    assert.match(migratedExecutions.sql, /FOREIGN KEY\(parent_execution_id\)/);
    assert.match(runtimeExecutions.sql, /FOREIGN KEY\(parent_execution_id\)/);
    assert.strictEqual(
      migrationStore.getDb().prepare("SELECT value FROM meta WHERE key = 'platform_kernel_schema_version'").get().value,
      '10'
    );
    assert.strictEqual(
      runtimeStore.getDb().prepare("SELECT value FROM meta WHERE key = 'platform_kernel_schema_version'").get().value,
      '6'
    );
    console.log('Passed\n');

    console.log('Test KMP.5: migrations cover every compute_% table, column, and index the runtime creates');
    // Direction matters: migrations are the self-contained source of truth, so
    // they may be a superset (e.g. tables initialize() creates inline, or
    // indexes that exist only in migration files), but anything the runtime
    // bootstrap creates MUST be reachable through migrations alone. A gap here
    // is fixed by adding migration coverage, never by deleting runtime schema.
    for (const [table, shape] of Object.entries(runtimeCompute)) {
      const migrated = migratedCompute[table];
      assert.ok(migrated, `compute table exists only in the runtime bootstrap: ${table}`);
      for (const column of shape.columns) {
        assert.ok(migrated.columns.has(column), `compute column exists only in the runtime bootstrap: ${table}.${column}`);
      }
      for (const index of shape.indexes) {
        assert.ok(migrated.indexes.has(index), `compute index exists only in the runtime bootstrap: ${table} -> ${index}`);
      }
    }
    assert.ok(Object.keys(runtimeCompute).length >= 7, 'runtime compute bootstrap should create the core compute tables');
    console.log('Passed\n');

    console.log('Test KMP.4: kernel schema module stays in sync with the runtime boot');
    delete require.cache[require.resolve('../src/platform/kernel-schema')];
    const { KERNEL_SCHEMA_SQL } = require('../src/platform/kernel-schema');
    assert.ok(KERNEL_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS platform_backups'));
    assert.ok(KERNEL_SCHEMA_SQL.includes('idx_platform_executions_parent'));
    assert.ok(KERNEL_SCHEMA_SQL.includes('idx_platform_events_correlation'));
    assert.ok(KERNEL_SCHEMA_SQL.includes('FOREIGN KEY(parent_execution_id) REFERENCES platform_executions(execution_id)'));
    assert.ok(KERNEL_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS platform_projects'));
    assert.ok(KERNEL_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS platform_project_sources'));
    assert.ok(KERNEL_SCHEMA_SQL.includes('idx_platform_project_sources_source'));
    assert.ok(KERNEL_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS platform_workspace_secrets'));
    console.log('Passed\n');

    console.log('All Platform Kernel Migration Parity tests passed.');
    process.exit(0);
  } catch (error) {
    console.error('Platform Kernel Migration Parity test failed:', error);
    process.exit(1);
  }
})();
