const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../src/tools/families/scheduling.js"), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "../scripts/run-cron-job.js"), "utf8");

assert.ok(source.includes("run-cron-job.js"), "system cron must invoke the fixed Sidekick runner");
assert.ok(!source.includes("${j.command}"), "caller command must never be written into crontab");
assert.ok(source.includes("isSafeCronSchedule"), "cron schedules must be structurally validated");
assert.ok(runner.includes('callTool("cron"'), "the cron runner must use canonical dispatch");

console.log("Cron safety tests passed");
