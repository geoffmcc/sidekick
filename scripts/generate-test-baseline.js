#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tracked = require("child_process").execFileSync("git", ["ls-files", "test"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
const testFiles = tracked.filter(file => /\.test\.(?:js|cjs|mjs)$/.test(file));
const lines = Number(require("child_process").execFileSync("wc", ["-l", ...testFiles], { cwd: root, encoding: "utf8" }).trim().split("\n").at(-1).trim().split(/\s+/)[0]);
const baseline = {
  version: 1,
  generated_for: "origin/main",
  commit: require("child_process").execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim(),
  suite_count: testFiles.length,
  test_case_count: null,
  test_lines: lines,
  runner: { type: "sequential-child-process", command: "node test/run-all.js", measured_timeout_ms: 120000, completed: false },
  observed: { fixed_ports: "present", shared_test_data_helper: "present", direct_environment_mutation: "present", custom_harnesses: "present", duplicate_ci_execution: true, large_experiment_tree: true },
  notes: ["Case count was not exposed by the standalone legacy suites.", "The baseline run exceeded 120000ms before completion and was bounded by the measurement command."]
};
const output = path.join(root, "docs", "testing-baseline.json");
fs.writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(baseline)}\n`);
