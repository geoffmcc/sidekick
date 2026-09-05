#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const POLICY = Object.freeze({ min_observations: 5, min_failures: 2, min_failure_rate: 0.2, max_failure_rate: 0.8 });

function validObservations(observations) {
  return observations.filter(observation => observation === "passed" || observation === "failed");
}

function classifyHistory(observations, policy = POLICY) {
  const valid = validObservations(observations);
  const failures = valid.filter(status => status === "failed").length;
  const passes = valid.length - failures;
  const failureRate = valid.length ? failures / valid.length : 0;
  let state = "insufficient_evidence";
  if (valid.length >= policy.min_observations) {
    if (!passes) state = "reproducible_failure";
    else if (failures >= policy.min_failures && failureRate >= policy.min_failure_rate && failureRate <= policy.max_failure_rate) state = "quarantined";
    else state = "stable";
  }
  return { state, observations: valid.length, ignored_observations: observations.length - valid.length, passes, failures, failure_rate: failureRate };
}

function readHistory(file) {
  if (!file || !fs.existsSync(file)) return { source: null, entries: [] };
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = Array.isArray(value) ? value : Array.isArray(value.entries) ? value.entries : [];
  return { source: file, entries: entries.filter(entry => entry && typeof entry.suite === "string" && Array.isArray(entry.observations)) };
}

function resultStatus(result) {
  return result.status === "passed" || result.status === "failed" ? result.status : "inconclusive";
}

function runSuiteBatch(suites, repetitions) {
  const results = [];
  for (let run = 1; run <= repetitions; run++) {
    const seed = 700000 + run;
    const concurrency = run % 2 ? 2 : 4;
    const result = spawnSync(process.execPath, ["test/run-all.js", ...suites, `--concurrency=${concurrency}`, `--seed=${seed}`, "--json"], {
      cwd: root, env: { ...process.env, SIDEKICK_PROPERTY_SEED: String(seed), SIDEKICK_TEST_OVERALL_TIMEOUT_MS: "300000" }, encoding: "utf8", timeout: 330000,
    });
    let report = null; try { report = JSON.parse(result.stdout.trim().split(/\n/).pop()); } catch {}
    const statuses = Object.fromEntries(suites.map(suite => [suite, "inconclusive"]));
    for (const item of report?.results || []) statuses[item.suite] = resultStatus(item);
    results.push({ run, seed, concurrency, status: result.status === 0 ? "passed" : "failed", exit_code: result.status, signal: result.signal, suites: statuses, not_run: report?.not_run || [] });
  }
  return results;
}

function buildFlakeReport(suites, runs, historicalEntries = [], policy = POLICY) {
  const classifications = {};
  for (const suite of suites) {
    const current = runs.map(run => run.suites[suite] || "inconclusive");
    const historical = historicalEntries.filter(entry => entry.suite === suite).flatMap(entry => entry.observations);
    classifications[suite] = { current: classifyHistory(current, policy), historical: classifyHistory(historical, policy), combined: classifyHistory([...historical, ...current], policy) };
  }
  const quarantined = suites.filter(suite => classifications[suite].combined.state === "quarantined");
  const reproducibleFailures = suites.filter(suite => classifications[suite].combined.state === "reproducible_failure");
  return { version: 3, policy, classifications, quarantined, reproducible_failures: reproducibleFailures, candidates: suites.filter(suite => classifications[suite].combined.state === "insufficient_evidence") };
}

if (require.main === module) {
  const requested = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
  const candidates = requested.length ? requested : ["test/run-all.test.js", "test/pack-maturity.test.js", "test/dashboard-api.test.js", "test/agent-cancel.test.js", "test/compute-cancellation.test.js", "test/browser-egress.test.js"];
  const suites = candidates.filter(file => fs.existsSync(path.join(root, file)));
  const repetitions = Math.max(2, Math.min(10, Number(process.env.SIDEKICK_FLAKE_RUNS || 3)));
  const runs = runSuiteBatch(suites, repetitions);
  const history = readHistory(process.env.SIDEKICK_FLAKE_HISTORY || path.join(root, "artifacts", "flake-history.json"));
  const analysis = buildFlakeReport(suites, runs, history.entries);
  const failures = runs.filter(run => run.status === "failed");
  const report = { ...analysis, suites, repetitions, runs, historical_evidence: { source: history.source, entries: history.entries.length }, failures: failures.length, reproduction: `SIDEKICK_FLAKE_RUNS=${repetitions} npm run test:flake -- ${suites.join(" ")}` };
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts", "flake-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Flake diagnostic: ${analysis.reproducible_failures.length ? "reproducible failures" : analysis.quarantined.length ? "quarantined historical flakes" : "no confirmed flakes"}; ${suites.length} suites x ${repetitions} repetitions`);
  if (analysis.reproducible_failures.length || failures.length && runs.some(run => run.status === "passed")) process.exitCode = 1;
}

module.exports = { POLICY, buildFlakeReport, classifyHistory, readHistory, resultStatus, validObservations };
