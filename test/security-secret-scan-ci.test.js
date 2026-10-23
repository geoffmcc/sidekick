"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const ignore = fs.readFileSync(path.join(root, ".gitleaksignore"), "utf8");

test("CI scans complete Git history with a pinned, constrained Gitleaks container", () => {
  assert.match(workflow, /name: Full-history secret scan[\s\S]*?contents: read[\s\S]*?fetch-depth: 0[\s\S]*?persist-credentials: false/);
  assert.match(workflow, /ghcr\.io\/gitleaks\/gitleaks:v8\.30\.1@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb/);
  for (const option of ["--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--cpus 2", "--memory 2g", "--pids-limit 64", "--redact", "--log-opts=--all"]) {
    assert.ok(workflow.includes(option), `secret scan must retain ${option}`);
  }
  assert.match(workflow, /dst=\/repo,readonly/);
});

test("historical false positives are fingerprint-specific instead of path-wide", () => {
  const entries = ignore.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  assert.equal(entries.length, 12);
  for (const entry of entries) assert.match(entry, /^[0-9a-f]{40}:.+:[a-z0-9-]+:\d+$/);
  assert.ok(!entries.some(entry => /:test\/\*|:test\/security\/?$/.test(entry)), "no whole test path may be excluded");
});
