const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = process.env.SIDEKICK_DB_FILE || path.join(DATA_DIR, "sidekick.db");
const BACKUP_DIR = process.env.SIDEKICK_BACKUP_DIR || path.join(DATA_DIR, "backups");
const MIGRATIONS_DIR = process.env.SIDEKICK_MIGRATIONS_DIR || path.join(__dirname, "..", "migrations");
const MAX_LOG = Number(process.env.SIDEKICK_MAX_LOG || 1000);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o750 });

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

// === Database Tool Helpers ===

function clampLimit(limit) {
  const parsed = parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1000;
  return Math.min(parsed, 5000);
}

function isReadonlySql(sql) {
  const trimmed = String(sql || "").trim();
  if (!trimmed) return false;
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) return false;

  const upper = withoutTrailingSemicolon.toUpperCase();
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|ATTACH|DETACH|REINDEX)\b/.test(upper)) {
    return false;
  }
  if (upper.startsWith("PRAGMA")) {
    return /^PRAGMA\s+(TABLE_INFO|INDEX_LIST|INDEX_INFO|FOREIGN_KEY_LIST|JOURNAL_MODE|PAGE_COUNT|PAGE_SIZE|DATABASE_LIST|INTEGRITY_CHECK|QUICK_CHECK)\b/.test(upper);
  }
  return /^(SELECT|WITH|EXPLAIN)\b/.test(upper);
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function executeQuery(sql, params = [], options = {}) {
  const { readonly = true, limit = 1000, timeout = 5000 } = options;
  const maxRows = clampLimit(limit);
  
  if (readonly && !isReadonlySql(sql)) {
    throw new Error("Write operations and multi-statement SQL are not allowed in readonly mode. Set readonly=false to allow.");
  }
  
  let limitedSql = sql;
  if (readonly && !/^\s*PRAGMA\b/i.test(sql) && !/\bLIMIT\b/i.test(sql)) {
    limitedSql = sql.replace(/;?\s*$/, "") + ` LIMIT ${maxRows}`;
  }
  
  const stmt = db.prepare(limitedSql);
  if (readonly && !stmt.reader) {
    throw new Error("Readonly mode only allows statements that return rows.");
  }
  const results = stmt.all(...params);
  return results.slice(0, maxRows);
}

function getTableList() {
  return db.prepare(`
    SELECT name, type, sql 
    FROM sqlite_master 
    WHERE type IN ('table', 'view') 
    AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
}

function getTableInfo(tableName) {
  const table = quoteIdentifier(tableName);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all();
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  
  const indexDetails = indexes.map(idx => ({
    ...idx,
    columns: db.prepare(`PRAGMA index_info(${quoteIdentifier(idx.name)})`).all()
  }));
  
  let rowCount = 0;
  try {
    rowCount = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
  } catch (e) {}
  
  return { columns, indexes: indexDetails, foreignKeys, rowCount };
}

function getDatabaseStats() {
  const dbSize = fs.statSync(DB_FILE).size;
  
  const pageCount = db.prepare("PRAGMA page_count").get().page_count;
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  const freelistCount = db.prepare("PRAGMA freelist_count").get().freelist_count;
  
  const journalMode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  const walCheckpoint = db.prepare("PRAGMA wal_checkpoint").get();
  
  const cacheSize = db.prepare("PRAGMA cache_size").get().cache_size;
  
  let cacheHitRatio = null;
  try {
    const stats = db.prepare(`
      SELECT 
        SUM(CASE WHEN name LIKE 'sqlite_stat%' THEN 0 ELSE 1 END) as user_tables
      FROM sqlite_master 
      WHERE type = 'table'
    `).get();
  } catch (e) {}
  
  const tables = getTableList();
  const tableStats = tables.map(t => {
    let size = 0;
    let rowCount = 0;
    try {
      rowCount = db.prepare(`SELECT COUNT(*) as count FROM ${t.name}`).get().count;
      size = db.prepare(`SELECT page_count * ${pageSize} as size FROM pragma_page_count('${t.name}')`).get().size || 0;
    } catch (e) {}
    return { name: t.name, rowCount, size };
  });
  
  return {
    dbSize,
    dbSizeHuman: formatBytes(dbSize),
    pageCount,
    pageSize,
    freelistCount,
    journalMode,
    walCheckpoint,
    cacheSize,
    tables: tableStats,
    totalTables: tables.length
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

function createBackup(destPath = null, compress = true) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `sidekick-backup-${timestamp}.db`;
  const backupPath = destPath || path.join(BACKUP_DIR, backupName);
  
  // Close main db to ensure clean state, then copy
  const backupDb = new Database(backupPath);
  try {
    // Use synchronous backup via file copy
    // First checkpoint WAL to main db file
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
    // Copy the database file
    fs.copyFileSync(DB_FILE, backupPath);
    backupDb.close();
    
    if (compress) {
      const input = fs.readFileSync(backupPath);
      const compressed = zlib.gzipSync(input);
      fs.writeFileSync(backupPath + ".gz", compressed);
      fs.unlinkSync(backupPath);
      return { path: backupPath + ".gz", size: compressed.length, compressed: true };
    }
    
    return { path: backupPath, size: fs.statSync(backupPath).size, compressed: false };
  } catch (err) {
    try { backupDb.close(); } catch (e) {}
    throw err;
  }
}

function restoreBackup(backupPath, verify = true) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }
  
  let tempPath = backupPath;
  if (backupPath.endsWith(".gz")) {
    tempPath = backupPath.replace(".gz", ".tmp");
    const compressed = fs.readFileSync(backupPath);
    const decompressed = zlib.gunzipSync(compressed);
    fs.writeFileSync(tempPath, decompressed);
  }
  
  if (verify) {
    const testDb = new Database(tempPath);
    try {
      testDb.prepare("PRAGMA integrity_check").get();
    } catch (e) {
      testDb.close();
      if (tempPath !== backupPath) fs.unlinkSync(tempPath);
      throw new Error("Backup integrity check failed: " + e.message);
    }
    testDb.close();
  }
  
  // Create pre-restore backup using synchronous file copy
  const preBackupPath = path.join(BACKUP_DIR, `pre-restore-${Date.now()}.db`);
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
    fs.copyFileSync(DB_FILE, preBackupPath);
  } catch (err) {
    if (tempPath !== backupPath) fs.unlinkSync(tempPath);
    throw err;
  }
  
  // Restore by copying backup file over main db
  try {
    fs.copyFileSync(tempPath, DB_FILE);
    if (tempPath !== backupPath) fs.unlinkSync(tempPath);
    return { success: true, preBackupPath };
  } catch (err) {
    if (tempPath !== backupPath) fs.unlinkSync(tempPath);
    throw err;
  }
}

function queryToolLogs(filters = {}) {
  const { tool, source, success, since, until, limit = 100 } = filters;
  
  let where = [];
  let params = [];
  
  if (tool) {
    where.push("tool_name = ?");
    params.push(tool);
  }
  if (source) {
    where.push("source = ?");
    params.push(source);
  }
  if (success !== undefined && success !== null) {
    where.push("success = ?");
    params.push(success ? 1 : 0);
  }
  if (since) {
    where.push("timestamp >= ?");
    params.push(since);
  }
  if (until) {
    where.push("timestamp <= ?");
    params.push(until);
  }
  
  const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
  const sql = `SELECT entry_json FROM tool_logs ${whereClause} ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);
  
  const rows = db.prepare(sql).all(...params);
  return rows.map(row => parseJson(row.entry_json, null)).filter(Boolean);
}

function exportTable(tableName, format = "json") {
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
  
  if (format === "json") {
    return JSON.stringify(rows, null, 2);
  }
  
  if (format === "csv") {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const csvRows = [headers.join(",")];
    for (const row of rows) {
      const values = headers.map(h => {
        const val = row[h];
        if (val === null) return "";
        if (typeof val === "string" && (val.includes(",") || val.includes('"') || val.includes("\n"))) {
          return '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      });
      csvRows.push(values.join(","));
    }
    return csvRows.join("\n");
  }
  
  if (format === "sql") {
    const lines = [];
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map(c => {
        const val = row[c];
        if (val === null) return "NULL";
        if (typeof val === "number") return val;
        return "'" + String(val).replace(/'/g, "''") + "'";
      });
      lines.push(`INSERT INTO ${tableName} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
    }
    return lines.join("\n");
  }
  
  throw new Error(`Unsupported export format: ${format}`);
}

function setupFTS5() {
  const tables = getTableList().filter(t => t.type === "table");
  
  for (const table of tables) {
    const ftsTableName = `${table.name}_fts`;
    
    try {
      db.prepare(`DROP TABLE IF EXISTS ${ftsTableName}`).run();
    } catch (e) {}
    
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
    const textColumns = columns.filter(c => 
      c.type.toUpperCase().includes("TEXT") || 
      c.type.toUpperCase().includes("CHAR") ||
      c.type.toUpperCase().includes("CLOB")
    );
    
    if (textColumns.length === 0) continue;
    
    const columnNames = textColumns.map(c => c.name).join(", ");
    
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTableName} USING fts5(
          rowid UNINDEXED,
          ${textColumns.map(c => c.name).join(", ")}
        );
        
        INSERT INTO ${ftsTableName} (rowid, ${columnNames})
        SELECT rowid, ${columnNames} FROM ${table.name};
      `);
    } catch (e) {
      console.error(`FTS5 setup failed for ${table.name}:`, e.message);
    }
  }
  
  return { success: true };
}

function searchAllTables(query, options = {}) {
  const { tables = null, limit = 50 } = options;
  
  const results = [];
  const ftsTables = getTableList().filter(t => t.name.endsWith("_fts"));
  
  for (const ftsTable of ftsTables) {
    const baseTableName = ftsTable.name.replace("_fts", "");
    
    if (tables && !tables.includes(baseTableName)) continue;
    
    try {
      const rows = db.prepare(`
        SELECT rowid, * FROM ${ftsTable.name} 
        WHERE ${ftsTable.name} MATCH ? 
        LIMIT ?
      `).all(query, limit);
      
      for (const row of rows) {
        results.push({
          table: baseTableName,
          rowid: row.rowid,
          snippet: Object.values(row).filter(v => typeof v === "string").join(" ").substring(0, 200)
        });
      }
    } catch (e) {}
  }
  
  if (results.length === 0) {
    const searchTables = tables 
      ? getTableList().filter(t => tables.includes(t.name) && t.type === "table")
      : getTableList().filter(t => t.type === "table");
    
    for (const table of searchTables) {
      const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
      const textColumns = columns.filter(c => 
        c.type.toUpperCase().includes("TEXT") || 
        c.type.toUpperCase().includes("CHAR")
      );
      
      for (const col of textColumns) {
        try {
          const rows = db.prepare(`
            SELECT rowid, ${col.name} FROM ${table.name}
            WHERE ${col.name} LIKE ?
            LIMIT ?
          `).all(`%${query}%`, Math.min(limit, 10));
          
          for (const row of rows) {
            results.push({
              table: table.name,
              rowid: row.rowid,
              column: col.name,
              snippet: String(row[col.name]).substring(0, 200)
            });
          }
        } catch (e) {}
      }
      
      if (results.length >= limit) break;
    }
  }
  
  return results.slice(0, limit);
}

function getMigrationVersion() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? parseInt(row.value, 10) : 0;
}

function runMigration(name, upSql, downSql) {
  const currentVersion = getMigrationVersion();
  
  const migrationMatch = name.match(/^(\d+)_/);
  if (!migrationMatch) {
    throw new Error("Migration name must start with version number: NNN_name.sql");
  }
  const targetVersion = parseInt(migrationMatch[1], 10);
  
  if (targetVersion <= currentVersion) {
    return { skipped: true, reason: "Migration already applied" };
  }
  
  db.exec(upSql);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(targetVersion));
  
  return { success: true, version: targetVersion };
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();
  
  const currentVersion = getMigrationVersion();
  
  return files.map(f => {
    const match = f.match(/^(\d+)_/);
    const version = match ? parseInt(match[1], 10) : 0;
    return {
      file: f,
      version,
      applied: version <= currentVersion
    };
  });
}

function createSnapshot() {
  const tables = getTableList().filter(t => t.type === "table");
  const snapshot = {};
  
  for (const table of tables) {
    snapshot[table.name] = db.prepare(`SELECT * FROM ${table.name}`).all();
  }
  
  return {
    timestamp: nowIso(),
    tables: snapshot
  };
}

function compareSnapshots(snapshotA, snapshotB) {
  const diff = {};
  
  const allTables = new Set([
    ...Object.keys(snapshotA.tables || {}),
    ...Object.keys(snapshotB.tables || {})
  ]);
  
  for (const tableName of allTables) {
    const rowsA = snapshotA.tables[tableName] || [];
    const rowsB = snapshotB.tables[tableName] || [];
    
    const mapA = new Map(rowsA.map(r => [JSON.stringify(r), r]));
    const mapB = new Map(rowsB.map(r => [JSON.stringify(r), r]));
    
    const added = rowsB.filter(r => !mapA.has(JSON.stringify(r)));
    const removed = rowsA.filter(r => !mapB.has(JSON.stringify(r)));
    
    if (added.length > 0 || removed.length > 0) {
      diff[tableName] = { added, removed };
    }
  }
  
  return diff;
}


function getDb() {
  return db;
}

module.exports = {
  DATA_DIR,
  DB_FILE,
  BACKUP_DIR,
  MIGRATIONS_DIR,
  db,
  getDb,
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
  executeQuery,
  getTableList,
  getTableInfo,
  getDatabaseStats,
  createBackup,
  restoreBackup,
  queryToolLogs,
  exportTable,
  setupFTS5,
  searchAllTables,
  getMigrationVersion,
  runMigration,
  listMigrations,
  createSnapshot,
  compareSnapshots,
};
