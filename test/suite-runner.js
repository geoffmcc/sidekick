"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SKIP_EXIT_CODE = 77;
const root = path.join(__dirname, "..");

function discoverSuites(suites, testDir = __dirname) {
  const discovered = fs.readdirSync(testDir)
    .filter(file => /\.test\.(?:js|cjs)$/.test(file))
    .sort();
  const metadata = new Map(suites.map(suite => [suite.file, suite]));
  const explicit = suites.filter(suite => fs.existsSync(path.resolve(root, suite.file)) && path.dirname(path.resolve(root, suite.file)) === path.resolve(testDir));
  const explicitFiles = new Set(explicit.map(suite => path.basename(suite.file)));
  const discoveredSuites = discovered.filter(file => !explicitFiles.has(file)).map(file => metadata.get(`test/${file}`) || { file: `test/${file}`, critical: false, description: "Discovered test suite" });
  return [...explicit, ...discoveredSuites];
}

function matchesSelection(suite, name) { return name === suite.file || name === path.basename(suite.file); }

function selectSuites(allSuites, requested) {
  if (allSuites.length === 0) return { selected: [], unknown: [], error: "No test suites were discovered." };
  if (requested.length === 0) return { selected: allSuites, unknown: [] };
  const unknown = requested.filter(name => !allSuites.some(suite => matchesSelection(suite, name)));
  const selected = allSuites.filter(suite => requested.some(name => matchesSelection(suite, name)));
  return { selected, unknown, error: unknown.length ? `Invalid test suite selection: ${unknown.join(", ")}` : null };
}

function boundedSuiteTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1000, Math.min(Math.trunc(parsed), 30 * 60 * 1000)) : 5 * 60 * 1000;
}

function killTimedOutSuite(result) {
  if (process.platform === "win32" || !result?.pid) return;
  try { process.kill(-result.pid, "SIGKILL"); } catch {}
}

function runSuites({ suites, allSuites = discoverSuites(suites), requested = [], cwd = root, spawnSyncImpl = spawnSync, output = console, suiteTimeoutMs = boundedSuiteTimeout(process.env.SIDEKICK_TEST_SUITE_TIMEOUT_MS) } = {}) {
  const selection = selectSuites(allSuites, requested);
  if (selection.error || selection.selected.length === 0) {
    output.error(selection.error || "No test suites selected.");
    return { passed: 0, failed: 1, skipped: 0, failures: [], notRun: [], exitCode: 1 };
  }
  let passed = 0; let failed = 0; let skipped = 0;
  const failures = []; const notRun = [];
  output.log("╔═══════════════════════════════════════════════════════════╗\n║                    Sidekick Tests                         ║\n╚═══════════════════════════════════════════════════════════╝");
  for (let index = 0; index < selection.selected.length; index++) {
    const suite = selection.selected[index];
    const suitePath = path.join(cwd, suite.file);
    if (!fs.existsSync(suitePath)) {
      if (suite.optional) { skipped++; output.log(`\n↷ Skipping optional missing suite: ${suite.file}`); continue; }
      failed++; failures.push(`${suite.file} (missing)`);
      if (suite.critical) { notRun.push(...selection.selected.slice(index + 1).map(remaining => remaining.file)); break; }
      continue;
    }
    output.log(`\n${"═".repeat(60)}\nRunning: ${suite.file}\nPurpose: ${suite.description}${suite.critical ? "\nCritical: yes" : ""}\n${"═".repeat(60)}\n`);
    const result = spawnSyncImpl(process.execPath, [suitePath], { cwd, stdio: "inherit", detached: process.platform !== "win32", env: { ...process.env, NODE_ENV: "test" }, timeout: suiteTimeoutMs });
    if (result.error && result.error.code === "ETIMEDOUT") {
      killTimedOutSuite(result); failed++; failures.push(`${suite.file} (timeout after ${suiteTimeoutMs}ms)`); output.log(`\n❌ ${suite.file} timed out after ${suiteTimeoutMs}ms`);
      if (suite.critical) { notRun.push(...selection.selected.slice(index + 1).map(remaining => remaining.file)); break; }
    } else if (result.status === SKIP_EXIT_CODE) { skipped++; output.log(`\n↷ ${suite.file} skipped`); }
    else if (result.status === 0) { passed++; output.log(`\n✅ ${suite.file} passed`); }
    else { failed++; failures.push(suite.file); output.log(`\n❌ ${suite.file} failed`); if (suite.critical) { notRun.push(...selection.selected.slice(index + 1).map(remaining => remaining.file)); break; } }
  }
  output.log(`\n╔═══════════════════════════════════════════════════════════╗\n║                       Summary                             ║\n╚═══════════════════════════════════════════════════════════╝\nPassed:  ${passed}\nFailed:  ${failed}\nSkipped: ${skipped}`);
  if (failures.length) output.log(`\nFailed suites:\n${failures.map(failure => `  - ${failure}`).join("\n")}`);
  if (notRun.length) {
    output.log("\nNot run:");
    notRun.forEach(suite => output.log(`  - ${suite}`));
  }
  return { passed, failed, skipped, failures, notRun, exitCode: failed > 0 ? 1 : 0 };
}

module.exports = { SKIP_EXIT_CODE, discoverSuites, selectSuites, runSuites };
