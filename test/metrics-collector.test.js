"use strict";

// Metrics collector: the tool_logs queries behind the Grafana dashboards.
//
// tool_logs stores CANONICAL (unprefixed) tool names — the dispatcher strips
// the `sidekick_` prefix before logging. The database-performance query filtered
// on the prefixed form only, matched zero rows, returned null, and so the
// database_performance measurement was never written. Nothing errored; the
// dashboard simply stayed empty.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-"));
const DB_PATH = path.join(TMP, "sidekick.db");

// Point the collector at the fixture DB before requiring it, and give it a
// token so its fail-closed guard is satisfied.
process.env.SIDEKICK_DB_FILE = DB_PATH;
process.env.SIDEKICK_INFLUX_TOKEN = "test-token-not-a-placeholder";

function seed(rows) {
  const db = new Database(DB_PATH);
  db.exec("DROP TABLE IF EXISTS tool_logs");
  db.exec(`CREATE TABLE tool_logs (
    tool_name TEXT, success INTEGER, duration_ms INTEGER, timestamp TEXT
  )`);
  const insert = db.prepare("INSERT INTO tool_logs VALUES (?, ?, ?, ?)");
  const now = new Date().toISOString();
  for (const [name, ok, ms] of rows) insert.run(name, ok, ms, now);
  db.close();
}

// Required AFTER the env is set. The module only auto-runs a collection when
// invoked directly, so requiring it here is side-effect free.
const collector = require("../scripts/collect-metrics");

console.log("Running Metrics Collector Tests...\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    ${e.stack || e.message}`); }
}

test("database metrics are collected from canonical (unprefixed) tool names", () => {
  // This is the shape actually stored in production: no sidekick_ prefix.
  seed([["db_query", 1, 12], ["db_schema", 1, 8], ["bash", 1, 40]]);
  const m = collector.collectDatabaseMetrics();
  assert.ok(m, "must return metrics — returning null means the measurement is never written");
  assert.strictEqual(m.query_count, 2, "only the db_* tools counted, not bash");
  assert.strictEqual(m.database, "sqlite");
  assert.strictEqual(m.cache_hit_ratio, 100);
});

test("the legacy sidekick_-prefixed shape still works", () => {
  // Historical rows may carry the prefix; the filter must not regress for them.
  seed([["sidekick_db_query", 1, 20], ["sidekick_bash", 1, 5]]);
  const m = collector.collectDatabaseMetrics();
  assert.ok(m, "prefixed rows must still be collected");
  assert.strictEqual(m.query_count, 1);
});

test("both name shapes are counted together", () => {
  seed([["db_query", 1, 10], ["sidekick_db_schema", 0, 30], ["health", 1, 2]]);
  const m = collector.collectDatabaseMetrics();
  assert.strictEqual(m.query_count, 2, "unprefixed and prefixed db tools both counted");
  assert.strictEqual(m.cache_hit_ratio, 50, "one of two succeeded");
});

test("no database tool calls yields null rather than a zero-filled point", () => {
  seed([["bash", 1, 40], ["git", 1, 15]]);
  assert.strictEqual(collector.collectDatabaseMetrics(), null,
    "writing a zero point would misreport idle as measured activity");
});

test("tool metrics are grouped per tool and unaffected by name shape", () => {
  seed([["bash", 1, 10], ["bash", 0, 30], ["db_query", 1, 5]]);
  const rows = collector.collectToolMetrics();
  const byName = Object.fromEntries(rows.map(r => [r.tool_name, r]));
  assert.strictEqual(rows.length, 2, "one row per distinct tool");
  assert.strictEqual(byName.bash.count, 2);
  assert.strictEqual(byName.bash.error_count, 1);
  assert.strictEqual(byName.bash.success_rate, 50);
  assert.strictEqual(byName.db_query.count, 1);
});

test("requiring the collector does not run a collection", () => {
  // The module used to call collectAll() and exit(1) on a missing token at
  // require time, which made it untestable and would kill this process.
  assert.strictEqual(typeof collector.collectDatabaseMetrics, "function");
  assert.strictEqual(typeof collector.collectToolMetrics, "function");
});

// --- dashboard guard ---------------------------------------------------------

test("no dashboard pins a stale template variable selection", () => {
  // tool-analytics filters every panel on ${tool}. A saved `current` value that
  // no longer exists (it was the prefixed "sidekick_bash") matches no series, so
  // every panel renders empty while the datasource itself is perfectly healthy.
  const dir = path.join(__dirname, "..", "grafana", "dashboards");
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const dash = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const v of (dash.templating && dash.templating.list) || []) {
      if (v.type !== "query") continue;
      const cur = v.current && v.current.value;
      if (cur && String(cur).startsWith("sidekick_")) {
        offenders.push(`${file}:${v.name}=${cur}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    "a query variable must resolve from its query, not a pinned prefixed value: " + offenders.join(", "));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
