#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const requested = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const candidates = requested.length ? requested : [
  "test/run-all.test.js", "test/pack-maturity.test.js", "test/dashboard-api.test.js",
  "test/agent-cancel.test.js", "test/compute-cancellation.test.js", "test/browser-egress.test.js",
];
const suites = candidates.filter(file => fs.existsSync(path.join(root, file)));
const repetitions = Math.max(2, Math.min(10, Number(process.env.SIDEKICK_FLAKE_RUNS || 3)));
const results = [];
for (let run = 1; run <= repetitions; run++) {
  const seed = 700000 + run;
  const concurrency = run % 2 ? 2 : 4;
  const result = spawnSync(process.execPath, ["test/run-all.js", ...suites, `--concurrency=${concurrency}`, `--seed=${seed}`, "--json"], {
    cwd: root, env: { ...process.env, SIDEKICK_PROPERTY_SEED: String(seed), SIDEKICK_TEST_OVERALL_TIMEOUT_MS: "300000" }, encoding: "utf8", timeout: 330000,
  });
  let report = null; try { report = JSON.parse(result.stdout.trim().split(/\n/).pop()); } catch {}
  results.push({ run, seed, concurrency, status: result.status === 0 ? "passed" : "failed", exit_code: result.status, signal: result.signal, failed_suites: report?.failures?.map(item => item.suite) || [], not_run: report?.not_run || [] });
}
const failures = results.filter(item => item.status === "failed");
const report = { version: 2, suites, repetitions, failures: failures.length, flaky: failures.length > 0 && failures.length < repetitions, reproducibly_failed: failures.length === repetitions, results, reproduction: `SIDEKICK_FLAKE_RUNS=${repetitions} npm run test:flake -- ${suites.join(" ")}` };
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(root, "artifacts", "flake-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Flake diagnostic: ${failures.length ? "failures detected" : "passed"}; ${suites.length} suites x ${repetitions} repetitions`);
if (failures.length) process.exitCode = 1;
