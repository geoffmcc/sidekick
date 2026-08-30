"use strict";

const assert = require("assert");
const { listScenarios, runCertification, formatCertificationText, collectReliabilityMetrics } = require("../src/certification");

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
  assert.ok(report.summary.passed > 0);
  assert.ok(!JSON.stringify(report).includes("ghp_"));
  assert.match(formatCertificationText(report), /Agent certification 1: passed/);

  const hermetic = await runCertification({ mode: "hermetic" });
  assert.strictEqual(hermetic.summary.total, 18);
  assert.strictEqual(hermetic.summary.skipped, 0);
  assert.strictEqual(hermetic.summary.failed, 0);
  assert.strictEqual(collectReliabilityMetrics({ db: { getTableList: () => [], getDb: () => null } }).available, false);
  console.log("Certification tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
