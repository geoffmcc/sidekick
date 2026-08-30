"use strict";
process.env.NODE_ENV = "test";
const assert = require("assert");
const { createAuthorityEnvelope, intersectEnvelope, determineEffect, decideAutonomy, argumentDigest, governedTargetRef } = require("../src/agent/authority");
const { classifyCapabilityFailure, preflightCapabilityCall } = require("../src/agent/capability-repair");

function schema() { return { safeParse(value) { return { success: true, data: value }; } }; }

async function main() {
  const parent = createAuthorityEnvelope({ permitted_projects: ["sidekick"], allowed_effects: ["read_only", "workspace_reversible"], changes_allowed: true, child_task_depth: 3, child_task_count: 2 });
  assert.deepStrictEqual(createAuthorityEnvelope({ prohibited_effects: [] }).prohibited_effects, [], "boundary-changing effects require explicit envelope scope and approval; they are not silently granted");
  const child = intersectEnvelope({ permitted_projects: ["sidekick", "other"], allowed_effects: ["read_only", "external"], changes_allowed: true, child_task_depth: 8 }, parent);
  assert.deepStrictEqual(child.permitted_projects, ["sidekick"]);
  assert.deepStrictEqual(child.allowed_effects, ["read_only"]);
  assert.strictEqual(child.child_task_depth, 3);
  const principalNarrowed = intersectEnvelope({ allowed_effects: ["read_only", "workspace_reversible"], changes_allowed: true, approval_threshold: "low" }, { allowed_effects: ["read_only"], changes_allowed: false, approval_threshold: "high" });
  assert.deepStrictEqual(principalNarrowed.allowed_effects, ["read_only"]);
  assert.strictEqual(principalNarrowed.changes_allowed, false);
  assert.strictEqual(principalNarrowed.approval_threshold, "low", "intersection retains the stricter approval threshold");

  const read = { name: "read", risk: "medium", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
  const write = { name: "write", risk: "critical", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } };
  assert.strictEqual(determineEffect(read, {}).effect, "read_only");
  assert.strictEqual(determineEffect(write, {}).effect, "destructive");
  assert.strictEqual(determineEffect({ name: "project_registry", risk: "high" }, { action: "list" }).effect, "read_only", "allowlisted metadata actions on mixed tools are read-only");
  assert.strictEqual(determineEffect({ name: "project_registry", risk: "high" }, { action: "register" }).effect, "destructive", "unlisted mixed-tool actions retain their destructive classification");
  assert.strictEqual(preflightCapabilityCall("project_registry", { action: "list" }, [{ name: "project_registry", risk: "high", schema: schema() }]).ok, true, "allowlisted project metadata reads pass capability preflight");
  assert.strictEqual(decideAutonomy({ descriptor: read, args: {}, envelope: parent, projectRef: "sidekick" }).decision, "proceed");
  assert.strictEqual(decideAutonomy({ descriptor: write, args: {}, envelope: parent }).decision, "deny");
  assert.strictEqual(decideAutonomy({ descriptor: read, args: {}, envelope: createAuthorityEnvelope({ permitted_projects: ["project:allowed"] }), projectRef: "project:other" }).decision, "deny");
  const git = { name: "git", risk: "low", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
  assert.strictEqual(determineEffect(git, { action: "commit" }).risk, "critical");
  assert.strictEqual(determineEffect(git, { action: "push" }).effect, "external");
  assert.strictEqual(decideAutonomy({ descriptor: write, args: {}, envelope: createAuthorityEnvelope({ allowed_effects: ["destructive"], changes_allowed: true }), workspaceRef: null }).decision, "approval_required");
  assert.strictEqual(decideAutonomy({ descriptor: read, args: {}, envelope: createAuthorityEnvelope({ capability_restrictions: ["other"] }), capabilityRef: "read" }).decision, "deny");
  assert.strictEqual(decideAutonomy({ descriptor: read, args: {}, envelope: createAuthorityEnvelope({ expires_at: new Date(Date.now() - 1000).toISOString() }) }).decision, "deny");
  const scopedEnvironment = createAuthorityEnvelope({ environmental_scope: ["production"], allowed_effects: ["read_only"] });
  assert.strictEqual(decideAutonomy({ descriptor: read, args: {}, envelope: scopedEnvironment, environmentRef: "development" }).decision, "deny", "environment scope is enforced at the autonomy decision boundary");
  assert.strictEqual(decideAutonomy({ descriptor: read, args: {}, envelope: scopedEnvironment, environmentRef: "production" }).decision, "proceed");
  const mediumWrite = { name: "workspace", risk: "medium", effect_class: "workspace_reversible", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
  const scoped = createAuthorityEnvelope({ allowed_effects: ["workspace_reversible"], changes_allowed: true, approval_threshold: "medium" });
  assert.strictEqual(decideAutonomy({ descriptor: mediumWrite, args: {}, envelope: scoped, workspaceRef: "workspace:test" }).decision, "approval_required");
  const routine = createAuthorityEnvelope({ allowed_effects: ["workspace_reversible"], changes_allowed: true, approval_threshold: "high" });
  assert.strictEqual(decideAutonomy({ descriptor: { ...mediumWrite, risk: "medium" }, args: {}, envelope: routine, workspaceRef: "workspace:test" }).decision, "proceed");
  const unclassifiedWrite = { name: "write", risk: "medium", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
  assert.strictEqual(determineEffect(unclassifiedWrite, {}).authoritative, false, "tool names cannot authorize a mutation when canonical effect metadata is absent");
  const build = { name: "generated_build", risk: "medium", effect_class: "build_test", idempotent: true, reversible: true, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
  assert.strictEqual(determineEffect(build, {}).effect, "build_test", "structured descriptor effect metadata is authoritative");
  assert.strictEqual(decideAutonomy({ descriptor: build, args: {}, envelope: createAuthorityEnvelope({ allowed_effects: ["build_test"], changes_allowed: true }), workspaceRef: "workspace:test" }).decision, "proceed");
  assert.strictEqual(determineEffect({ name: "unsafe_generated", effect_class: "read_only", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, {}).authoritative, false, "conflicting read-only and destructive metadata fails closed");
  assert.strictEqual(decideAutonomy({ descriptor: read, args: {}, envelope: createAuthorityEnvelope({ permitted_repositories: ["repository:allowed"] }), projectRef: "sidekick", repositoryRef: "repository:other" }).decision, "deny", "repository scope is enforced independently of workspace scope");
  assert.notStrictEqual(argumentDigest({ value: "a" }), argumentDigest({ value: "b" }));
  assert.strictEqual(argumentDigest({ b: 2, a: 1 }), argumentDigest({ a: 1, b: 2 }), "argument digests use canonical key ordering");
  assert.notStrictEqual(argumentDigest({ value: "a".repeat(5001) }), argumentDigest({ value: "b" + "a".repeat(5000) }), "long argument identity is not truncated");
  assert.strictEqual(governedTargetRef({ target_ref: "workspace:repo" }, null), "workspace:repo");
  assert.strictEqual(governedTargetRef({ target_ref: "../../etc/passwd" }, null), null);

  const missing = preflightCapabilityCall("write", { action: "update" }, [{ ...write, schema: null }]);
  assert.strictEqual(missing.ok, false, "missing canonical schema must fail closed for mutation");
  const transient = classifyCapabilityFailure({ isError: true, code: "timeout", content: [{ text: "temporary timeout" }] }, { tool: "write", args: {}, descriptor: write });
  assert.strictEqual(transient.retryable, false, "textual read-only inference must not authorize mutation retry");
  const unclassifiedTransient = classifyCapabilityFailure({ isError: true, code: "timeout", content: [{ text: "temporary timeout" }] }, { tool: "write", args: {}, descriptor: unclassifiedWrite, authority: createAuthorityEnvelope({ allowed_effects: ["unknown", "workspace_reversible"], changes_allowed: true }) });
  assert.strictEqual(unclassifiedTransient.retryable, false, "missing canonical effect metadata must fail closed for mutation retry");
  const safeTransient = classifyCapabilityFailure({ isError: true, code: "timeout", content: [{ text: "temporary timeout" }] }, { tool: "read", args: {}, descriptor: read, authority: parent });
  assert.strictEqual(safeTransient.retryable, true);
  const { shouldSuppressEquivalentFailure } = require("../src/agent/task-model");
  assert.strictEqual(shouldSuppressEquivalentFailure({ retryable: 1, changed_condition: 0 }), true, "transient classification cannot authorize an identical retry");
  assert.strictEqual(shouldSuppressEquivalentFailure({ retryable: 1, changed_condition: 1 }), false, "durable changed-condition evidence permits revalidation");
  console.log("Adaptive durable Agent authority tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
