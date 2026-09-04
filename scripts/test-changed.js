#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { runSuites } = require("../test/suite-runner");

const base = process.env.SIDEKICK_TEST_BASE || execFileSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" }).trim();
const changed = execFileSync("git", ["diff", "--name-status", base, "--"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean).map(line => {
  const [status, file, oldFile] = line.split(/\t+/);
  return { status, file, oldFile: oldFile || null };
});
const rules = [
  [/^(src\/)?(tools\/dispatcher|tools\/result|tools\/policy|tools\/path-policy|redact|core\/project-identity|approvals)/, ["security", "agent", "packs", "platforms"]],
  [/^(src\/)?(db|migrations|persistence)/, ["core", "agent", "packs", "platforms", "compute"]],
  [/^(src\/)?(agent|brain|handoff|context)/, ["agent", "platforms", "security"]],
  [/^(src\/)?(dashboard|static\/dashboard)/, ["platforms", "security"]],
  [/^(src\/)?(compute)/, ["compute", "agent", "security"]],
  [/^(packs\/|src\/packs|src\/capabilities|src\/workflows)/, ["packs", "agent", "platforms", "security"]],
  [/^(test\/|scripts\/test|\.github\/)/, ["core", "security", "agent", "packs", "platforms", "compute"]],
];
const reasons = new Map();
for (const { status, file, oldFile } of changed) {
  const target = `${file}${oldFile ? ` <- ${oldFile}` : ""}`;
  const match = rules.find(([pattern]) => pattern.test(file));
  for (const domain of match ? match[1] : ["core", "security", "agent", "packs", "platforms", "compute"]) {
    if (!reasons.has(domain)) reasons.set(domain, []);
    reasons.get(domain).push(`${status}:${target}${match ? ` (${match[0]})` : " (conservative unknown-file fallback)"}`);
  }
}
const selected = [...reasons.keys()];
console.log(JSON.stringify({ base, changed_files: changed, selected_domains: selected, reasons: Object.fromEntries(reasons) }, null, 2));
if (!selected.length) process.exit(0);
(async () => {
  const results = [];
  for (const domain of selected) results.push(await runSuites({ domain, concurrency: 4 }));
  process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
})();
