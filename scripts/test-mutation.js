#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const targets = ["src/core/project-identity.js", "src/core/path-policy.js", "src/tools/dispatcher.js", "src/tools/result.js"];
const selected = targets.filter(file => fs.existsSync(path.join(root, file)));
const check = spawnSync(process.execPath, ["test/run-all.js", "--tier=security", "--concurrency=2"], { cwd: root, encoding: "utf8", timeout: 300000 });
const report = { version: 1, mode: "targeted", targets: selected, selection_verification: check.status === 0 ? "passed" : "failed", mutation_score: null, surviving_mutations: [], limitation: "Mutation operators are intentionally not applied to the authoritative tree; targeted mutation execution is enabled only in the isolated mutation worker." };
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(root, "artifacts", "mutation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Targeted mutation selection: ${selected.length} critical modules; regression selection ${report.selection_verification}`);
if (check.status !== 0) process.exitCode = 1;
