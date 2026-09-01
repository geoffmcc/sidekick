"use strict";

function createDatabaseInspection({ getDb, fs, dbFile }) {
  function getTableList() {
    return getDb().prepare(`
      SELECT name, type, sql
      FROM sqlite_master
      WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();
  }

  function quoteIdentifier(identifier) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
      throw new Error(`Invalid identifier: ${identifier}`);
    }
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  function getTableInfo(tableName) {
    const db = getDb();
    const table = quoteIdentifier(tableName);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all();
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
    const indexDetails = indexes.map(idx => ({
      ...idx,
      columns: db.prepare(`PRAGMA index_info(${quoteIdentifier(idx.name)})`).all(),
    }));
    let rowCount = 0;
    try {
      rowCount = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
    } catch {}
    return { columns, indexes: indexDetails, foreignKeys, rowCount };
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  }

  function getDatabaseStats() {
    const db = getDb();
    const dbSize = fs.statSync(dbFile).size;
    const pageCount = db.prepare("PRAGMA page_count").get().page_count;
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    const freelistCount = db.prepare("PRAGMA freelist_count").get().freelist_count;
    const journalMode = db.prepare("PRAGMA journal_mode").get().journal_mode;
    const walCheckpoint = db.prepare("PRAGMA wal_checkpoint").get();
    const cacheSize = db.prepare("PRAGMA cache_size").get().cache_size;
    try {
      db.prepare(`
        SELECT
          SUM(CASE WHEN name LIKE 'sqlite_stat%' THEN 0 ELSE 1 END) as user_tables
        FROM sqlite_master
        WHERE type = 'table'
      `).get();
    } catch {}
    const tables = getTableList();
    const tableStats = tables.map(t => {
      let size = 0;
      let rowCount = 0;
      try {
        rowCount = db.prepare(`SELECT COUNT(*) as count FROM ${t.name}`).get().count;
        size = db.prepare(`SELECT page_count * ${pageSize} as size FROM pragma_page_count('${t.name}')`).get().size || 0;
      } catch {}
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
      totalTables: tables.length,
    };
  }

  return { getTableList, getTableInfo, getDatabaseStats, formatBytes, quoteIdentifier };
}

module.exports = { createDatabaseInspection };
