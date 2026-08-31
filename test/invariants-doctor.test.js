const assert = require("assert");
const { evaluateInvariants } = require("../src/invariants");
const { runDoctor, formatDoctorText, createSupportBundle } = require("../src/doctor");

function dbFixture({ orphan = 0, counts = {}, optionalTables = [] } = {}) {
  const query = sql => ({
    get: () => {
      if (sql.includes("platform_execution_events e LEFT JOIN")) return { count: orphan };
      if (sql.includes("agent_tasks t LEFT JOIN platform_executions")) return { count: counts.linkage || 0 };
      if (sql.includes("FROM platform_execution_claims c LEFT JOIN")) return { count: counts.claims || 0 };
      if (sql.includes("FROM agent_tasks WHERE state IN")) return { count: counts.activeStep || 0 };
      if (sql.includes("FROM (SELECT c.task_id FROM task_checkpoints")) return { count: counts.approval || 0 };
      if (sql.includes("GROUP BY task_id, action_fingerprint")) return { count: counts.fingerprints || 0 };
      if (sql.includes("dispatch_state IN ('finalized','verified','rolled_back','failed')")) return { count: counts.disposition || 0 };
      return sql.includes("SELECT 1") ? { ok: 1 } : { count: 0 };
    },
    all: () => [],
  });
  const db = { prepare: query };
  return {
    getDb: () => db,
    getTableList: () => [
      "platform_executions", "platform_execution_events", "platform_artifacts", "platform_modules",
      "agent_tasks", "agent_task_events", "agent_task_failures",
      ...optionalTables,
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
const optionalChecks = evaluateInvariants(baseOptions()).checks;
for (const id of ["platform.execution_claims", "approval.checkpoint_consistency", "agent.receipt_terminal_disposition"]) {
  const optional = optionalChecks.find(item => item.id === id);
  assert.strictEqual(optional.details.skipped, true);
}
const durableFailures = evaluateInvariants(baseOptions({
  db: dbFixture({
    optionalTables: ["platform_execution_claims", "task_checkpoints", "approvals", "agent_operation_receipts"],
    counts: { linkage: 1, claims: 1, activeStep: 1, approval: 1, disposition: 1, fingerprints: 1 },
  }),
}));
assert.strictEqual(durableFailures.ok, false);
for (const id of ["agent.execution_linkage", "platform.execution_claims", "agent.terminal_active_step", "approval.checkpoint_consistency", "agent.receipt_terminal_disposition", "agent.receipt_success_fingerprints"]) {
  assert.strictEqual(durableFailures.checks.find(item => item.id === id).ok, false, `${id}: ${JSON.stringify(durableFailures.checks.find(item => item.id === id))}`);
}
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
