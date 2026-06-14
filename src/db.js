const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = process.env.SIDEKICK_DB_FILE || path.join(DATA_DIR, "sidekick.db");
const MAX_LOG = Number(process.env.SIDEKICK_MAX_LOG || 1000);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });

let Database;
try {
  Database = require("better-sqlite3");
} catch (error) {
  throw new Error(
    "Sidekick database mode requires the better-sqlite3 package. " +
    "Run `npm install` before starting Sidekick. Original error: " + error.message
  );
}

const db = new Database(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    project TEXT,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS json_documents (
    name TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tool_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args_summary TEXT,
    duration_ms INTEGER,
    success INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    source TEXT,
    entry_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tool_logs_timestamp ON tool_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_tool_logs_tool_name ON tool_logs(tool_name);
  CREATE INDEX IF NOT EXISTS idx_tool_logs_success ON tool_logs(success);
`);

db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "1");

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getDocument(name, fallback) {
  const row = db.prepare("SELECT data_json FROM json_documents WHERE name = ?").get(name);
  if (!row) return fallback;
  return parseJson(row.data_json, fallback);
}

function setDocument(name, data) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO json_documents (name, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(name, JSON.stringify(data, null, 2), ts, ts);
}

function loadDocument(name, fallback) {
  const existing = getDocument(name, undefined);
  return existing !== undefined ? existing : fallback;
}

function loadKV(fallback = {}) {
  const rows = db.prepare("SELECT key, value_json FROM kv_store ORDER BY key").all();
  if (rows.length > 0) {
    const out = {};
    for (const row of rows) out[row.key] = parseJson(row.value_json, null);
    return out;
  }
  return fallback;
}

function clearKV() {
  db.prepare("DELETE FROM kv_store").run();
}

function setKV(key, value, project, source, category) {
  const ts = nowIso();
  const existing = getKV(key);
  const created = existing ? existing.created : ts;
  const entry = {
    value: value,
    project: project || null,
    category: category || null,
    source: source || null,
    created: created,
    updated: ts
  };
  db.prepare(`
    INSERT INTO kv_store (key, value_json, project, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      project = excluded.project,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(entry), project, source, ts, ts);
}

function getKV(key) {
  const row = db.prepare("SELECT value_json FROM kv_store WHERE key = ?").get(key);
  if (!row) return null;
  return parseJson(row.value_json, null);
}

function deleteKV(key) {
  db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
}

function listKVProjects() {
  const rows = db.prepare("SELECT DISTINCT project FROM kv_store WHERE project IS NOT NULL").all();
  return rows.map(r => r.project);
}

function getAllKV() {
  const rows = db.prepare("SELECT key, value_json FROM kv_store ORDER BY key").all();
  const out = {};
  for (const row of rows) {
    out[row.key] = parseJson(row.value_json, null);
  }
  return out;
}

function replaceKV(data) {
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM kv_store").run();
    const insert = db.prepare(`
      INSERT INTO kv_store (key, value_json, project, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [key, value] of Object.entries(data || {})) {
      const project = value && typeof value === "object" && !Array.isArray(value) ? value.project || null : null;
      const source = value && typeof value === "object" && !Array.isArray(value) ? value.source || null : null;
      const created = value && typeof value === "object" && !Array.isArray(value) ? value.created || ts : ts;
      const updated = value && typeof value === "object" && !Array.isArray(value) ? value.updated || ts : ts;
      insert.run(key, JSON.stringify(value), project, source, created, updated);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function appendToolLog(entry) {
  db.prepare(`
    INSERT INTO tool_logs (timestamp, tool_name, args_summary, duration_ms, success, summary, source, entry_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.t || nowIso(),
    entry.n || "unknown",
    entry.a || "",
    Number.isFinite(entry.d) ? Math.round(entry.d) : null,
    entry.ok ? 1 : 0,
    entry.s || "",
    entry.src || "unknown",
    JSON.stringify(entry)
  );

  const countRow = db.prepare("SELECT COUNT(*) AS count FROM tool_logs").get();
  if (countRow.count > MAX_LOG) {
    db.prepare(`
      DELETE FROM tool_logs
      WHERE id IN (
        SELECT id FROM tool_logs
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
      )
    `).run(countRow.count - MAX_LOG);
  }
}

function readToolLogs(limit = MAX_LOG) {
  const rows = db.prepare("SELECT entry_json FROM tool_logs ORDER BY timestamp DESC, id DESC LIMIT ?").all(limit);
  return rows.map((row) => parseJson(row.entry_json, null)).filter(Boolean);
}

function clearToolLogs() {
  db.prepare("DELETE FROM tool_logs").run();
}


module.exports = {
  DATA_DIR,
  DB_FILE,
  db,
  getDocument,
  setDocument,
  loadDocument,
  loadKV,
  clearKV,
  replaceKV,
  setKV,
  getKV,
  deleteKV,
  listKVProjects,
  getAllKV,
  appendToolLog,
  readToolLogs,
  clearToolLogs,
};
