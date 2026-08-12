"use strict";

// Database administration tool family: backup, restore, export, and migrate.
//
// The mutation/administration counterpart to the read-only database-inspection
// family. Extracted from src/tools-legacy.js; these handlers depend only on the
// database stores, the shared filesystem path policy, and Node builtins — never
// on tools-legacy.js — so the family carries no legacy import at module load.
// Risk classifications (db_restore critical, db_migrate high, db_backup/db_export
// medium) are preserved from src/tools/metadata.js; policy, approval, redaction
// and audit are applied by the dispatcher.

const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const dbStore = require("../../db");
const pgStore = require("../../pg");
const { enforcePathPolicy } = require("../path-policy");

async function sidekick_db_backup({ path: destPath, compress }) {
  try {
    if (destPath) {
      const policyError = enforcePathPolicy(destPath, "write");
      if (policyError) return policyError;
    }
    const result = dbStore.createBackup(destPath, compress !== false);
    return { content: [{ type: "text", text: `Backup created: ${result.path} (${result.size} bytes, compressed: ${result.compressed})` }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_restore({ path: backupPath, verify }) {
  try {
    const policyError = enforcePathPolicy(backupPath, "read");
    if (policyError) return policyError;
    const result = dbStore.restoreBackup(backupPath, verify !== false);
    return { content: [{ type: "text", text: `Restored from: ${backupPath}\nPre-restore backup: ${result.preBackupPath}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_export({ table, format, path: outputPath, database }) {
  try {
    const fmt = format || "json";
    if (outputPath) {
      const policyError = enforcePathPolicy(outputPath, "write");
      if (policyError) return policyError;
    }
    if (database === "postgres") {
      if (table) {
        const data = await pgStore.exportTable(table, fmt);
        if (outputPath) {
          fs.writeFileSync(outputPath, data);
          return { content: [{ type: "text", text: `Exported ${table} to ${outputPath}` }] };
        }
        return { content: [{ type: "text", text: data }] };
      }
      const tables = await pgStore.getTableList();
      const allData = {};
      for (const t of tables) {
        allData[t.name] = JSON.parse(await pgStore.exportTable(t.name, "json"));
      }
      const output = JSON.stringify(allData, null, 2);
      if (outputPath) {
        fs.writeFileSync(outputPath, output);
        return { content: [{ type: "text", text: `Exported all tables to ${outputPath}` }] };
      }
      return { content: [{ type: "text", text: output }] };
    }
    if (table) {
      const data = dbStore.exportTable(table, fmt);
      if (outputPath) {
        fs.writeFileSync(outputPath, data);
        return { content: [{ type: "text", text: `Exported ${table} to ${outputPath}` }] };
      }
      return { content: [{ type: "text", text: data }] };
    }
    const tables = dbStore.getTableList().filter(t => t.type === "table");
    const allData = {};
    for (const t of tables) {
      allData[t.name] = JSON.parse(dbStore.exportTable(t.name, "json"));
    }
    const output = JSON.stringify(allData, null, 2);
    if (outputPath) {
      fs.writeFileSync(outputPath, output);
      return { content: [{ type: "text", text: `Exported all tables to ${outputPath}` }] };
    }
    return { content: [{ type: "text", text: output }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_db_migrate({ action, version, name }) {
  try {
    if (action === "status") {
      const current = dbStore.getMigrationVersion();
      const migrations = dbStore.listMigrations();
      return { content: [{ type: "text", text: JSON.stringify({ currentVersion: current, migrations }, null, 2) }] };
    }
    if (action === "list") {
      const migrations = dbStore.listMigrations();
      return { content: [{ type: "text", text: JSON.stringify(migrations, null, 2) }] };
    }
    if (action === "up") {
      if (!name) {
        return { content: [{ type: "text", text: "name required for up migration" }], isError: true };
      }
      if (!/^\d{3}_[A-Za-z0-9_]+\.sql$/.test(name)) {
        return { content: [{ type: "text", text: "Invalid migration name; expected NNN_name.sql" }], isError: true };
      }
      const migrationPath = path.join(dbStore.MIGRATIONS_DIR, name);
      if (!fs.existsSync(migrationPath)) {
        return { content: [{ type: "text", text: `Migration not found: ${name}` }], isError: true };
      }
      const sql = fs.readFileSync(migrationPath, "utf-8");
      const result = dbStore.runMigration(name, sql, "");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    return { content: [{ type: "text", text: "Unknown action. Use: status, list, up" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "db_backup",
    description: "Create timestamped database backup with optional compression",
    schema: z.object({
      path: z.string().optional().describe("Output path (default: data/backups/)"),
      compress: z.boolean().optional().default(true).describe("Gzip compression"),
    }),
    args: { path: "string (optional, output path - default data/backups/)", compress: "boolean (optional, gzip compression - default true)" },
    risk: "medium",
    category: "Database",
    source: "builtin",
    family: "database-admin",
    handler: sidekick_db_backup,
  }),
  Object.freeze({
    name: "db_restore",
    description: "Restore database from backup with integrity verification",
    schema: z.object({
      path: z.string().describe("Backup file path"),
      verify: z.boolean().optional().default(true).describe("Check integrity before restore"),
    }),
    args: { path: "string (backup file path)", verify: "boolean (optional, check integrity before restore - default true)" },
    risk: "critical",
    category: "Database",
    source: "builtin",
    family: "database-admin",
    handler: sidekick_db_restore,
  }),
  Object.freeze({
    name: "db_export",
    description: "Export tables to JSON, CSV, or SQL format",
    schema: z.object({
      table: z.string().optional().describe("Specific table (exports all if omitted)"),
      format: z.enum(["json", "csv", "sql"]).optional().default("json").describe("Export format"),
      path: z.string().optional().describe("Output file path"),
      database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend"),
    }),
    args: { table: "string (optional, specific table - exports all if omitted)", format: "string (optional, json|csv|sql - default json)", path: "string (optional, output file path)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" },
    risk: "medium",
    category: "Database",
    source: "builtin",
    family: "database-admin",
    handler: sidekick_db_export,
  }),
  Object.freeze({
    name: "db_migrate",
    description: "Schema migrations with versioning and rollback",
    schema: z.object({
      action: z.enum(["status", "list", "up"]).describe("Migration action"),
      version: z.number().optional().describe("Target version"),
      name: z.string().optional().describe("Migration filename (for up action)"),
    }),
    args: { action: "string (status|list|up)", version: "number (optional, target version)", name: "string (optional, migration filename for up action)" },
    risk: "high",
    category: "Database",
    source: "builtin",
    family: "database-admin",
    handler: sidekick_db_migrate,
  }),
]);

module.exports = { descriptors, sidekick_db_backup, sidekick_db_restore, sidekick_db_export, sidekick_db_migrate };
