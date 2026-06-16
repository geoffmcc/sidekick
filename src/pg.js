const { Pool } = require("pg");

const POSTGRES_URL = process.env.SIDEKICK_POSTGRES_URL || "postgresql://sidekick:sidekick@127.0.0.1:5432/sidekick";

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: POSTGRES_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

function isReadonlySql(sql) {
  const trimmed = String(sql || "").trim();
  if (!trimmed) return false;
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) return false;

  const upper = withoutTrailingSemicolon.toUpperCase();
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|TRUNCATE|GRANT|REVOKE)\b/.test(upper)) {
    return false;
  }
  return /^(SELECT|WITH|EXPLAIN|SHOW)\b/.test(upper);
}

function clampLimit(limit) {
  const parsed = parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1000;
  return Math.min(parsed, 5000);
}

async function executeQuery(sql, params = [], options = {}) {
  const { readonly = true, limit = 1000, timeout = 5000 } = options;
  const maxRows = clampLimit(limit);

  if (readonly && !isReadonlySql(sql)) {
    throw new Error("Write operations are not allowed in readonly mode. Set readonly=false to allow.");
  }

  let limitedSql = sql;
  if (readonly && !/\bLIMIT\b/i.test(sql)) {
    limitedSql = sql.replace(/;?\s*$/, "") + ` LIMIT ${maxRows}`;
  }

  const client = await getPool().connect();
  try {
    const result = await client.query({
      text: limitedSql,
      values: params || [],
    });
    return result.rows.slice(0, maxRows);
  } finally {
    client.release();
  }
}

async function getTableList() {
  const result = await getPool().query(`
    SELECT table_name as name, table_type as type
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  return result.rows;
}

async function getTableInfo(tableName) {
  const columnsResult = await getPool().query(`
    SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);

  const indexesResult = await getPool().query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = $1
  `, [tableName]);

  const foreignKeysResult = await getPool().query(`
    SELECT
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
  `, [tableName]);

  let rowCount = 0;
  try {
    const countResult = await getPool().query(`SELECT COUNT(*) as count FROM "${tableName}"`);
    rowCount = parseInt(countResult.rows[0].count, 10);
  } catch (e) {}

  return {
    columns: columnsResult.rows,
    indexes: indexesResult.rows,
    foreignKeys: foreignKeysResult.rows,
    rowCount,
  };
}

async function getDatabaseStats() {
  const sizeResult = await getPool().query(`
    SELECT pg_size_pretty(pg_database_size(current_database())) as size,
           pg_database_size(current_database()) as size_bytes
  `);

  const tablesResult = await getPool().query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);

  const tableStats = [];
  for (const row of tablesResult.rows) {
    try {
      const countResult = await getPool().query(`SELECT COUNT(*) as count FROM "${row.table_name}"`);
      const sizeResult = await getPool().query(`
        SELECT pg_size_pretty(pg_total_relation_size($1)) as size
      `, [row.table_name]);
      tableStats.push({
        name: row.table_name,
        rowCount: parseInt(countResult.rows[0].count, 10),
        size: sizeResult.rows[0].size,
      });
    } catch (e) {}
  }

  return {
    database: sizeResult.rows[0],
    tables: tableStats,
    totalTables: tablesResult.rows.length,
  };
}

async function exportTable(tableName, format = "json") {
  const result = await getPool().query(`SELECT * FROM "${tableName}"`);
  const rows = result.rows;

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
      lines.push(`INSERT INTO "${tableName}" (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
    }
    return lines.join("\n");
  }

  throw new Error(`Unsupported export format: ${format}`);
}

async function searchAllTables(query, options = {}) {
  const { tables = null, limit = 50 } = options;

  const results = [];
  const tablesResult = await getPool().query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);

  const searchTables = tables
    ? tablesResult.rows.filter(r => tables.includes(r.table_name))
    : tablesResult.rows;

  for (const table of searchTables) {
    const columnsResult = await getPool().query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
    `, [table.table_name]);

    const textColumns = columnsResult.rows.filter(c =>
      c.data_type.toLowerCase().includes("text") ||
      c.data_type.toLowerCase().includes("char") ||
      c.data_type.toLowerCase().includes("varchar")
    );

    for (const col of textColumns) {
      try {
        const rows = await executeQuery(`
          SELECT ctid, "${col.column_name}" FROM "${table.table_name}"
          WHERE "${col.column_name}"::text ILIKE $1
          LIMIT 10
        `, [`%${query}%`], { readonly: true, limit: 10 });

        for (const row of rows) {
          results.push({
            table: table.table_name,
            column: col.column_name,
            snippet: String(row[col.column_name]).substring(0, 200),
          });
        }
      } catch (e) {}
    }

    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

async function testConnection() {
  try {
    const client = await getPool().connect();
    await client.query("SELECT 1");
    client.release();
    return { connected: true };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

module.exports = {
  executeQuery,
  getTableList,
  getTableInfo,
  getDatabaseStats,
  exportTable,
  searchAllTables,
  testConnection,
  getPool,
};
