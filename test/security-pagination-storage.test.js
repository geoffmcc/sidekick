"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-security-pagination-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
const dbStore = require("../src/db");
const { normalizeDatabaseSearchRequest, MAX_SEARCH_QUERY_CHARS, MAX_SEARCH_LIMIT } = require("../src/db/search-bounds");
dbStore.runPendingMigrations();
const taskStore = require("../src/agent/task-store");

test("generated execution list binds finite limits for negative and oversized inputs", () => {
  const db = dbStore.getDb();
  db.prepare(`INSERT INTO generated_capabilities
    (id, name, state, description, evidence_json, parameters_json, steps_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("cap-pagination", "pagination", "active", "fixture", "[]", "{}", "[]");
  const insert = db.prepare(`INSERT INTO generated_tool_executions
    (id, capability_id, tool_name, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (let index = 0; index < 230; index++) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    insert.run(`exec-pagination-${index}`, "cap-pagination", "fixture_tool", "completed", timestamp, timestamp);
  }

  assert.equal(dbStore.listGeneratedToolExecutions({ limit: -1 }).length, 50);
  assert.equal(dbStore.listGeneratedToolExecutions({ limit: 999999 }).length, 200);
});

test("Agent task store binds a default limit and bounded offset for hostile values", () => {
  const originalGetDb = dbStore.getDb;
  let queryBindings;
  dbStore.getDb = () => ({
    prepare(sql) {
      if (sql === "SELECT task_id FROM agent_tasks LIMIT 1") return { get: () => ({ task_id: "schema-ready" }) };
      return { all: (...bindings) => { queryBindings = bindings; return []; } };
    },
  });
  try {
    taskStore.listTasks({ limit: -1, offset: 1e12 });
    assert.deepEqual(queryBindings, [50, 10000]);
    taskStore.listTasks({ limit: 999999, offset: -10 });
    assert.deepEqual(queryBindings, [100, 0]);
  } finally {
    dbStore.getDb = originalGetDb;
  }
});

test("database search normalizes hostile inputs and enforces a global FTS result cap", () => {
  const longQuery = ` ${"x".repeat(MAX_SEARCH_QUERY_CHARS + 20)} `;
  assert.deepEqual(normalizeDatabaseSearchRequest(longQuery, { limit: 999999, tables: Array(80).fill("table") }), {
    query: "x".repeat(MAX_SEARCH_QUERY_CHARS),
    tables: ["table"],
    limit: MAX_SEARCH_LIMIT,
  });
  assert.equal(normalizeDatabaseSearchRequest("needle", { limit: -1 }).limit, 50);

  const db = dbStore.getDb();
  db.exec("CREATE VIRTUAL TABLE security_search_a_fts USING fts5(content)");
  db.exec("CREATE VIRTUAL TABLE security_search_b_fts USING fts5(content)");
  for (const table of ["security_search_a_fts", "security_search_b_fts"]) {
    const insert = db.prepare(`INSERT INTO ${table} (content) VALUES (?)`);
    insert.run("needle a");
    insert.run("needle b");
  }
  assert.equal(dbStore.searchAllTables("needle", { limit: 1 }).length, 1);
  assert.deepEqual(dbStore.searchAllTables("   ", { limit: 500 }), []);
});

test("KV storage applies project, prefix, count, deletion, size, and pagination bounds in SQLite", () => {
  const put = (key, value, project) => dbStore.setKV(key, { value }, project, "security-test");
  put("page:a", "one", "project-a");
  put("page:b", "two", "project-a");
  put("page:c", "three", "project-b");

  const page = dbStore.listScopedKV({ project: "project-a", keyPrefix: "page:", limit: 1 });
  assert.deepEqual(page.entries.map(([key]) => key), ["page:a"]);
  assert.equal(page.truncated, true);
  assert.deepEqual(dbStore.listKVProjectPage(1), { projects: ["project-a"], truncated: true });
  assert.equal(dbStore.countKV(), 3);
  assert.equal(dbStore.deleteKVByPrefix("page:b"), 1);
  assert.equal(dbStore.hasKV("page:b"), false);
  assert.throws(() => put("oversized", "x".repeat(2 * 1024 * 1024 + 1), "project-a"), { code: "KV_VALUE_TOO_LARGE" });
});

test("sync diff limits returned memory records to the requested project", () => {
  dbStore.upsertMemory({ type: "fact", project: "sync_project_a", content: "synthetic project A", summary: "A", confidence: 0.9, source: "security-test" });
  dbStore.upsertMemory({ type: "fact", project: "sync_project_b", content: "synthetic project B", summary: "B", confidence: 0.9, source: "security-test" });
  const diff = dbStore.getSyncDiff("2000-01-01T00:00:00.000Z", { project: "sync_project_a" });
  assert.ok(diff.changes.length > 0);
  assert.ok(diff.changes.every(change => change.project === "sync_project_a"));
});

test.after(() => {
  try { dbStore.closeDatabase(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});
