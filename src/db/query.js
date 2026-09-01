"use strict";

function createDatabaseQuery({ getDb }) {
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
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|ATTACH|DETACH|REINDEX)\b/.test(upper)) return false;
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
    const { readonly = true, limit = 1000 } = options;
    const maxRows = clampLimit(limit);
    if (readonly && !isReadonlySql(sql)) {
      throw new Error("Write operations and multi-statement SQL are not allowed in readonly mode. Set readonly=false to allow.");
    }
    let limitedSql = sql;
    if (readonly && !/^\s*PRAGMA\b/i.test(sql) && !/\bLIMIT\b/i.test(sql)) {
      limitedSql = sql.replace(/;?\s*$/, "") + ` LIMIT ${maxRows}`;
    }
    const stmt = getDb().prepare(limitedSql);
    if (readonly && !stmt.reader) throw new Error("Readonly mode only allows statements that return rows.");
    return stmt.all(...params).slice(0, maxRows);
  }

  return { clampLimit, isReadonlySql, quoteIdentifier, executeQuery };
}

module.exports = { createDatabaseQuery };
