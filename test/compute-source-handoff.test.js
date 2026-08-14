"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "test-data-source-handoff");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_TOOL_POLICY = "open";

const dbStore = require("../src/db");
const jobs = require("../src/compute/job-manager");

jobs.ensureSchema();
const source = jobs.createJob({
  jobType: "chat", capability: "chat", project: "pipeline-test",
  requestPayload: { prompt: "draft" }, dataClassification: "private", maxAttempts: 1,
});
const sourceContent = "x".repeat(18000);
dbStore.getDb().prepare("UPDATE compute_jobs SET status = 'completed', result_json = ?, completed_at = ? WHERE job_id = ?")
  .run(JSON.stringify({ content: sourceContent }), new Date().toISOString(), source.jobId);

const followup = jobs.createJob({
  jobType: "chat", capability: "chat", project: "pipeline-test",
  requestPayload: { prompt: "Review this draft", sourceJobId: source.jobId },
  dataClassification: "private", maxAttempts: 1,
});
const materialized = jobs.materializeSourceJob(followup);
assert.ok(materialized.requestPayload.prompt.includes(sourceContent), "full source result should be handed off");
assert.ok(materialized.requestPayload.prompt.length > 18000, "handoff must not truncate the source result");

assert.throws(() => jobs.createJob({
  jobType: "chat", capability: "chat", project: "other-project",
  requestPayload: { prompt: "Review", sourceJobId: source.jobId }, dataClassification: "private",
}), error => error.code === "SOURCE_PROJECT_MISMATCH");

console.log("Source handoff tests passed (3 assertions)");
try { dbStore.getDb().close(); } catch {}
fs.rmSync(dataDir, { recursive: true, force: true });
