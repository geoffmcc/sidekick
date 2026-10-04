"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { z } = require("zod");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");
const { createRegistry } = require("../src/tools/registry");
const { normalizeDescriptor } = require("../src/tools/descriptor");
const { runOffline, resolveWorkflowDependencies } = require("../scripts/agent-workflow-smoke");

const core = getCanonicalRegistry({ includeActiveModules: false });
const coreDefinitions = core.toolDefs().map(definition => ({ ...definition, enabled: true, available: true }));

function moduleDescriptor(name, actions) {
  return normalizeDescriptor({
    name,
    description: `Fixture ${name}`,
    schema: z.object({ action: z.enum(actions) }).strict(),
    args: { action: `string (${actions.join("|")})` },
    risk: "medium",
    category: "Fixture",
    source: "module:fixture-tools",
    handler: async () => ({ ok: true }),
  });
}

function catalogWith(descriptors = []) {
  const registry = createRegistry([...core.listInDefinitionOrder(), ...descriptors]);
  const definitions = registry.toolDefs().map(definition => ({ ...definition, enabled: true, available: true }));
  return { registry, agentTools: new Map(definitions.map(definition => [definition.name, definition])), agentDefinitions: definitions };
}

function workflow(name, steps, extra = {}) {
  return {
    state: "registered",
    owner_kind: "pack",
    owner_name: "fixture-pack",
    definition: { name, inputs: {}, steps, ...extra },
  };
}

test("the three reported workflow dependencies resolve through canonical core and cross-pack registries", () => {
  const { registry, agentTools } = catalogWith([moduleDescriptor("research_hypothesis", ["create", "transition"]) ]);
  const cases = [
    workflow("browser-automation/ui-smoke", [
      { name: "open", tool: "browser", args: { action: "open" } },
      { name: "verify", tool: "browser", args: { action: "assert" } },
      { name: "evidence", tool: "browser", args: { action: "screenshot" } },
    ]),
    workflow("developer/repository-recon", [
      { name: "context", tool: "project", args: { name: "sample" } },
      { name: "history", tool: "git", args: { action: "log" } },
    ]),
    workflow("security-research/source-regression", [
      { name: "history", tool: "git", args: { action: "log" } },
      { name: "record", tool: "research_hypothesis", args: { action: "create" } },
    ]),
  ];
  for (const item of cases) {
    const resolved = resolveWorkflowDependencies(item, { registry, agentTools });
    assert.equal(resolved.ok, true, `${item.definition.name}: ${resolved.problems.join("; ")}`);
    assert.ok(resolved.dependencies.every(step => step.dependency_status === "available"));
    assert.ok(resolved.dependencies.every(step => ["available", "unverifiable", "not_applicable"].includes(step.action_status)));
  }
});

test("missing and disabled dependencies name the owning workflow and step", () => {
  const { registry, agentTools } = catalogWith();
  const missing = resolveWorkflowDependencies(workflow("fixture/missing", [{ name: "probe", tool: "never_registered", args: {} }]), { registry, agentTools });
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /workflow fixture\/missing step probe: missing capability never_registered/);

  const disabledTools = new Map(agentTools);
  disabledTools.set("git", { ...disabledTools.get("git"), enabled: false, available: false, policy: "source disabled" });
  const disabled = resolveWorkflowDependencies(workflow("fixture/disabled", [{ name: "history", tool: "git", args: { action: "log" } }]), { registry, agentTools: disabledTools });
  assert.equal(disabled.ok, false);
  assert.match(disabled.problems[0], /workflow fixture\/disabled step history: missing capability git/);
  assert.match(disabled.dependencies[0].reason, /source disabled/);
});

test("synthetic registered packs use the same generic resolver without pack-specific cases", () => {
  const { registry, agentTools } = catalogWith([moduleDescriptor("future_sensor", ["inspect", "write"]) ]);
  const synthetic = workflow("future-pack/inspect", [{ name: "sample", tool: "future_sensor", args: { action: "inspect" } }]);
  const result = resolveWorkflowDependencies(synthetic, { registry, agentTools, ownerState: "enabled" });
  assert.equal(result.ok, true);
  assert.equal(result.dependencies[0].canonical, "future_sensor");
  assert.equal(result.dependencies[0].action_status, "available");

  const offline = runOffline({
    owner: "fixture-pack",
    goal: "Inspect a future sensor and verify its status",
    expectTool: "future_sensor",
    runtime: { ...catalogWith([moduleDescriptor("future_sensor", ["inspect", "write"])]), workflows: [synthetic], packs: [{ name: "fixture-pack", state: "enabled", manifest: {} }], modules: [] },
  });
  assert.ok(offline.stages.discovery_and_ranking.full_catalog_used);
  assert.ok(offline.stages.discovery_and_ranking.catalog_size > 1);
  assert.equal(offline.stages.dispatch.state, "not_run");
  assert.equal(offline.metadata_ok, true);
});

test("full Agent-visible shortlist keeps natural-language candidates in competition and offline never claims dispatch", () => {
  const { registry, agentTools, agentDefinitions } = catalogWith();
  const fixture = workflow("fixture/full-catalog", [{ name: "inspect", tool: "browser", args: { action: "snapshot" } }]);
  const result = runOffline({
    owner: "fixture-pack",
    goal: "Inspect the current rendered browser page and show its text",
    expectTool: "browser",
    runtime: { registry, agentTools, agentDefinitions, workflows: [fixture], packs: [], modules: [] },
  });
  assert.ok(result.stages.discovery_and_ranking.catalog_size > result.stages.discovery_and_ranking.shortlist_size);
  assert.ok(result.stages.discovery_and_ranking.candidates.includes("browser"));
  assert.equal(result.stages.dispatch.state, "not_run");
  assert.match(result.stages.dispatch.reason, /no workflow or tool was dispatched/);
});

test("action options are independently rejected when a workflow names an unsupported action", () => {
  const { registry, agentTools } = catalogWith();
  const result = resolveWorkflowDependencies(workflow("fixture/action", [{ name: "query", tool: "git", args: { action: "purge" } }]), { registry, agentTools });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /step query: unsupported action/);
});
