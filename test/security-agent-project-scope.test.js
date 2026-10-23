"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { resolveTaskProjectScope, taskProjectForExecution } = require("../src/agent/project-scope");

const repo = path.resolve(__dirname, "..");
const infer = (text) => /project\s+([a-z0-9-]+)/i.exec(String(text))?.[1] || null;

test("authenticated task intake resolves and checks project scope before persistence", () => {
  assert.equal(resolveTaskProjectScope({ requestedProject: "explicit", goal: "project inferred", principalId: "p1", inferProjectFromText: infer }), "explicit");
  assert.equal(resolveTaskProjectScope({ goal: "please work on project alpha", principalId: "p1", inferProjectFromText: infer }), "alpha");
  assert.equal(resolveTaskProjectScope({ goal: "please work on project alpha", inferProjectFromText: infer }), null, "untrusted text cannot select a project without an authenticated principal");

  const source = fs.readFileSync(path.join(repo, "src/agent.js"), "utf8");
  assert.match(source, /resolveTaskProjectScope\(\{ requestedProject, goal: goalCheck\.goal, principalId: authIdentity\?\.principal_id, inferProjectFromText \}\)/);
  assert.match(source, /hasProjectPermission\(authIdentity\.principal_id, taskProject, "agent\.tasks\.read"/);
  assert.match(source, /project_id: parentContext && parentContext\.project/);
});

test("durable execution and recovery use stored project scope, not mutable goal text", () => {
  const durable = { project_id: "authorized-project" };
  assert.equal(taskProjectForExecution(durable, { goal: "project attacker-project", parentProject: "parent-project", inferProjectFromText: infer }), "authorized-project");
  assert.equal(taskProjectForExecution({ project_id: null }, { goal: "project attacker-project", parentProject: "parent-project", inferProjectFromText: infer }), null, "a durable task with no project remains unscoped");
  assert.equal(taskProjectForExecution(null, { goal: "project attacker-project", principalId: "p1", inferProjectFromText: infer }), null, "a missing authenticated task record fails closed against text-derived scope");
  assert.equal(taskProjectForExecution(null, { goal: "project attacker-project", parentProject: "checked-project", principalId: "p1", inferProjectFromText: infer }), "checked-project", "an authenticated execution context may retain its already-checked project");
  assert.equal(taskProjectForExecution(null, { goal: "project legacy-project", inferProjectFromText: infer }), "legacy-project", "legacy nondurable callers retain existing inference behavior");

  const recovery = fs.readFileSync(path.join(repo, "src/agent/continuation-jobs.js"), "utf8");
  assert.match(recovery, /const project = durableTask\?\.project_id \|\| null/);
  assert.doesNotMatch(recovery, /decryptJson|inferProjectFromText|goal_encrypted/);
});
