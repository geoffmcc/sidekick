"use strict";

// Runs async provider-backed jobs through the durable compute job ledger.
// Worker-backed jobs remain owned by the enrolled worker scheduler; this
// runner is only for jobs explicitly marked async and backed by a provider.

const inferenceService = require("./inference-service");
const jobManager = require("./job-manager");
const { redactSensitive } = require("../redact");

const POLL_INTERVAL_MS = 250;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.SIDEKICK_DIRECT_JOB_CONCURRENCY || 1));
const MAX_CONTINUATIONS = 3;
let timer = null;
let inFlight = 0;

function isDirectInferenceJob(job) {
  return (job.jobType === "chat" || job.jobType === "generate") &&
    job.requestPayload && job.requestPayload.async === true;
}

async function execute(claimed) {
  const { job, leaseId } = claimed;
  const payload = { ...(job.requestPayload || {}) };
  delete payload.async;

  try {
    let result;
    if (job.jobType === "chat") {
      result = await runChatToCompletion(job, payload);
    } else {
      result = await inferenceService.generate(payload.prompt, {
        system: payload.system,
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        contextLimit: payload.contextLimit,
        timeout: job.timeoutMs,
        dataClassification: job.dataClassification,
        preferences: { allowFallback: true },
      });
    }
    jobManager.completeDirectJob(job.jobId, leaseId, { result });
  } catch (error) {
    try {
      jobManager.failDirectJob(job.jobId, leaseId, {
        errorCategory: error.code || "provider_error",
        errorMessage: error.message || "Provider execution failed",
      });
    } catch (completionError) {
      console.error(`[compute] failed to finalize direct job ${job.jobId}: ${redactSensitive(completionError.message)}`);
    }
  } finally {
    inFlight -= 1;
  }
}

async function runChatToCompletion(job, payload) {
  const originalMessages = payload.messages || [{ role: "user", content: payload.prompt }];
  const messages = [...originalMessages];
  const parts = [];
  let result;
  let continuationCount = 0;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    result = await inferenceService.chat({
      messages,
      system: payload.system,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      contextLimit: payload.contextLimit,
      timeout: job.timeoutMs,
      dataClassification: job.dataClassification,
      preferences: { allowFallback: true },
    });
    if (result.content) parts.push(result.content);
    if (result.finishReason !== "length" || attempt === MAX_CONTINUATIONS) break;

    continuationCount += 1;
    messages.push(
      { role: "assistant", content: result.content || "" },
      { role: "user", content: "Continue exactly where you stopped. Do not repeat earlier content. Finish the answer completely, including any unfinished code block or section." },
    );
  }

  return {
    ...result,
    content: parts.join("\n\n"),
    continuationCount,
    complete: result.finishReason !== "length",
  };
}

function runOnce() {
  if (inFlight >= MAX_CONCURRENCY) return;
  const jobs = jobManager.listJobs({ status: "queued", limit: 50 })
    .filter(isDirectInferenceJob);
  for (const job of jobs) {
    if (inFlight >= MAX_CONCURRENCY) break;
    const claimed = jobManager.claimDirectJob(job.jobId, {
      leaseDurationMs: Math.max((job.timeoutMs || 86400000) + 60000, 900000),
    });
    if (!claimed) continue;
    inFlight += 1;
    void execute(claimed);
  }
}

function start() {
  if (timer) return;
  runOnce();
  timer = setInterval(runOnce, POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, runOnce };
