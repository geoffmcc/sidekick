#!/usr/bin/env node
"use strict";

const jobId = process.argv[2];
if (!jobId || !/^[a-z0-9_-]{4,80}$/i.test(jobId)) {
  console.error("A valid cron job id is required");
  process.exit(2);
}

const { callTool } = require("../src/tools/dispatch-seam");
callTool("cron", { action: "run", id: jobId }, { source: "cron-runner", actor: "cron-runner" })
  .then(result => {
    if (result && result.isError) process.exitCode = 1;
  })
  .catch(error => {
    console.error(`Scheduled cron execution failed: ${error.message}`);
    process.exitCode = 1;
  });
