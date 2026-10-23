"use strict";

const fs = require("fs");
const { z } = require("zod");
const dbStore = require("../../db");
const pgStore = require("../../pg");
const { enforcePathPolicy } = require("../path-policy");
const { getStaticToolRisk } = require("../metadata");
const { requireToolExecution, requireCanonicalInvocation } = require("../read-authorization");

const MAX_SNAPSHOT_BYTES = dbStore.MAX_SNAPSHOT_BYTES;

function readSnapshot(filePath) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Snapshot must be a regular non-symlink file");
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error("Snapshot changed while being opened");
    }
    if (enforcePathPolicy(filePath, "read")) throw new Error("Snapshot path is no longer allowed by policy");
    if (stat.size > MAX_SNAPSHOT_BYTES) throw new Error(`Snapshot exceeds the ${MAX_SNAPSHOT_BYTES} byte limit`);
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_SNAPSHOT_BYTES + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SNAPSHOT_BYTES) throw new Error(`Snapshot exceeds the ${MAX_SNAPSHOT_BYTES} byte limit`);
    const parsed = JSON.parse(buffer.toString("utf8", 0, offset));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !parsed.tables || typeof parsed.tables !== "object" || Array.isArray(parsed.tables)) {
      throw new Error("Snapshot must contain a tables object");
    }
    for (const rows of Object.values(parsed.tables)) {
      if (!Array.isArray(rows)) throw new Error("Snapshot tables must contain row arrays");
    }
    return parsed;
  } finally {
    fs.closeSync(fd);
  }
}

const jsonResult = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const errorResult = error => ({ content: [{ type: "text", text: "Error: " + error.message }], isError: true });

async function sidekick_db_schema({ table, verbose, database }) {
  const authError = requireToolExecution({ tool: "db_schema", database: database || "sqlite" }, "database.inspect", "db_schema");
  if (authError) return authError;
  try {
    if (database === "postgres") {
      if (table) return jsonResult({ table, ...(await pgStore.getTableInfo(table)) });
      const tables = await pgStore.getTableList();
      if (verbose) {
        const detailed = [];
        for (const current of tables) detailed.push({ name: current.name, type: current.type, ...(await pgStore.getTableInfo(current.name)) });
        return jsonResult(detailed);
      }
      return jsonResult(tables);
    }
    if (table) return jsonResult({ table, ...dbStore.getTableInfo(table) });
    const tables = dbStore.getTableList();
    if (verbose) return jsonResult(tables.map(current => ({ name: current.name, type: current.type, ...dbStore.getTableInfo(current.name) })));
    return jsonResult(tables);
  } catch (e) { return errorResult(e); }
}

async function sidekick_db_query({ sql, params, readonly, limit, timeout, database }) {
  const denied = requireCanonicalInvocation("db_query");
  if (denied) return denied;
  try {
    const options = { readonly: readonly !== false, limit: limit || 1000, timeout: timeout || 5000 };
    const results = database === "postgres"
      ? await pgStore.executeQuery(sql, params || [], options)
      : dbStore.executeQuery(sql, params || [], options);
    return jsonResult(results);
  } catch (e) { return errorResult(e); }
}

async function sidekick_db_stats({ detailed, database }) {
  const authError = requireToolExecution({ tool: "db_stats", database: database || "sqlite" }, "database.inspect", "db_stats");
  if (authError) return authError;
  try {
    const stats = database === "postgres" ? await pgStore.getDatabaseStats() : dbStore.getDatabaseStats();
    if (!detailed) delete stats.tables;
    return jsonResult(stats);
  } catch (e) { return errorResult(e); }
}

async function sidekick_log_query({ tool, source, success, since, until, project, session_id, task_id, correlation_id, after_id, limit }) {
  const denied = requireCanonicalInvocation("log_query");
  if (denied) return denied;
  try {
    const entries = dbStore.queryToolLogs({ tool, source, success, since, until, project, session_id, task_id, correlation_id, after_id, limit: limit || 100 });
    if (after_id !== undefined || correlation_id) {
      return jsonResult({ entries, metadata: { correlation_id: correlation_id || null, after_id: after_id === undefined ? null : after_id, next_after_id: entries.length ? Math.max(...entries.map(entry => entry.id || 0)) : after_id || null, returned: entries.length, bounded: true } });
    }
    return jsonResult(entries);
  }
  catch (e) { return errorResult(e); }
}

async function sidekick_db_search({ query, tables, limit, database }) {
  const denied = requireCanonicalInvocation("db_search");
  if (denied) return denied;
  try {
      const options = { tables: tables ? tables.split(",").map(t => t.trim()) : null, limit: limit || 50 };
    const results = database === "postgres"
      ? await pgStore.searchAllTables(query, options)
      : (dbStore.setupFTS5(), dbStore.searchAllTables(query, options));
    return jsonResult(results);
  } catch (e) { return errorResult(e); }
}

async function sidekick_db_diff({ snapshot_a, snapshot_b, table }) {
  const denied = requireCanonicalInvocation("db_diff");
  if (denied) return denied;
  try {
    if (snapshot_a && snapshot_a !== "current") {
      const policyError = enforcePathPolicy(snapshot_a, "read");
      if (policyError) return policyError;
    }
    if (snapshot_b && snapshot_b !== "current") {
      const policyError = enforcePathPolicy(snapshot_b, "read");
      if (policyError) return policyError;
    }
    const loadSnapshot = value => {
      const snapshot = value === "current" || !value
        ? dbStore.createSnapshot(table ? { table } : undefined)
        : readSnapshot(value);
      if (!table) return snapshot;
      return { ...snapshot, tables: { [table]: snapshot.tables[table] || [] } };
    };
    const snapA = loadSnapshot(snapshot_a);
    const snapB = loadSnapshot(snapshot_b);
    const diff = dbStore.compareSnapshots(snapA, snapB);
    if (table) return jsonResult({ [table]: diff[table] || { added: [], removed: [] } });
    const summary = {};
    for (const [name, changes] of Object.entries(diff)) summary[name] = { added: changes.added.length, removed: changes.removed.length };
    return jsonResult({ summary, details: diff });
  } catch (e) { return errorResult(e); }
}

const descriptors = Object.freeze([
  Object.freeze({ name: "db_schema", description: "Inspect database schema: tables, columns, indexes, foreign keys", schema: z.object({ table: z.string().optional().describe("Specific table name (optional)"), verbose: z.boolean().optional().describe("Include row counts and detailed info"), database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend") }), args: { table: "string (optional, specific table name)", verbose: "boolean (optional, include row counts and detailed info)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }, risk: "medium", category: "Database", source: "builtin", family: "database-inspection", authorizationPermission: "database.inspect", handler: sidekick_db_schema }),
  Object.freeze({ name: "db_query", description: "Execute raw SQL queries with safety limits (readonly by default)", schema: z.object({ sql: z.string().describe("SQL query to execute"), params: z.array(z.any()).optional().describe("Query parameters"), readonly: z.boolean().optional().default(true).describe("Read-only mode (blocks writes)"), limit: z.number().optional().default(1000).describe("Maximum rows to return"), timeout: z.number().optional().default(5000).describe("Query timeout in milliseconds"), database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend") }), args: { sql: "string (SQL query)", params: "array (optional, query parameters)", readonly: "boolean (optional, default true - blocks writes)", limit: "number (optional, max rows - default 1000)", timeout: "number (optional, query timeout in ms - default 5000)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }, risk: "medium", category: "Database", source: "builtin", family: "database-inspection", handler: sidekick_db_query }),
  Object.freeze({ name: "db_stats", description: "Database statistics: size, table sizes, WAL status, cache hit ratio", schema: z.object({ detailed: z.boolean().optional().describe("Include per-table statistics"), database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend") }), args: { detailed: "boolean (optional, include per-table stats)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }, risk: "medium", category: "Database", source: "builtin", family: "database-inspection", authorizationPermission: "database.inspect", handler: sidekick_db_stats }),
  Object.freeze({ name: "log_query", description: "Advanced tool_logs filtering by time, tool, source, status and execution scope", schema: z.object({ tool: z.string().optional().describe("Filter by tool name"), source: z.string().optional().describe("Filter by source: mcp/agent/dashboard"), success: z.boolean().optional().describe("Filter by success status"), since: z.string().optional().describe("Start time (ISO or relative: 1h, 1d)"), until: z.string().optional().describe("End time (ISO timestamp)"), project: z.string().optional().describe("Filter by project"), session_id: z.string().optional().describe("Filter by session identifier"), task_id: z.string().optional().describe("Filter by task identifier"), correlation_id: z.string().optional().describe("Filter by correlation identifier"), after_id: z.number().int().min(0).optional().describe("Return only entries newer than this log id"), limit: z.number().int().min(1).max(1000).optional().default(100).describe("Maximum results") }), args: { tool: "string (optional, filter by tool name)", source: "string (optional, filter by source: mcp/agent/dashboard)", success: "boolean (optional, filter by success status)", since: "string (optional, ISO timestamp or relative: 1h, 1d)", until: "string (optional, ISO timestamp)", project: "string (optional, project scope)", session_id: "string (optional, session scope)", task_id: "string (optional, task scope)", correlation_id: "string (optional, correlation scope)", after_id: "number (optional, incremental cursor)", limit: "number (optional, max results - default 100)" }, risk: getStaticToolRisk("log_query"), category: "Database", source: "builtin", family: "database-inspection", handler: sidekick_log_query }),
  Object.freeze({ name: "db_search", description: "Full-text search across all tables", schema: z.object({ query: z.string().min(1).max(500).describe("Search terms (max 500 characters)"), tables: z.string().max(1000).optional().describe("Comma-separated table names (max 1,000 characters)"), limit: z.number().int().min(1).max(500).optional().default(50).describe("Maximum results (max 500)"), database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend") }), args: { query: "string (search terms, max 500 characters)", tables: "string (optional, comma-separated table names, max 1,000 characters)", limit: "integer (optional, 1-500 results - default 50)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }, risk: getStaticToolRisk("db_search"), category: "Database", source: "builtin", family: "database-inspection", handler: sidekick_db_search }),
  Object.freeze({ name: "db_diff", description: "Compare two database snapshots, show what changed", schema: z.object({ snapshot_a: z.string().optional().describe("Path to snapshot A or 'current'"), snapshot_b: z.string().optional().describe("Path to snapshot B or 'current'"), table: z.string().optional().describe("Specific table to compare") }), args: { snapshot_a: "string (optional, path to snapshot A or 'current')", snapshot_b: "string (optional, path to snapshot B or 'current')", table: "string (optional, specific table to compare)" }, risk: getStaticToolRisk("db_diff"), category: "Database", source: "builtin", family: "database-inspection", handler: sidekick_db_diff }),
]);

module.exports = { descriptors, sidekick_db_schema, sidekick_db_query, sidekick_db_stats, sidekick_log_query, sidekick_db_search, sidekick_db_diff, MAX_SNAPSHOT_BYTES };
