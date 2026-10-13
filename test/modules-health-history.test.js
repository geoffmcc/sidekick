"use strict";

// Regression coverage for the module health-history performance fix
// (migration 080 + src/platform/kernel-schema.js index, write-time coalescing
// in src/modules/health.js).
//
// The dashboard summary previously issued one synchronous
// `module.health.check` history lookup per module against a multi-million-row
// ledger with no subject-specific index: every lookup scanned all matching
// events and sorted them in a temp B-tree. This suite proves the indexed
// query plan, result ordering/bounds/ties, and the non-destructive coalescing
// of redundant successful health checks. It seeds a realistic (but bounded)
// fixture — no million-row routine tests.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-modules-health-history-"));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
if (process.env.SIDEKICK_DB_FILE) delete process.env.SIDEKICK_DB_FILE;

// Fresh module graph so the db handle binds to the isolated data dir.
for (const key of Object.keys(require.cache)) {
  if (/[\\/]src[\\/](db\.js|modules[\\/]|platform[\\/])/.test(key)) delete require.cache[key];
}

const dbStore = require("../src/db");
const repository = require("../src/modules/repository");
const health = require("../src/modules/health");

const INDEX_NAME = "idx_platform_events_type_subject";

function seedEvents({ healthPerModule = 1500, moduleCount = 28, otherEvents = 600 } = {}) {
  const db = dbStore.getDb();
  const insert = db.prepare(`
    INSERT INTO platform_execution_events (event_id, event_type, timestamp, source, subject_type, subject_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    let id = 0;
    for (let i = 0; i < healthPerModule; i++) {
      const ok = i % 7 !== 0;
      const ts = new Date(1700000000000 + i * 1000).toISOString();
      const payload = JSON.stringify({ module: null, ok, state: ok ? "healthy" : "error", health: { ok }, error: ok ? null : "synthetic" });
      for (let m = 0; m < moduleCount; m++) {
        insert.run("evt-h-" + id, "module.health.check", ts, "modules", "module", "module-" + m, payload);
        id++;
      }
    }
    for (let i = 0; i < otherEvents; i++) {
      insert.run("evt-o-" + id, "tool.call", new Date(1700000000000 + i * 1000).toISOString(), "tools", "tool", "some-tool", "{}");
      id++;
    }
  });
  tx();
  return { healthPerModule, moduleCount, otherEvents };
}

function countHealthEvents(subjectId) {
  return dbStore.getDb().prepare(`
    SELECT COUNT(*) AS count FROM platform_execution_events
    WHERE event_type = 'module.health.check' AND subject_id = ?
  `).get(subjectId).count;
}

before(() => {
  dbStore.runPendingMigrations();
});

after(() => {
  try { dbStore.closeDatabase(); } catch {}
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("migration 080 creates the (event_type, subject_id) health-history index", () => {
  const row = dbStore.getDb().prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?"
  ).get(INDEX_NAME);
  assert.ok(row, `${INDEX_NAME} must exist after migrations`);
  assert.match(row.sql, /ON platform_execution_events\(event_type,\s*subject_id\)/);
  // Idempotent: applying the migration again must not throw.
  dbStore.runPendingMigrations();
});

test("health history lookup uses the subject index and avoids a temp sort", () => {
  const seeded = seedEvents();
  const detail = dbStore.getDb().prepare(`
    EXPLAIN QUERY PLAN
    SELECT event_id, timestamp, payload_json
    FROM platform_execution_events
    WHERE event_type = 'module.health.check' AND subject_id = ?
    ORDER BY rowid DESC
    LIMIT ?
  `).all("module-3", 5).map(r => r.detail).join(" | ");

  assert.match(detail, new RegExp(`USING INDEX ${INDEX_NAME}`),
    `query must seek via ${INDEX_NAME}: ${detail}`);
  assert.doesNotMatch(detail, /TEMP B-TREE/,
    `rowid DESC must be satisfied by a reverse index scan, no temp sort: ${detail}`);
  assert.doesNotMatch(detail, /idx_platform_events_type \(/,
    `must not fall back to the broad event_type-only index: ${detail}`);

  // Every module's history resolves through the same indexed seek.
  for (let m = 0; m < seeded.moduleCount; m++) {
    assert.doesNotMatch(
      dbStore.getDb().prepare("EXPLAIN QUERY PLAN SELECT event_id FROM platform_execution_events WHERE event_type = 'module.health.check' AND subject_id = ? ORDER BY rowid DESC LIMIT 5")
        .all(`module-${m}`).map(r => r.detail).join(" | "),
      /TEMP B-TREE/,
      `module-${m} history must not temp-sort`
    );
  }
});

test("listHealthHistory returns bounded, newest-first history with payload mapping", () => {
  // Newest inserted event for module-3 is i = 1499 (1499 % 7 = 1 -> ok).
  const history = repository.listHealthHistory("module-3", 5);
  assert.equal(history.length, 5, "limit of 5 is honored");
  assert.equal(history[0].ok, true, "newest health result is mapped");
  assert.equal(history[4].ok, true, "health history stays within the recent window");
  const rowIds = history.map(h => h.event_id);
  assert.deepEqual(rowIds, [...rowIds].sort().reverse(), "rowid DESC ordering via insertion sequence");

  // Limit sanitization: 0 is falsy and falls back to the default (10);
  // huge values cap at 20.
  assert.equal(repository.listHealthHistory("module-0", 0).length, 10);
  assert.equal(repository.listHealthHistory("module-0", 999).length, 20);

  // Per-module isolation: another module's history is independent.
  assert.equal(repository.listHealthHistory("module-7", 5).length, 5);
  assert.equal(repository.listHealthHistory("does-not-exist", 5).length, 0);
});

test("coalescing skips redundant successful checks but records failures and recoveries", () => {
  const subject = "coalesce-mod";
  health.appendHealthEvent(subject, { ok: true }, { state: "healthy" });
  assert.equal(countHealthEvents(subject), 1, "first success is recorded");
  health.appendHealthEvent(subject, { ok: true }, { state: "healthy" });
  assert.equal(countHealthEvents(subject), 1, "repeat success inside the window is coalesced");
  health.appendHealthEvent(subject, { ok: false, error: "boom" }, { state: "error" });
  assert.equal(countHealthEvents(subject), 2, "failures are never coalesced");
  health.appendHealthEvent(subject, { ok: true }, { state: "healthy" });
  assert.equal(countHealthEvents(subject), 3, "recovery after a failure is recorded");
  // Coalescing reads the latest ledger entry via the indexed lookup; the
  // latest entry is now a success, so the next success is skipped again.
  health.appendHealthEvent(subject, { ok: true }, { state: "healthy" });
  assert.equal(countHealthEvents(subject), 3, "steady-state successes stay coalesced");
});

test("coalescing is disabled when the window is 0 (every check recorded)", () => {
  delete require.cache[require.resolve("../src/modules/health")];
  const previous = process.env.SIDEKICK_MODULE_HEALTH_COALESCE_MS;
  process.env.SIDEKICK_MODULE_HEALTH_COALESCE_MS = "0";
  try {
    const healthOff = require("../src/modules/health");
    const subject = "coalesce-off-mod";
    healthOff.appendHealthEvent(subject, { ok: true }, { state: "healthy" });
    healthOff.appendHealthEvent(subject, { ok: true }, { state: "healthy" });
    assert.equal(countHealthEvents(subject), 2, "window 0 records every check");
  } finally {
    if (previous === undefined) delete process.env.SIDEKICK_MODULE_HEALTH_COALESCE_MS;
    else process.env.SIDEKICK_MODULE_HEALTH_COALESCE_MS = previous;
    delete require.cache[require.resolve("../src/modules/health")];
  }
});