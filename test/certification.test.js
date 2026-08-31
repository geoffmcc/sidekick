"use strict";

const assert = require("assert");
const { listScenarios, runCertification, formatCertificationText, collectReliabilityMetrics, createLiveAgentExecutor } = require("../src/certification");

(async () => {
  const all = listScenarios();
  assert.strictEqual(all.length, 20);
  assert.strictEqual(new Set(all.map(scenario => scenario.id)).size, 20);
  assert.ok(all.every(scenario => scenario.version === 1 && scenario.bounded && scenario.approval && scenario.evidence && scenario.outcome && scenario.cleanup));
  assert.strictEqual(listScenarios({ mode: "live" }).length, 2);

  const report = await runCertification();
  assert.strictEqual(report.schema, "sidekick.agent-certification.v1");
  assert.strictEqual(report.summary.total, 20);
  assert.strictEqual(report.summary.failed, 0);
  assert.strictEqual(report.summary.skipped, 2);
  assert.strictEqual(report.verdict, "blocked");
  assert.ok(report.summary.passed > 0);
  assert.ok(report.summary.blocked > 0);
  assert.ok(!JSON.stringify(report).includes("ghp_"));
  assert.match(formatCertificationText(report), /Agent certification 1: blocked/);

  const hermetic = await runCertification({ mode: "hermetic" });
  assert.strictEqual(hermetic.summary.total, 18);
  assert.strictEqual(hermetic.summary.skipped, 0);
  assert.strictEqual(hermetic.summary.failed, 0);
  assert.ok(hermetic.summary.blocked > 0);
  assert.strictEqual(hermetic.results.find(item => item.id === "agent-cert.v1.repository-path").status, "passed");
  assert.strictEqual(hermetic.results.find(item => item.id === "agent-cert.v1.result-vocabulary").status, "passed");

  const builtin = require("../src/tools").getBuiltinRegistry();
  const fabricatedRegistry = { get: name => name === "respond" ? builtin.get("respond") : {} };
  const fabricated = await runCertification({ mode: "hermetic", registry: fabricatedRegistry });
  assert.ok(fabricated.summary.blocked > 0, "fabricated descriptors must not certify required tools");

  const incomplete = await runCertification({
    scenarioIds: ["agent-cert.v1.repository-profile"],
    registry: { get: name => name === "respond" ? {} : null },
  });
  assert.strictEqual(incomplete.summary.failed, 0);
  assert.strictEqual(incomplete.summary.blocked, 1);
  assert.match(incomplete.results[0].reason, /expected tools unavailable/);

  const noFixture = await runCertification({ scenarioIds: ["agent-cert.v1.repository-profile"] });
  assert.strictEqual(noFixture.summary.blocked, 1);
  assert.match(noFixture.results[0].reason, /expected tools unavailable|deterministic hermetic fixture/);

  assert.throws(() => createLiveAgentExecutor({ baseUrl: "https://example.test" }), /loopback/);
  const live = await runCertification({
    mode: "live",
    availability: true,
    liveExecutor: { run: async scenario => ({ task_id: scenario.id, state: "failed", source: "durable_task_store", receipts: [{ capability: scenario.expected_tools[0] }], events: [{ tool_name: scenario.expected_tools[0] }], dispatch_counts: { total: 1 } }) },
  });
  assert.strictEqual(live.summary.total, 2);
  assert.strictEqual(live.summary.passed, 1);
  assert.strictEqual(live.summary.failed, 1);
  assert.strictEqual(collectReliabilityMetrics({ db: { getTableList: () => [], getDb: () => null } }).available, false);
  const metricRows = [
    { state: "completed", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z", completed_at: "2026-01-01T00:00:01Z", usage_json: "{}", result_json: JSON.stringify({ status: "verified" }), verification_json: JSON.stringify({ status: "verified" }) },
    { state: "completed", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:02Z", completed_at: "2026-01-01T00:00:02Z", usage_json: "{}", result_json: JSON.stringify({ status: "unable_to_verify" }), verification_json: JSON.stringify({ status: "unable_to_verify" }) },
    { state: "blocked", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:03Z", completed_at: null, usage_json: "{}", result_json: null, verification_json: null },
  ];
  const metrics = collectReliabilityMetrics({ db: { getTableList: () => [{ name: "agent_tasks" }], getDb: () => ({ prepare: () => ({ all: () => metricRows }) }) } });
  assert.strictEqual(metrics.completion.terminal, 3);
  assert.strictEqual(metrics.completion.verified, 1);
  assert.strictEqual(metrics.completion.blocked, 1);
  console.log("Certification tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
