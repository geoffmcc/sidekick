#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const suite = process.argv.slice(2).find(arg => !arg.startsWith("--")) || "test/run-all.test.js";
const repetitions = Number(process.env.SIDEKICK_FLAKE_RUNS || 3);
const results = [];
for (let run = 1; run <= Math.max(2, Math.min(10, repetitions)); run++) {
  const seed = String(700000 + run);
  const result = spawnSync(process.execPath, ["--test", suite], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, SIDEKICK_PROPERTY_SEED: seed }, encoding: "utf8", timeout: 120000 });
  results.push({ run, seed, status: result.status === 0 ? "passed" : "failed", exit_code: result.status, signal: result.signal });
}
const report = { version: 1, suite, repetitions: results.length, initial_failures: results.filter(item => item.status === "failed").length, results, reproduction: `SIDEKICK_PROPERTY_SEED=<seed> node --test ${suite}` };
fs.mkdirSync(path.resolve(__dirname, "..", "artifacts"), { recursive: true });
fs.writeFileSync(path.resolve(__dirname, "..", "artifacts", "flake-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.initial_failures ? "FLAKE DETECTED" : "Flake diagnostic passed"}: ${suite} repeated ${report.repetitions} times`);
if (report.initial_failures) { console.error(JSON.stringify(report, null, 2)); process.exitCode = 1; }
