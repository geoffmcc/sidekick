#!/usr/bin/env node
"use strict";

const jobId = process.argv[2];
if (!jobId || !/^[a-z0-9_-]{4,80}$/i.test(jobId)) {
  console.error("A valid cron job id is required");
  process.exit(2);
}

const dbStore = require("../src/db");
const { readSecret } = require("../src/core/runtime-secrets");
const { verifyScheduledCronAuthority } = require("../src/security/scheduled-authority");
const { restoreScheduledContext } = require("../src/agent/delay-policy");
const { callInternalTool } = require("../src/tools/dispatcher");

const job = dbStore.loadDocument("cron", []).find(item => item.id === jobId);
let scheduledContext = null;
try {
  const signedContext = job && verifyScheduledCronAuthority({
    job,
    secret: readSecret("SIDEKICK_SECRET_KEY", { required: true }),
  });
  scheduledContext = signedContext && restoreScheduledContext(signedContext);
} catch {}

if (!job || !scheduledContext?.authIdentity?.principal_id) {
  console.error("Cron job has no valid current execution authority; authorize it from an authenticated Sidekick session");
  process.exit(1);
}

callInternalTool("cron", { action: "run", id: jobId }, {
  ...scheduledContext,
  // Preserve the creator's configured source policy while identifying the
  // OS scheduler separately as the actor. The signed context binds source.
  source: scheduledContext.source || "mcp",
  actor: "cron-runner",
  correlationId: `cron:${jobId}`,
})
  .then(result => {
    if (result && result.isError) process.exitCode = 1;
  })
  .catch(error => {
    console.error(`Scheduled cron execution failed: ${error.message}`);
    process.exitCode = 1;
  });
