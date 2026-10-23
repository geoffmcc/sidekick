"use strict";

// Phase 15 regression: autonomous task completion must not promote
// model-generated procedure content into persistent executable capability.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createExecutionContext, runWithContext } = require("../src/tools/context");
const { createTaskExecutionContext } = require("../src/agent/task-execution-context");

const source = fs.readFileSync(path.resolve(__dirname, "..", "src", "agent.js"), "utf8");
const start = source.indexOf("async function suggestProcedure(");
const end = source.indexOf("\nasync function runAgent(", start);
assert.ok(start >= 0 && end > start, "suggestProcedure boundary must exist");
const body = source.slice(start, end);

assert.doesNotMatch(body, /callAgentTool\(\s*["']sidekick_teach["']/,
  "agent task completion must not auto-dispatch teach_procedure");
assert.match(body, /not saved automatically/i,
  "the task must make explicit promotion visible to the operator");
assert.match(body, /Explicit teach_procedure is required/i,
  "promotion must require an explicit teach_procedure action");

const ambientIdentity = { principal_id: "principal_ambient", scopes: ["secrets.use"] };
const anonymousTaskContext = runWithContext(
  createExecutionContext({ source: "test", authIdentity: ambientIdentity }),
  () => createTaskExecutionContext(null, "anonymous-task"),
);
assert.equal(anonymousTaskContext.authIdentity, null,
  "an Agent task without an initiating principal must not inherit ambient async authority");
const initiatingIdentity = { principal_id: "principal_initiator", scopes: ["secrets.use"] };
const authenticatedTaskContext = createTaskExecutionContext({ authIdentity: initiatingIdentity }, "authenticated-task");
assert.equal(authenticatedTaskContext.authIdentity, initiatingIdentity,
  "an authenticated Agent task must retain its initiating identity");

console.log("Passed: autonomous agent tasks cannot auto-promote procedures");
