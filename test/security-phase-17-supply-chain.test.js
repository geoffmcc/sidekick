"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const workflow = fs.readFileSync(path.resolve(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
const deployPs = fs.readFileSync(path.resolve(__dirname, "..", "deploy.ps1"), "utf8");
const deploySh = fs.readFileSync(path.resolve(__dirname, "..", "deploy.sh"), "utf8");

const actionUses = workflow.match(/^\s*(?:-\s*)?uses: actions\/[\w-]+@[^\s]+/gm) || [];
assert.ok(actionUses.length >= 3, "CI must retain immutable action inventory");
for (const use of actionUses) {
  assert.match(use, /@[0-9a-f]{40}$/i, `CI action must be pinned to an immutable commit: ${use}`);
}

assert.doesNotMatch(deployPs, /npm install\s+--omit=dev|--no-package-lock/);
assert.doesNotMatch(deploySh, /npm install\s+--omit=dev|--no-package-lock/);
assert.match(deployPs, /npm ci\s+--omit=dev/);
assert.match(deploySh, /npm ci\s+--omit=dev/);

console.log("Passed: CI actions are immutable-pinned and deployments use the lockfile");
