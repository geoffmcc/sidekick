"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { analyzeWorkflowEffects } = require("../src/workflows/effects");
const { determineEffect } = require("../src/agent/authority");

function workflowsBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return workflowsBelow(full);
    if (!entry.name.endsWith(".json") || !full.includes(`${path.sep}workflows${path.sep}`)) return [];
    const definition = JSON.parse(fs.readFileSync(full, "utf8"));
    return definition.steps ? [{ file: full, definition }] : [];
  });
}

test("all bundled workflows are audited; read_only excludes target/app-state writes and unknown steps", () => {
  const definitions = workflowsBelow(path.resolve(__dirname, "..", "packs"));
  assert.ok(definitions.length > 80);
  for (const { file, definition } of definitions) {
    const effects = analyzeWorkflowEffects(definition);
    if (definition.mode !== "read_only") continue;
    assert.equal(effects.unknown, false, `${definition.name} must not declare read_only with unknown effects (${file})`);
    assert.equal(effects.writes_application_state, false, `${definition.name} writes Sidekick state (${file})`);
    assert.equal(effects.effects.includes("external"), false, `${definition.name} may change an external target (${file})`);
  }
});

test("programmatically registered Core workflows use the same effect analyzer", () => {
  const core = require("../src/workflows/core-definitions");
  assert.ok(core.definitions.length > 0);
  for (const definition of core.definitions) {
    const effects = analyzeWorkflowEffects(definition);
    assert.equal(effects.unknown, false, `${definition.name} must declare or derive its effects`);
  }
});

test("repository recon exposes its default handoff write and a no-handoff invocation", () => {
  const definition = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "packs/developer/workflows/repository-recon.json"), "utf8"));
  const defaults = analyzeWorkflowEffects(definition);
  assert.equal(definition.inputs.record_handoff.default, true);
  assert.ok(defaults.default_effects.includes("application_state"));
  assert.equal(defaults.writes_application_state, true);

  const noHandoff = analyzeWorkflowEffects(definition, { record_handoff: false });
  assert.equal(noHandoff.writes_application_state, false);
  assert.equal(noHandoff.strict_no_write, true);
  const handoffStep = noHandoff.steps.find(step => step.step === "handoff");
  assert.equal(handoffStep.enabled_by_default, false);
  assert.deepEqual(handoffStep.default_effects, []);
});

test("quality lifecycle distinguishes plan, execute, and unsupported cancel", () => {
  const definition = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "packs/testing-quality-engineering/workflows/quality-lifecycle.json"), "utf8"));
  assert.equal(definition.mode, "mutating", "the workflow can execute project commands");
  assert.deepEqual(analyzeWorkflowEffects(definition, { action: "plan" }).effects, ["read_only"]);
  assert.equal(analyzeWorkflowEffects(definition, { action: "plan" }).strict_no_write, true);
  assert.deepEqual(analyzeWorkflowEffects(definition, { action: "execute" }).effects, ["build_test", "local_process"]);
  assert.deepEqual(analyzeWorkflowEffects(definition, { action: "cancel" }).effects, ["read_only"]);
  assert.deepEqual(definition.inputs.action.enum, ["plan", "execute", "cancel"]);
});

test("artifact capture is distinct from changing the inspected target", () => {
  const browser = { name: "ui-smoke", inputs: {}, steps: [{ name: "capture", tool: "browser", args: { action: "screenshot" } }] };
  const screenshot = analyzeWorkflowEffects(browser);
  assert.deepEqual(screenshot.effects, ["artifact"]);
  assert.equal(screenshot.produces_artifacts, true);
  assert.equal(screenshot.no_target_mutation, true);
  assert.equal(screenshot.strict_no_write, false, "artifact production is still a write under the strict no-write guarantee");

  const click = analyzeWorkflowEffects({ name: "click", inputs: {}, steps: [{ name: "submit", tool: "browser", args: { action: "click" } }] });
  assert.ok(click.effects.includes("external"));
  assert.equal(click.no_target_mutation, false);
});

test("conditional artifact and dry-run effects use the same action metadata as Agent authority", () => {
  const api = { name: "api_contract_check", risk: "medium", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } };
  const readOnlyApi = determineEffect(api, { capture_evidence: false });
  assert.equal(readOnlyApi.effect, "read_only");
  const capturedApi = determineEffect(api, { capture_evidence: true });
  assert.equal(capturedApi.effect, "artifact");
  assert.ok(capturedApi.effects.includes("target_read"));

  const quality = { name: "dev_verify", risk: "high", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
  assert.equal(determineEffect(quality, { dry_run: true }).effect, "read_only");
  assert.equal(determineEffect(quality, { dry_run: false }).effect, "build_test");

  const browser = { name: "browser", risk: "high", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } };
  assert.equal(determineEffect(browser, { action: "wait", for: "load" }).effect, "read_only");
  assert.equal(determineEffect(browser, { action: "wait", for: "download" }).effect, "artifact");
});
