const assert = require("assert");
const { evaluateInvariants } = require("../src/invariants");
const { runDoctor, formatDoctorText, createSupportBundle } = require("../src/doctor");

function dbFixture({ orphan = 0 } = {}) {
  const query = sql => ({
    get: () => sql.includes("orphan") ? { count: orphan } : (sql.includes("SELECT 1") ? { ok: 1 } : { count: 0 }),
    all: () => [],
  });
  const db = { prepare: query };
  return {
    getDb: () => db,
    getTableList: () => [
      "platform_executions", "platform_execution_events", "platform_artifacts", "platform_modules",
      "agent_tasks", "agent_task_events", "agent_task_failures",
    ].map(name => ({ name })),
    listMigrations: () => [{ version: 1 }],
    getMigrationVersion: () => 1,
  };
}

function toolsFixture(fails) {
  return { getBuiltinRegistry: () => {
    if (fails) throw new Error("duplicate descriptor: token=" + ["ghp_", "123456789012345678901234567890123456"].join(""));
    return { list: () => [{ name: "status", aliases: [], handler: () => {}, schema: { safeParse: () => ({ success: true }) }, risk: "low", category: "Observability", annotations: { readOnlyHint: true, destructiveHint: false } }] };
  } };
}

function baseOptions(overrides = {}) {
  return {
    db: dbFixture(),
    tools: toolsFixture(false),
    modules: { listModules: () => [] },
    loader: { isModuleActive: () => false },
    ...overrides,
  };
}

assert.strictEqual(evaluateInvariants(baseOptions()).ok, true);
const failedRegistry = evaluateInvariants(baseOptions({ tools: toolsFixture(true) }));
assert.strictEqual(failedRegistry.ok, false);
assert.strictEqual(failedRegistry.severity, "critical");
assert.ok(!JSON.stringify(failedRegistry).includes("ghp_"));

const doctor = runDoctor({ ...baseOptions(), paths: { db: "/safe/db", data: "/safe/data", backups: "/safe/backups" }, pathPolicy: () => ({ allowed: true, reason: "open" }) });
assert.strictEqual(doctor.ok, true);
assert.ok(!JSON.stringify(doctor).includes("ghp_"));
assert.match(formatDoctorText(doctor), /Sidekick Doctor: OK/);
assert.strictEqual(createSupportBundle({ report: doctor }).doctor.ok, true);

console.log("Passed: invariant evaluator and Doctor diagnostics");
