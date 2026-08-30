"use strict";

const dbDefault = require("./db");
const toolsDefault = require("./tools");
const loaderDefault = require("./modules/loader");
const { redactSensitive } = require("./redact");

const SEVERITY_ORDER = Object.freeze({ ok: 0, info: 1, warning: 2, error: 3, critical: 4 });
const MAX_ROWS = 100;
const REQUIRED_DURABLE_TABLES = Object.freeze([
  "platform_executions", "platform_execution_events", "platform_artifacts",
  "platform_modules", "agent_tasks", "agent_task_events", "agent_task_failures",
]);
const TERMINAL_TASK_STATES = new Set(["completed", "partial", "failed", "cancelled", "timed_out"]);
const VALID_RISKS = new Set(["low", "medium", "high", "critical"]);

function check(id, ok, severity, message, details = {}) {
  return { id, ok: Boolean(ok), severity: ok ? "ok" : severity, message, details };
}

function bounded(value, fallback = MAX_ROWS) {
  return Math.max(1, Math.min(Number(value) || fallback, MAX_ROWS));
}

function safeCall(fn, fallback) {
  try { return fn(); } catch (error) {
    return { error: redactSensitive(String(error && error.message || error)).slice(0, 300), fallback };
  }
}

function tableNames(dbStore) {
  const tables = dbStore.getTableList();
  return new Set((tables || []).map(table => table.name));
}

function evaluateInvariants(options = {}) {
  const dbStore = options.db || dbDefault;
  const tools = options.tools || toolsDefault;
  const modules = options.modules || null;
  const loader = options.loader || loaderDefault;
  const limit = bounded(options.limit);
  const checks = [];

  const readable = safeCall(() => dbStore.getDb().prepare("SELECT 1 AS ok").get(), null);
  checks.push(readable && readable.ok === 1
    ? check("database.readable", true, "critical", "Database is readable")
    : check("database.readable", false, "critical", "Database is not readable", { error: readable.error || "read failed" }));

  let names = new Set();
  const schema = safeCall(() => {
    names = tableNames(dbStore);
    const migrations = dbStore.listMigrations();
    const version = Number(dbStore.getMigrationVersion());
    const highest = migrations.length ? migrations[migrations.length - 1].version : 0;
    return { version, highest, migrations: migrations.length };
  }, null);
  if (schema.error) {
    checks.push(check("schema.migrations", false, "critical", "Migration metadata could not be read", { error: schema.error }));
  } else {
    checks.push(check("schema.migrations", schema.version === schema.highest,
      "critical", schema.version === schema.highest ? "Migrations are applied" : "Database migrations are incomplete",
      { version: schema.version, highest: schema.highest, count: schema.migrations }));
  }

  try {
    const registry = tools.getBuiltinRegistry();
    const descriptors = registry.list();
    const namesSeen = new Set();
    const violations = [];
    for (const descriptor of descriptors) {
      const name = String(descriptor.name || "").replace(/^sidekick_/, "");
      if (!/^[a-z][a-z0-9_]*$/.test(name) || namesSeen.has(name)) violations.push(`${name || "<missing>"}: duplicate or invalid name`);
      namesSeen.add(name);
      if (typeof descriptor.handler !== "function") violations.push(`${name}: missing handler`);
      if (!descriptor.schema || typeof descriptor.schema.safeParse !== "function") violations.push(`${name}: missing executable schema`);
      if (!VALID_RISKS.has(descriptor.risk)) violations.push(`${name}: invalid risk`);
      if (!String(descriptor.category || "").trim()) violations.push(`${name}: missing category`);
      if (!descriptor.annotations || typeof descriptor.annotations.readOnlyHint !== "boolean" || typeof descriptor.annotations.destructiveHint !== "boolean") violations.push(`${name}: incomplete annotations`);
      if (descriptor.annotations?.readOnlyHint === true && descriptor.annotations?.destructiveHint === true) violations.push(`${name}: contradictory annotations`);
      for (const alias of descriptor.aliases || []) {
        const canonical = String(alias).replace(/^sidekick_/, "");
        if (!/^[a-z][a-z0-9_]*$/.test(canonical) || namesSeen.has(canonical)) violations.push(`${name}: duplicate or invalid alias`);
        namesSeen.add(canonical);
      }
    }
    checks.push(check("registry.integrity", violations.length === 0, "critical",
      violations.length ? "Canonical registry contract is invalid" : "Canonical registry is coherent",
      { descriptors: Math.min(descriptors.length, limit), violations: violations.slice(0, limit) }));
  } catch (error) {
    // A registry that cannot be assembled must never be reported as healthy.
    checks.push(check("registry.integrity", false, "critical", "Canonical registry failed closed", { error: redactSensitive(String(error.message || error)).slice(0, 300) }));
  }

  const missing = REQUIRED_DURABLE_TABLES.filter(name => !names.has(name));
  checks.push(check("durability.tables", missing.length === 0, "critical",
    missing.length ? "Required durable tables are missing" : "Required durable tables exist", { missing }));

  if (names.has("platform_executions") && names.has("platform_execution_events")) {
    const db = dbStore.getDb();
    const orphanEvents = safeCall(() => db.prepare("SELECT COUNT(*) AS count FROM platform_execution_events e LEFT JOIN platform_executions x ON x.execution_id = e.execution_id WHERE x.execution_id IS NULL").get().count, null);
    checks.push(check("platform.event_ownership", !orphanEvents.error && Number(orphanEvents) === 0, "error",
      Number(orphanEvents) === 0 ? "Platform events have execution owners" : "Platform events have missing execution owners",
      { orphan_count: orphanEvents.error ? null : Number(orphanEvents) }));
  }

  if (names.has("agent_tasks")) {
    const db = dbStore.getDb();
    const orphanTasks = names.has("agent_task_events")
      ? safeCall(() => db.prepare("SELECT COUNT(*) AS count FROM agent_task_events e LEFT JOIN agent_tasks t ON t.task_id = e.task_id WHERE t.task_id IS NULL").get().count, null)
      : { error: "event table missing" };
    checks.push(check("agent.event_ownership", !orphanTasks.error && Number(orphanTasks) === 0, "error",
      Number(orphanTasks) === 0 ? "Agent events have task owners" : "Agent events have missing task owners",
       { orphan_count: orphanTasks.error ? null : Number(orphanTasks) }));
    const taskState = safeCall(() => db.prepare("SELECT task_id,state,control_json,continuation_json,verification_json,result_json,parent_task_id,root_task_id FROM agent_tasks ORDER BY updated_at DESC LIMIT ?").all(limit), []);
    const taskViolations = [];
    for (const task of taskState) {
      let control = {}, continuation = {}, verification = null, result = null;
      try { control = JSON.parse(task.control_json || "{}"); } catch { taskViolations.push(`${task.task_id}: corrupt control`); }
      try { continuation = JSON.parse(task.continuation_json || "{}"); } catch { taskViolations.push(`${task.task_id}: corrupt continuation`); }
      try { verification = task.verification_json ? JSON.parse(task.verification_json) : null; } catch { taskViolations.push(`${task.task_id}: corrupt verification`); }
      try { result = task.result_json ? JSON.parse(task.result_json) : null; } catch { taskViolations.push(`${task.task_id}: corrupt result`); }
      if (TERMINAL_TASK_STATES.has(task.state) && (control.pause_requested || control.cancel_requested) === false && continuation.ambiguous_operations?.length) taskViolations.push(`${task.task_id}: terminal task retains ambiguous operation`);
      if (task.state === "completed" && result && result.status !== "verified") taskViolations.push(`${task.task_id}: completed without verified result`);
      if (task.state === "cancelled" && result?.status === "verified") taskViolations.push(`${task.task_id}: cancelled task has verified result`);
      if (task.parent_task_id && task.root_task_id === task.task_id) taskViolations.push(`${task.task_id}: child is its own root`);
      if (verification && verification.status === "verified" && result && result.status && result.status !== "verified") taskViolations.push(`${task.task_id}: verification/result mismatch`);
    }
    checks.push(check("agent.task_lifecycle", taskViolations.length === 0, "error", taskViolations.length ? "Agent task lifecycle invariant failed" : "Agent task lifecycle is consistent", { violations: taskViolations.slice(0, limit), inspected: taskState.length }));
  }

  if (names.has("agent_operation_receipts") && names.has("agent_tasks")) {
    const receiptViolations = safeCall(() => dbStore.getDb().prepare("SELECT r.receipt_id,r.task_id,r.effect_class,r.dispatch_state,t.task_id AS owner FROM agent_operation_receipts r LEFT JOIN agent_tasks t ON t.task_id=r.task_id WHERE t.task_id IS NULL OR (r.effect_class <> 'read_only' AND r.dispatch_state IN ('finalized','verified') AND r.verification_recipe_ref IS NULL) LIMIT ?").all(limit), []);
    checks.push(check("agent.receipts", !receiptViolations.error && receiptViolations.length === 0, "error", receiptViolations.length ? "Receipt ownership or verification invariant failed" : "Operation receipts are owned and gated", { violations: receiptViolations.error ? [receiptViolations.error] : receiptViolations }));
  }

  const moduleState = safeCall(() => {
    const records = modules
      ? modules.listModules().slice(0, limit)
      : (names.has("platform_modules")
        ? dbStore.getDb().prepare("SELECT name, state FROM platform_modules ORDER BY registered_at DESC LIMIT ?").all(limit)
        : []);
    const invalid = records.filter(record => !["validated", "installed", "configured", "enabled", "healthy", "disabled", "error", "uninstalling", "uninstalled"].includes(record.state));
    const inactive = records.filter(record => ["enabled", "healthy"].includes(record.state) && !loader.isModuleActive(record.name));
    return { records: records.length, invalid: invalid.map(record => record.name), inactive: inactive.map(record => record.name) };
  }, null);
  checks.push(moduleState.error
    ? check("capability.lifecycle", false, "error", "Capability lifecycle state could not be read", { error: moduleState.error })
    : {
      id: "capability.lifecycle",
      ok: moduleState.invalid.length === 0,
      severity: moduleState.invalid.length ? "error" : (moduleState.inactive.length ? "warning" : "ok"),
      message: moduleState.invalid.length ? "Capability lifecycle contains invalid states" : (moduleState.inactive.length ? "Enabled capabilities are inactive in this process" : "Capability lifecycle states are valid"),
      details: { records: moduleState.records, invalid: moduleState.invalid, inactive: moduleState.inactive },
    });

  const foreignKeys = safeCall(() => dbStore.getDb().prepare("PRAGMA foreign_key_check").all().slice(0, limit), null);
  checks.push(foreignKeys.error
    ? check("database.foreign_keys", false, "error", "Foreign-key integrity could not be checked", { error: foreignKeys.error })
    : check("database.foreign_keys", foreignKeys.length === 0, "error",
      foreignKeys.length ? "Database has foreign-key violations" : "Database foreign keys are consistent",
      { violations: foreignKeys.length }));

  const failed = checks.filter(item => !item.ok);
  const severity = checks.reduce((worst, item) => SEVERITY_ORDER[item.severity] > SEVERITY_ORDER[worst] ? item.severity : worst, "ok");
  return {
    ok: failed.length === 0,
    severity,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  };
}

module.exports = { evaluateInvariants, SEVERITY_ORDER };
