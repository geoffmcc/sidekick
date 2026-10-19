"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");

const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = message => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, code: "invalid_input", error: message }, null, 2) }], isError: true });

async function dispatch(services, name, args) {
  const value = await services.dispatch(name, args);
  const payload = decodePayload(value);
  const state = String(value?.state || value?.status || payload?.state || payload?.status || "").toLowerCase();
  if (value?.isError || value?.ok === false || payload?.ok === false || ["unavailable", "error", "failed"].includes(state)) {
    const error = new Error(`${name} dependency failed`);
    error.code = value?.code || payload?.code || "dependency_failed";
    throw error;
  }
  return value;
}
function decodePayload(value) {
  const raw = value?.content?.map(item => item.text || "").join("\n").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function text(value) { return value?.content?.map(item => item.text || "").join("\n") || ""; }
function decode(value, name) {
  const raw = text(value).trim();
  if (!raw) throw new Error(`${name} returned an empty response`);
  try { return JSON.parse(raw); } catch { throw new Error(`${name} returned invalid JSON`); }
}
function readOnlySql(sql) {
  const normalized = String(sql).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
  if (!/^(select|with)\b/i.test(normalized) || /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|pragma|vacuum|reindex)\b/i.test(normalized)) return false;
  return normalized.split(";").filter(Boolean).length === 1;
}

async function admin(services, args) {
  const database = args.database || services.config?.default_database || "sqlite";
  if (args.action === "query") {
    if (args.readonly === false) return failure("database_admin never permits write queries");
    if (!Array.isArray(args.params)) return failure("query requires a params array; interpolate no values into SQL");
    if (typeof args.sql !== "string" || !readOnlySql(args.sql)) return failure("query must be a single read-only SELECT or WITH statement");
    if (!/\?|\$\d+/.test(args.sql)) return failure("query must contain parameter placeholders (? or $n)");
    return result({ ok: true, action: args.action, database, result: decode(await dispatch(services, "db_query", { sql: args.sql, params: args.params, readonly: true, limit: args.limit || services.config?.max_rows || 100, timeout: args.timeout || 5000, database }), "db_query") });
  }
  const calls = args.action === "schema"
    ? [["db_schema", { table: args.table, verbose: args.verbose === true, database }]]
    : args.action === "migrations"
      ? [["db_migrate", { action: "status" }]]
      : [["db_schema", { verbose: false, database }], ["db_stats", { detailed: args.detailed === true, database }], ["db_migrate", { action: "status" }]];
  const values = {};
  for (const [name, payload] of calls) values[name] = decode(await dispatch(services, name, payload), name);
  const evidenceValues = Object.values(values);
  const partial = evidenceValues.some(value => value?.ok === false || ["unavailable", "error", "failed"].includes(String(value?.state || value?.status || "").toLowerCase()));
  return result({ ok: !partial, state: partial ? "partial" : "observed", action: args.action, database, evidence: values, mutations_performed: [] });
}
async function health(services) {
  const checks = {};
  for (const [name, payload] of [["db_schema", { database: services.config?.default_database || "sqlite" }], ["db_stats", { database: services.config?.default_database || "sqlite" }], ["db_migrate", { action: "status" }]]) {
    try { checks[name] = { ok: true, response: decode(await dispatch(services, name, payload), name) }; } catch (error) { checks[name] = { ok: false, error: error.message }; }
  }
  return result({ ok: Object.values(checks).every(check => check.ok), tool: "database_health", checks, read_only: true });
}
async function migrationReview(services, args) {
  const database = args.database || services.config?.default_database || "sqlite";
  const evidence = {};
  const failures = [];
  for (const [name, payload] of [["db_migrate", { action: "status" }], ["db_schema", { database, verbose: args.verbose === true }]]) {
    try { evidence[name] = decode(await dispatch(services, name, payload), name); }
    catch (error) { failures.push(name); evidence[name] = { ok: false, code: error.code || "dependency_failed", error: String(error.message || error).slice(0, 300) }; }
  }
  return result({ ok: failures.length === 0, action: "migration_review", database, evidence, readiness: failures.length === 0 ? "evidence_collected" : "incomplete", mutations_performed: [], not_performed: ["migration apply", "rollback", "restore"], provenance: { dependencies: ["db_migrate", "db_schema"] } });
}
const entry = {
  buildDescriptors(services) { return [
    { name: "database_admin", description: "Inspect database schema, statistics and migration readiness, or execute a strictly parameterized read-only query. Query execution remains read-only at the underlying database tool; this pack's SQL screening is an additional guard, not a SQL parser.", schema: z.object({ action: z.enum(["audit", "schema", "migrations", "query"]).describe("Read-only database operation."), database: z.enum(["sqlite", "postgres"]).optional().describe("Configured database backend; defaults to the administrator setting."), table: z.string().max(128).optional().describe("Exact table name for schema inspection."), verbose: z.boolean().optional().describe("Include expanded schema details."), detailed: z.boolean().optional().describe("Request detailed database statistics."), sql: z.string().max(4000).optional().describe("Single parameterized SELECT or WITH query; values belong in params."), params: z.array(z.any()).max(100).optional().describe("Bound values for SQL placeholders; required for query."), readonly: z.boolean().optional().describe("Must not be false; execution is always requested in read-only mode."), limit: z.number().int().min(1).max(1000).optional().describe("Maximum rows returned; bounded to 1000."), timeout: z.number().int().min(100).max(30000).optional().describe("Query timeout in milliseconds, bounded to 30 seconds.") }).strict(), args: { action: "string (audit|schema|migrations|query; all actions are read-only)", database: "string (configured backend; omit for default)", table: "string (exact table for schema inspection)", sql: "string (parameterized SELECT; screened here and enforced read-only by db_query)", params: "array (bound query values; required for query)" }, risk: "medium", category: "Database", handler: args => admin(services, args) },
     { name: "database_health", description: "Run bounded, read-only dependency probes for schema, database statistics and migration status.", schema: z.object({}), args: {}, risk: "low", category: "Database", annotations: { readOnlyHint: true, idempotentHint: true }, handler: () => health(services) },
     { name: "database_migration_review", description: "Collect migration status and current schema evidence as a read-only readiness review; applying or rolling back migrations is never performed.", schema: z.object({ database: z.enum(["sqlite", "postgres"]).optional(), verbose: z.boolean().optional() }).strict(), args: { database: "string", verbose: "boolean" }, risk: "medium", category: "Database", annotations: { readOnlyHint: true, idempotentHint: true }, handler: args => migrationReview(services, args) },
  ]; },
  healthCheck({ config }) { const database = config?.default_database || "sqlite"; return { ok: ["sqlite", "postgres"].includes(database), details: { database, dependencies: ["db_schema", "db_stats", "db_query", "db_migrate"], policy: "query writes disabled; runtime probes available through database_health" } }; },
};
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
