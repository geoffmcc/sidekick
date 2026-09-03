#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { runSuites } = require("../test/suite-runner");

const changed = execFileSync("git", ["diff", "--name-only", "origin/main"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
const domains = new Set();
for (const file of changed) {
  if (/security|identity|approval|path-policy/.test(file)) domains.add("security");
  else if (/agent|brain|context/.test(file)) domains.add("agent");
  else if (/compute|openvino/.test(file)) domains.add("compute");
  else if (/pack|module|workflow/.test(file)) domains.add("packs");
  else domains.add("core");
}
const selected = [...domains];
if (!selected.length) { console.log("No changed production domain; metadata validation remains required."); process.exitCode = 0; }
else (async () => {
  const results = [];
  for (const domain of selected) results.push(await runSuites({ domain, concurrency: 2 }));
  process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
})();
