"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-proving-runner-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "proving-runner-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const bundled = require("../src/packs/bundled");
const lifecycle = require("../src/packs/lifecycle");
const { runRecipe, executableCases, resultStatus } = require("../src/proving/runner");
const { errorResult } = require("../src/tools/result");
const platformKernel = require("../src/platform/kernel");
const { createServiceContext } = require("./helpers/authorized-context");

test("proving classifies provider-unavailable errors as unavailable", () => {
  assert.equal(resultStatus(errorResult(new Error("provider unavailable"), "provider_unavailable")).unavailable, true);
});

test("proving recognizes only explicit server-approved executable cases", () => {
  assert.equal(executableCases({ single_pack: [{ capability: "api_contract_check", dispatch: "canonical" }] }).length, 0);
  assert.equal(executableCases({ single_pack: [{ tool: "api_contract_check", args: { url: "https://example.test" } }] }).length, 1);
});

test("proving does not pass a recipe whose capability cases are declarative only", async () => {
  const installed = bundled.installBundledPack("api-engineering");
  lifecycle.enable(installed.pack.name);
  const result = await runRecipe(installed.pack.name, { project: "proving-test", actor: "proving-test" });
  assert.notEqual(result.status, "passed", JSON.stringify(result));
});

test("proving executes every explicit local fixture phase", async () => {
  const recipe = {
    id: "pack-proving.fixture-pack",
    version: 1,
    pack: "fixture-pack",
    preconditions: [],
    expected_evidence: [],
    live_provider_required: false,
    discovery: [],
    single_pack: [],
    cross_pack: [],
    negative_checks: [],
    independent_verification: [],
    local_fixtures: {
      single_pack: [{ tool: "capability", args: { action: "list" }, mutation: false }],
      cross_pack: [{ tool: "capability", args: { action: "list" }, mutation: false }],
      negative_checks: [{ tool: "capability", args: { action: "list" }, mutation: false }],
      independent_verification: [{ tool: "capability", args: { action: "list" }, mutation: false }],
    },
    mutation_policy: "read_only_by_default",
    bounds: { timeout_ms: 1000, max_steps: 8, max_retries: 0 },
  };
  const principalContext = createServiceContext({ role: "operator", project: "proving-fixture" });
  const result = await runRecipe("fixture-pack", { recipe, project: "proving-fixture", actor: "forged-display-label", authIdentity: principalContext.authIdentity });
  assert.equal(result.status, "passed", JSON.stringify(result));
  const execution = platformKernel.getExecution(result.execution_id);
  assert.equal(execution.actor_id, principalContext.authIdentity.principal_id);
  assert.equal(execution.actor_principal_id, principalContext.authIdentity.principal_id);
  assert.deepEqual(result.steps.map(step => step.name), [
    "single_pack.capability",
    "cross_pack.capability",
    "negative_checks.capability",
    "independent_verification.capability",
  ]);
});

test("proving preserves a failed phase while continuing later executable phases", async () => {
  const recipe = {
    id: "pack-proving.fixture-failure",
    version: 1,
    pack: "fixture-failure",
    preconditions: [],
    expected_evidence: [],
    live_provider_required: false,
    discovery: [],
    single_pack: [],
    cross_pack: [],
    negative_checks: [],
    independent_verification: [],
    local_fixtures: {
      single_pack: [{ tool: "capability", args: { action: "not-a-real-action" }, mutation: false }],
      independent_verification: [{ tool: "capability", args: { action: "list" }, mutation: false }],
    },
    mutation_policy: "read_only_by_default",
    bounds: { timeout_ms: 1000, max_steps: 8, max_retries: 0 },
  };
  const result = await runRecipe("fixture-failure", { recipe, project: "proving-fixture", actor: "proving-fixture", authIdentity: {} });
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.steps.find(step => step.name === "single_pack.capability").status, "failed");
  assert.equal(result.steps.find(step => step.name === "independent_verification.capability").status, "passed");
  assert.ok(result.steps.some(step => step.name === "cross_pack" && step.status === "not_evaluated"));
});

test("proving never promotes its actor label into authenticated attribution", async () => {
  const recipe = {
    id: "pack-proving.fixture-pack",
    version: 1,
    pack: "fixture-pack",
    preconditions: [],
    expected_evidence: [],
    live_provider_required: false,
    discovery: [],
    single_pack: [],
    cross_pack: [],
    negative_checks: [],
    independent_verification: [],
    mutation_policy: "read_only_by_default",
    bounds: { timeout_ms: 1000, max_steps: 1, max_retries: 0 },
  };
  const result = await runRecipe("fixture-pack", { recipe, project: "proving-unauthenticated", actor: "capability-proving" });
  assert.ok(result.execution_id, JSON.stringify(result));
  const execution = platformKernel.getExecution(result.execution_id);
  assert.equal(execution.actor_id, null);
  assert.equal(execution.actor_principal_id, null);
});
