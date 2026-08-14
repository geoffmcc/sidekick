"use strict";

// Focused contract test for long-running LLM calls. The test stops the runner
// so it verifies persistence and identity at the tool boundary without
// requiring a live provider or turning CI into an infrastructure test.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "test-data-llm-async");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const compute = require("../src/compute");
const { callMcpTool } = require("../src/tools");

async function main() {
  compute.initialize();
  compute.stopReconciliation();

  const response = await callMcpTool("sidekick_llm", {
    prompt: "Explain how a durable job differs from a synchronous request.",
    temperature: 0.2,
    async: true,
    timeout_ms: 120000,
  }, {
    project: "async-llm-test",
    actor: "focused-test",
    task_id: "task-async-llm",
  });

  assert.ok(!response.isError, response.content?.[0]?.text);
  const receipt = JSON.parse(response.content[0].text);
  assert.strictEqual(receipt.async, true);
  assert.strictEqual(receipt.status, "queued");
  assert.ok(receipt.job_id);
  assert.strictEqual(receipt.poll.tool, "compute_jobs");

  const job = compute.jobManager.getJob(receipt.job_id);
  assert.strictEqual(job.jobType, "chat");
  assert.strictEqual(job.project, "async-llm-test");
  assert.strictEqual(job.requestingActor, "focused-test");
  assert.strictEqual(job.requestPayload.async, true);
  assert.strictEqual(job.timeoutMs, 120000);

  console.log("✓ async LLM request persists a project-scoped durable compute job");
  try { require("../src/db").getDb().close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
