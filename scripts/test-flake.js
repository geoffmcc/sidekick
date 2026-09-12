#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const HISTORY_VERSION = 1;
const QUARANTINE_VERSION = 1;
const POLICY = Object.freeze({
  min_observations: 5,
  min_failures: 2,
  min_failure_rate: 0.2,
  max_failure_rate: 0.8,
  max_quarantine_days: 14,
  max_quarantine_entries: 50,
});
const ORDINARY_STATUSES = new Set(["passed", "failed"]);
const INFRASTRUCTURE_STATUSES = new Set(["timeout", "crash", "malformed_output", "spawn_error"]);
const INCONCLUSIVE_STATUSES = new Set(["inconclusive", "cancelled", "skipped", "not_run"]);
const OBSERVATION_STATUSES = new Set([...ORDINARY_STATUSES, ...INFRASTRUCTURE_STATUSES, ...INCONCLUSIVE_STATUSES]);
const RUN_RESULT_STATUSES = new Set(["passed", "failed", "timeout", "cancelled", "skipped"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function assertSuite(suite, label) {
  if (typeof suite !== "string" || !/^test\/[A-Za-z0-9._/-]+\.(?:js|cjs|mjs)$/.test(suite) || suite.includes("..")) {
    throw new Error(`${label} must be an exact test suite path`);
  }
}

function validateHistoryDocument(value) {
  if (!isObject(value) || value.version !== HISTORY_VERSION || !Array.isArray(value.entries)) {
    throw new Error(`flake history must be version ${HISTORY_VERSION} with an entries array`);
  }
  assertExactKeys(value, ["version", "entries"], "flake history");
  if (value.entries.length > 1000) throw new Error("flake history has too many entries");
  const seen = new Set();
  for (const [index, entry] of value.entries.entries()) {
    const label = `flake history entry ${index}`;
    if (!isObject(entry)) throw new Error(`${label} must be an object`);
    assertExactKeys(entry, ["suite", "observations"], label);
    assertSuite(entry.suite, `${label}.suite`);
    if (seen.has(entry.suite)) throw new Error(`flake history contains duplicate suite ${entry.suite}`);
    seen.add(entry.suite);
    if (!Array.isArray(entry.observations) || entry.observations.length === 0 || entry.observations.length > 1000) {
      throw new Error(`${label}.observations must contain 1 to 1000 statuses`);
    }
    for (const status of entry.observations) {
      if (typeof status !== "string" || !OBSERVATION_STATUSES.has(status)) throw new Error(`${label}.observations contains an invalid status`);
    }
  }
  return value.entries;
}

function validateHistoryEntries(entries) {
  return validateHistoryDocument({ version: HISTORY_VERSION, entries });
}

function readHistory(file) {
  if (!file || !fs.existsSync(file)) return { source: null, status: "missing", entries: [] };
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  return { source: file, status: "valid", entries: validateHistoryDocument(value) };
}

function parseDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return Date.parse(value);
}

function validateQuarantineDocument(value, policy = POLICY) {
  if (!isObject(value) || value.version !== QUARANTINE_VERSION || !Number.isInteger(value.max_duration_days) || !Array.isArray(value.entries)) {
    throw new Error(`flake quarantine must be version ${QUARANTINE_VERSION} with max_duration_days and entries`);
  }
  assertExactKeys(value, ["version", "max_duration_days", "entries"], "flake quarantine");
  if (value.max_duration_days < 1 || value.max_duration_days > policy.max_quarantine_days) {
    throw new Error(`flake quarantine max_duration_days must be between 1 and ${policy.max_quarantine_days}`);
  }
  if (value.entries.length > policy.max_quarantine_entries) throw new Error("flake quarantine has too many entries");
  const seen = new Set();
  for (const [index, entry] of value.entries.entries()) {
    const label = `flake quarantine entry ${index}`;
    if (!isObject(entry)) throw new Error(`${label} must be an object`);
    assertExactKeys(entry, ["suite", "owner", "reason", "issue", "added_at", "expires_at"], label);
    assertSuite(entry.suite, `${label}.suite`);
    if (seen.has(entry.suite)) throw new Error(`flake quarantine contains duplicate suite ${entry.suite}`);
    seen.add(entry.suite);
    if (typeof entry.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._/@-]{1,79}$/.test(entry.owner.trim())) throw new Error(`${label}.owner must identify an owner`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10 || entry.reason.trim().length > 500) throw new Error(`${label}.reason must be a bounded justification`);
    if (typeof entry.issue !== "string" || !/^(?:https:\/\/|[A-Z][A-Z0-9-]{1,19}-\d+)[^\s]*$/.test(entry.issue)) throw new Error(`${label}.issue must be a tracking reference`);
    const added = parseDate(entry.added_at, `${label}.added_at`);
    const expires = parseDate(entry.expires_at, `${label}.expires_at`);
    if (expires <= added) throw new Error(`${label}.expires_at must be after added_at`);
    if (expires - added > value.max_duration_days * 24 * 60 * 60 * 1000) throw new Error(`${label} exceeds max_duration_days`);
  }
  return value.entries;
}

function validateQuarantineEntries(entries, policy = POLICY) {
  return validateQuarantineDocument({ version: QUARANTINE_VERSION, max_duration_days: policy.max_quarantine_days, entries }, policy);
}

function readQuarantine(file, policy = POLICY) {
  if (!file || !fs.existsSync(file)) return { source: null, status: "missing", entries: [] };
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  return { source: file, status: "valid", entries: validateQuarantineDocument(value, policy) };
}

function validObservations(observations) {
  return observations.filter(observation => observation === "passed" || observation === "failed");
}

function classifyHistory(observations, policy = POLICY) {
  if (!Array.isArray(observations)) throw new Error("observations must be an array");
  const infrastructure = observations.filter(status => INFRASTRUCTURE_STATUSES.has(status)).length;
  const inconclusive = observations.filter(status => INCONCLUSIVE_STATUSES.has(status) || !OBSERVATION_STATUSES.has(status)).length;
  const valid = validObservations(observations);
  const failures = valid.filter(status => status === "failed").length;
  const passes = valid.length - failures;
  const failureRate = valid.length ? failures / valid.length : 0;
  let state = "insufficient_evidence";
  if (infrastructure) state = "infrastructure";
  else if (inconclusive) state = "inconclusive";
  else if (valid.length >= policy.min_observations) {
    if (!passes) state = "reproducible_failure";
    else if (failures >= policy.min_failures && failureRate >= policy.min_failure_rate && failureRate <= policy.max_failure_rate) state = "quarantined";
    else state = "stable";
  }
  return {
    state,
    observations: valid.length,
    ignored_observations: observations.length - valid.length,
    infrastructure,
    inconclusive,
    passes,
    failures,
    failure_rate: failureRate,
  };
}

function resultStatus(result) {
  if (result && RUN_RESULT_STATUSES.has(result.status)) return result.status;
  return "inconclusive";
}

function parseBatchResult(suites, result) {
  const statuses = Object.fromEntries(suites.map(suite => [suite, "inconclusive"]));
  const markAll = status => Object.keys(statuses).forEach(suite => { statuses[suite] = status; });
  if (result?.error) {
    const status = result.error.code === "ETIMEDOUT" ? "timeout" : "spawn_error";
    markAll(status);
    return { status: "infrastructure", classification: "infrastructure", suites: statuses, not_run: [...suites], error: result.error.code || result.error.message };
  }
  if (result?.signal) {
    markAll("crash");
    return { status: "infrastructure", classification: "infrastructure", suites: statuses, not_run: [...suites], error: `signal:${result.signal}`, signal: result.signal };
  }
  if (typeof result?.stdout !== "string") {
    markAll("malformed_output");
    return { status: "infrastructure", classification: "infrastructure", suites: statuses, not_run: [...suites], error: "stdout_missing" };
  }
  const lines = result.stdout.trim().split(/\n/).map(line => line.trim()).filter(Boolean);
  let report;
  try { report = JSON.parse(lines.at(-1) || ""); } catch { report = null; }
  if (!isObject(report) || report.version !== 2 || !Array.isArray(report.results) || !Array.isArray(report.not_run) || !Number.isInteger(report.exitCode)) {
    markAll("malformed_output");
    return { status: "infrastructure", classification: "infrastructure", suites: statuses, not_run: [...suites], error: "malformed_output" };
  }
  const allowed = new Set(suites);
  const seen = new Set();
  for (const item of report.results) {
    if (!isObject(item) || typeof item.suite !== "string" || !allowed.has(item.suite) || seen.has(item.suite) || !RUN_RESULT_STATUSES.has(item.status)) {
      markAll("malformed_output");
      return { status: "infrastructure", classification: "infrastructure", suites: statuses, not_run: [...suites], error: "invalid_result_entry" };
    }
    seen.add(item.suite);
    statuses[item.suite] = resultStatus(item);
  }
  const notRun = report.not_run.filter(suite => typeof suite === "string");
  if (notRun.some(suite => !allowed.has(suite) || seen.has(suite)) || report.results.length + notRun.length > suites.length || result.status !== report.exitCode) {
    markAll("malformed_output");
    return { status: "infrastructure", classification: "infrastructure", suites: statuses, not_run: [...suites], error: "inconsistent_output" };
  }
  for (const suite of notRun) statuses[suite] = "not_run";
  const missing = suites.filter(suite => !seen.has(suite) && !notRun.includes(suite));
  for (const suite of missing) statuses[suite] = "not_run";
  const classification = Object.values(statuses).some(status => INFRASTRUCTURE_STATUSES.has(status)) ? "infrastructure"
    : Object.values(statuses).some(status => INCONCLUSIVE_STATUSES.has(status)) ? "inconclusive"
      : Object.values(statuses).some(status => status === "failed") ? "failed" : "passed";
  return { status: classification, classification, suites: statuses, not_run: [...new Set([...notRun, ...missing])], report };
}

function runSuiteBatch(suites, repetitions) {
  const results = [];
  for (let run = 1; run <= repetitions; run++) {
    const seed = 700000 + run;
    const concurrency = run % 2 ? 2 : 4;
    let child;
    try {
      child = spawnSync(process.execPath, ["test/run-all.js", ...suites, `--concurrency=${concurrency}`, `--seed=${seed}`, "--json"], {
        cwd: root, env: { ...process.env, SIDEKICK_PROPERTY_SEED: String(seed), SIDEKICK_TEST_OVERALL_TIMEOUT_MS: "300000" }, encoding: "utf8", timeout: 330000,
      });
    } catch (error) {
      child = { error };
    }
    const parsed = parseBatchResult(suites, child);
    results.push({ run, seed, concurrency, status: parsed.status, classification: parsed.classification, exit_code: child.status, signal: child.signal, suites: parsed.suites, not_run: parsed.not_run, error: parsed.error });
  }
  return results;
}

function quarantineForSuite(entries, suite, now = Date.now()) {
  const entry = entries.find(item => item.suite === suite);
  if (!entry) return { state: "missing", entry: null };
  const added = Date.parse(entry.added_at);
  const expires = Date.parse(entry.expires_at);
  if (now < added) return { state: "not_yet_active", entry };
  if (now >= expires) return { state: "expired", entry };
  return { state: "active", entry };
}

function buildFlakeReport(suites, runs, historicalEntries = [], policy = POLICY, quarantineEntries = [], now = Date.now(), metadata = {}) {
  const normalizedSuites = [...new Set(suites)];
  const historyEntries = validateHistoryEntries(historicalEntries);
  const quarantines = validateQuarantineEntries(quarantineEntries, policy);
  const classifications = {};
  const quarantined = [];
  const quarantinedCurrentFailures = [];
  const expiredQuarantines = [];
  const failures = [];
  for (const suite of normalizedSuites) {
    assertSuite(suite, "suite");
    const current = runs.map(run => run?.suites?.[suite] || "not_run");
    const historical = historyEntries.filter(entry => entry.suite === suite).flatMap(entry => entry.observations);
    const currentAnalysis = classifyHistory(current, policy);
    const historicalAnalysis = classifyHistory(historical, policy);
    const quarantine = quarantineForSuite(quarantines, suite, now);
    const historyQualified = historicalAnalysis.state === "quarantined";
    if (historyQualified && quarantine.state === "active") quarantined.push(suite);
    if (quarantine.state === "expired") expiredQuarantines.push(suite);
    let state = currentAnalysis.state;
    if (currentAnalysis.infrastructure || currentAnalysis.inconclusive) {
      state = currentAnalysis.infrastructure ? "infrastructure" : "inconclusive";
    } else if (currentAnalysis.failures > 0) {
      const reproducible = currentAnalysis.infrastructure === 0 && currentAnalysis.inconclusive === 0 && currentAnalysis.passes === 0;
      if (reproducible) state = "reproducible_failure";
      else if (historyQualified && quarantine.state === "active") {
        state = "quarantined_current_failure";
        quarantinedCurrentFailures.push(suite);
      } else {
        state = "ordinary_failure";
      }
    }
    const classification = { current: currentAnalysis, historical: historicalAnalysis, quarantine, state };
    classifications[suite] = classification;
    if (currentAnalysis.infrastructure) failures.push({ suite, reason: "infrastructure" });
    else if (currentAnalysis.inconclusive) failures.push({ suite, reason: "inconclusive" });
    else if (currentAnalysis.failures > 0 && state !== "quarantined_current_failure") failures.push({ suite, reason: state });
    if (currentAnalysis.failures > 0 && !historyQualified && !metadata.history_error) failures.push({ suite, reason: "insufficient_historical_evidence" });
  }
  const uniqueFailures = failures.filter((failure, index) => failures.findIndex(item => item.suite === failure.suite && item.reason === failure.reason) === index);
  if (metadata.history_error) uniqueFailures.push({ suite: "*", reason: "invalid_historical_evidence" });
  return {
    version: 4,
    policy,
    classifications,
    quarantined,
    quarantined_current_failures: quarantinedCurrentFailures,
    expired_quarantines: expiredQuarantines,
    reproducible_failures: normalizedSuites.filter(suite => classifications[suite].state === "reproducible_failure"),
    candidates: normalizedSuites.filter(suite => classifications[suite].historical.state === "insufficient_evidence"),
    gate: { pass: uniqueFailures.length === 0, failures: uniqueFailures },
    metadata,
  };
}

function shouldFail(report) {
  return report?.gate?.pass !== true;
}

if (require.main === module) {
  const requested = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
  const candidates = requested.length ? requested : ["test/run-all.test.js", "test/pack-maturity.test.js", "test/dashboard-api.test.js", "test/agent-cancel.test.js", "test/compute-cancellation.test.js", "test/browser-egress.test.js"];
  const suites = candidates.filter(file => fs.existsSync(path.join(root, file)));
  const repetitions = Math.max(2, Math.min(10, Number(process.env.SIDEKICK_FLAKE_RUNS || 3)));
  const runs = runSuiteBatch(suites, repetitions);
  let history;
  let historyError = null;
  try { history = readHistory(process.env.SIDEKICK_FLAKE_HISTORY || path.join(root, "artifacts", "flake-history.json")); }
  catch (error) { history = { source: process.env.SIDEKICK_FLAKE_HISTORY || null, status: "invalid", entries: [] }; historyError = error.message; }
  let quarantine;
  let quarantineError = null;
  try { quarantine = readQuarantine(process.env.SIDEKICK_FLAKE_QUARANTINE || path.join(root, "docs", "flake-quarantine-policy.json")); }
  catch (error) { quarantine = { source: process.env.SIDEKICK_FLAKE_QUARANTINE || null, status: "invalid", entries: [] }; quarantineError = error.message; }
  const analysis = buildFlakeReport(suites, runs, history.entries, POLICY, quarantine.entries, Date.now(), { history_status: history.status, quarantine_status: quarantine.status, history_error: historyError, quarantine_error: quarantineError });
  if (quarantineError) analysis.gate.failures.push({ suite: "*", reason: "invalid_quarantine_policy" });
  analysis.gate.pass = analysis.gate.failures.length === 0 && suites.length > 0;
  const report = {
    ...analysis,
    suites,
    repetitions,
    runs,
    historical_evidence: { source: history.source, status: history.status, entries: history.entries.length, error: historyError },
    quarantine_policy: { source: quarantine.source, status: quarantine.status, entries: quarantine.entries.length, error: quarantineError },
    failures: analysis.gate.failures.length,
    reproduction: `SIDEKICK_FLAKE_RUNS=${repetitions} npm run test:flake -- ${suites.join(" ")}`,
  };
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts", "flake-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Flake diagnostic: ${analysis.reproducible_failures.length ? "reproducible failures" : analysis.quarantined_current_failures.length ? "quarantined current failures" : analysis.gate.pass ? "no gate failures" : "gate failures"}; ${suites.length} suites x ${repetitions} repetitions`);
  if (!analysis.gate.pass) process.exitCode = 1;
}

module.exports = {
  INFRASTRUCTURE_STATUSES,
  INCONCLUSIVE_STATUSES,
  POLICY,
  buildFlakeReport,
  classifyHistory,
  parseBatchResult,
  quarantineForSuite,
  readHistory,
  readQuarantine,
  resultStatus,
  shouldFail,
  validObservations,
  validateHistoryDocument,
  validateQuarantineDocument,
};
