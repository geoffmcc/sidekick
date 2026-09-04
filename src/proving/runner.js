"use strict";

const { getRecipe, validateRecipe } = require("./recipes");
const { callInternalTool } = require("../tools/dispatcher");
const platformKernel = require("../platform/kernel");

const TERMINAL = new Set(["passed", "failed", "blocked", "skipped", "unavailable", "not_evaluated", "inconclusive"]);

function executableCases(recipe) {
  return (recipe?.single_pack || []).filter(item => item && typeof item === "object"
    && typeof item.tool === "string" && item.tool.length > 0 && item.args && typeof item.args === "object" && !Array.isArray(item.args));
}

async function runRecipe(pack, { project = "pack-proving", actor = "proving-runner", authIdentity = null, liveProvider = false } = {}) {
  const recipe = getRecipe(pack);
  const validation = validateRecipe(recipe);
  if (!validation.valid) return { schema: "sidekick.pack-proving-run.v1", status: "failed", pack, errors: validation.errors };
  const runId = `proving_${Date.now().toString(36)}`;
  const execution = platformKernel.createExecution({ execution_id: runId, project_id: project, actor_id: actor, actor_principal_id: actor, operation_type: "pack_proving", trigger_type: "operator", source: "proving", correlation_id: runId, metadata: { pack: recipe.pack, recipe_id: recipe.id, recipe_version: recipe.version } });
  platformKernel.transitionExecution(runId, "running", { source: "proving", actor_id: actor, reason: "proving recipe started" });
  const steps = [];
  const context = { project, actor, sessionId: runId, executionId: runId, authIdentity: authIdentity || { principal_id: actor } };
  for (const check of recipe.discovery) {
    const [name, action] = check.split(".");
    const args = { action };
    if (name === "capability" && ["show", "health"].includes(action)) args.name = recipe.pack;
    const result = await callInternalTool(name, args, context);
    steps.push({ name: check, status: result.isError ? "failed" : "passed", receipt: result.operationId || result.operation_id || null });
    if (result.isError) break;
  }
  if (steps.every(step => step.status === "passed") && executableCases(recipe).length === 0) {
    steps.push({ name: "single_pack", status: "not_evaluated", reason: "recipe declares no server-approved executable fixture cases" });
  }
  for (const fixture of executableCases(recipe)) {
    if (steps.some(step => step.status !== "passed")) break;
    const result = await callInternalTool(fixture.tool, { ...fixture.args }, context);
    steps.push({ name: `single_pack.${fixture.tool}`, status: result.isError ? "failed" : "passed", receipt: result.operationId || result.operation_id || null });
  }
  if (steps.every(step => step.status === "passed") && recipe.live_provider_required && !liveProvider) {
    steps.push({ name: "provider", status: "unavailable", reason: "recipe requires a live provider and none was authorized" });
  }
  const status = steps.some(step => step.status === "failed") ? "failed" : steps.some(step => step.status === "unavailable") ? "unavailable" : steps.some(step => step.status === "not_evaluated") ? "not_evaluated" : "passed";
  platformKernel.transitionExecution(runId, status === "passed" ? "completed" : "failed", { source: "proving", actor_id: actor, result_status: status, result_summary: `${recipe.pack} proving ${status}` });
  if (!TERMINAL.has(status)) throw new Error("proving runner produced a non-terminal status");
  return { schema: "sidekick.pack-proving-run.v1", version: 1, run_id: runId, execution_id: execution.execution_id, version: 1, pack: recipe.pack, recipe_id: recipe.id, status, evidence_kind: liveProvider ? "live_provider" : "fixture_or_local", steps };
}

module.exports = { runRecipe, executableCases };
