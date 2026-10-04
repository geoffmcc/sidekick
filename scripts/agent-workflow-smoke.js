"use strict";

// Offline checks use the live canonical registry, the workflow-definition
// registry and the exact Agent-source capability catalog. They do not call a
// model, provider, browser, or external service. `--live` is a separate optional
// Agent Bridge execution check; metadata discovery alone is never dispatch.

const fs = require("node:fs");
const path = require("node:path");
const { discoverCapabilities, buildAgentCapabilityMetadata } = require("../src/agent/capability-broker");
const { buildPlannerSystemPrompt } = require("../src/brain");

const root = path.resolve(__dirname, "..");

function cleanToolName(name) {
  return String(name || "").replace(/^sidekick_/i, "");
}

function parseActionOptions(argumentDescription) {
  const text = String(argumentDescription || "");
  const match = text.match(/\(([^()]{1,500})\)/);
  return match ? match[1].split("|").map(value => value.trim()).filter(Boolean) : null;
}

function actionOptionsFromSchema(descriptor) {
  if (typeof descriptor?.schema?.safeParse !== "function") return null;
  const result = descriptor.schema.safeParse({ action: "__sidekick_smoke_invalid_action__" });
  if (result.success) return null;
  const values = new Set();
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.values) && (value.path?.[0] === "action" || value.path?.length === 0)) {
      for (const option of value.values) if (typeof option === "string") values.add(option);
    }
    for (const [key, child] of Object.entries(value)) if (key === "errors" || key === "issues") visit(child);
  };
  visit(result.error?.issues || []);
  return values.size ? [...values] : null;
}

function stepActionValues(definition, step) {
  const action = step?.args?.action;
  if (typeof action !== "string") return { values: [], unresolved: false };
  const ref = action.match(/^\$\{inputs\.([a-zA-Z0-9_-]+)\}$/);
  if (!ref) return { values: [action], unresolved: false };
  const input = definition?.inputs?.[ref[1]];
  if (Array.isArray(input?.enum)) return { values: input.enum.filter(value => typeof value === "string"), unresolved: false };
  if (typeof input?.default === "string") return { values: [input.default], unresolved: false };
  return { values: [], unresolved: true };
}

function resolveWorkflowDependencies(workflow, { registry, agentTools, moduleTools, ownerState = "enabled" } = {}) {
  const definition = workflow?.definition || workflow || {};
  const registered = workflow?.state === undefined || workflow.state === "registered";
  const rows = [];
  const problems = [];
  if (!registered) problems.push(`workflow ${definition.name || workflow?.name || "<unknown>"} is ${workflow.state}`);
  if (ownerState !== "enabled") problems.push(`workflow ${definition.name || workflow?.name || "<unknown>"} owner pack is ${ownerState}`);
  for (const step of definition.steps || []) {
    const requested = step.tool;
    // Alias/adaptor resolution is exclusively through the canonical registry.
    const descriptor = registry?.get(requested) || null;
    const canonical = descriptor ? cleanToolName(descriptor.name) : null;
    const exposed = canonical ? (agentTools instanceof Map ? agentTools.get(canonical) : agentTools?.[canonical]) : null;
    let status = "available";
    let reason = null;
    const moduleOwner = moduleTools instanceof Map ? moduleTools.get(cleanToolName(requested)) : moduleTools?.[cleanToolName(requested)];
    if (!descriptor && moduleOwner) { status = "disabled"; reason = `owning module ${moduleOwner.name} is ${moduleOwner.state} and the tool is unavailable`; }
    else if (!descriptor) { status = "missing"; reason = `tool ${requested} is not registered in the canonical registry`; }
    else if (!exposed) { status = "not_agent_visible"; reason = `tool ${canonical} is not visible to source=agent`; }
    else if (exposed.enabled === false || exposed.available === false) {
      status = "disabled";
      reason = exposed.policy || exposed.availability?.reasons?.join(", ") || `tool ${canonical} is disabled for source=agent`;
    }
    if (reason) problems.push(`workflow ${definition.name || workflow?.name || "<unknown>"} step ${step.name}: missing capability ${requested} (${reason})`);

    const actions = stepActionValues(definition, step);
    const description = descriptor?.argumentDescriptions?.action || descriptor?.args?.action || exposed?.argumentDescriptions?.action || exposed?.args?.action;
    const allowedActions = parseActionOptions(description) || actionOptionsFromSchema(descriptor);
    let actionStatus = "not_applicable";
    let actionReason = null;
    if (actions.unresolved) actionStatus = "input_dependent";
    else if (actions.values.length && !allowedActions) actionStatus = "unverifiable";
    else if (actions.values.length && allowedActions) {
      const unsupported = actions.values.filter(action => !allowedActions.includes(action));
      if (unsupported.length) {
        actionStatus = "unavailable";
        actionReason = `unsupported action(s): ${unsupported.join(", ")}; supported: ${allowedActions.join(", ")}`;
        problems.push(`workflow ${definition.name || workflow?.name || "<unknown>"} step ${step.name}: ${actionReason}`);
      } else actionStatus = "available";
    }
    rows.push({ step: step.name, requested, canonical, dependency_status: status, reason, action_values: actions.values, action_status: actionStatus, action_reason: actionReason });
  }
  return { ok: problems.length === 0, workflow: definition.name || workflow?.name || null, dependencies: rows, problems };
}

function loadRuntimeCatalog() {
  const tools = require("../src/tools");
  const workflowRepository = require("../src/workflows/repository");
  const packRepository = require("../src/packs/repository");
  const moduleRepository = require("../src/modules/repository");
  const registry = tools.getBuiltinRegistry();
  const agentDefinitions = tools.getToolDefsForSource("agent");
  const capabilityRows = require("../src/capabilities/catalog").project({ source: "agent", kind: "tool", limit: 500 }).entries;
  const byName = new Map(capabilityRows.map(row => [cleanToolName(row.name), row]));
  const agentTools = new Map(agentDefinitions.map(definition => {
    const descriptor = registry.get(definition.name);
    const canonical = cleanToolName(descriptor?.name || definition.name);
    const catalogEntry = byName.get(canonical);
    return [canonical, { ...definition, enabled: definition.enabled !== false, available: catalogEntry?.available === true, availability: catalogEntry?.availability, policy: definition.policy }];
  }));
  const workflows = workflowRepository.listWorkflowDefinitions();
  const packs = packRepository.listPacks();
  const modules = moduleRepository.listModules();
  const moduleTools = new Map();
  for (const module of modules) for (const tool of Object.keys(module.manifest?.tools || {})) moduleTools.set(cleanToolName(tool), { name: module.name, state: module.state });
  const packLifecycle = require("../src/packs/lifecycle");
  const effectivePacks = packs.map(pack => {
    const health = packLifecycle.describe(pack.name, { includeHealth: true }).health;
    return { ...pack, available: pack.state === "enabled" && health?.ok === true, availability: { reasons: [...(pack.state === "enabled" ? [] : [`pack_state:${pack.state}`]), ...(health?.ok ? [] : [`health:${health?.status || "unknown"}`])] } };
  });
  return { registry, agentDefinitions, agentTools, workflows, packs: effectivePacks, modules, moduleTools };
}

function workflowOwnerState(workflow, packs) {
  if (workflow.owner_kind !== "pack") return "enabled";
  const owner = packs.find(pack => pack.name === workflow.owner_name);
  if (!owner) return "not_installed";
  if (owner.available === false) return owner.availability?.reasons?.join(",") || owner.state;
  return owner.state;
}

function resolveAllWorkflows(workflows, runtime) {
  return workflows.map(workflow => resolveWorkflowDependencies(workflow, {
    registry: runtime.registry,
    agentTools: runtime.agentTools,
    moduleTools: runtime.moduleTools,
    ownerState: workflowOwnerState(workflow, runtime.packs),
  }));
}

function buildWorkflowMetadata(runtime) {
  return buildAgentCapabilityMetadata({
    packs: runtime.packs.filter(pack => pack.state === "enabled" && pack.available !== false),
    modules: runtime.modules.filter(module => ["enabled", "healthy"].includes(module.state)),
    workflows: runtime.workflows.map(workflow => workflowOwnerState(workflow, runtime.packs) === "enabled" ? workflow : { ...workflow, state: "disabled" }),
  });
}

function runOffline({ owner, goal, expectAction = "", expectTool = "", runtime = loadRuntimeCatalog() }) {
  const workflows = runtime.workflows.filter(record => record.owner_kind === "pack" && record.owner_name === owner);
  const dependencyResults = workflows.map(workflow => resolveWorkflowDependencies(workflow, {
    registry: runtime.registry,
    agentTools: runtime.agentTools,
    moduleTools: runtime.moduleTools,
    ownerState: workflowOwnerState(workflow, runtime.packs),
  }));
  const metadata = buildWorkflowMetadata(runtime);
  // Ranking deliberately uses the complete Agent-visible source catalog—not
  // only the expected pack's tools or the workflow's own dependencies.
  const candidates = discoverCapabilities(goal, runtime.agentDefinitions.filter(def => def.enabled !== false), { limit: 12, metadata });
  const prompt = buildPlannerSystemPrompt(candidates, null, metadata);
  const failures = [];
  if (!workflows.length) failures.push(`pack ${owner} has no workflows in the canonical workflow registry`);
  for (const result of dependencyResults) failures.push(...result.problems);
  if (expectAction && !prompt.includes(expectAction)) failures.push(`expected action '${expectAction}' was not rendered in the Agent planner prompt`);
  if (expectTool && !candidates.some(tool => cleanToolName(tool.name) === cleanToolName(expectTool))) failures.push(`expected tool '${expectTool}' was not ranked in the full Agent-visible shortlist`);
  return {
    owner,
    goal,
    stages: {
      dependency_resolution: { ok: dependencyResults.every(item => item.ok), workflows: dependencyResults },
      discovery_and_ranking: { catalog_size: runtime.agentDefinitions.filter(def => def.enabled !== false).length, shortlist_size: candidates.length, candidates: candidates.map(tool => tool.name), full_catalog_used: true },
      action_availability: { workflows: dependencyResults.map(item => ({ workflow: item.workflow, steps: item.dependencies.map(step => ({ step: step.step, action_values: step.action_values, status: step.action_status, reason: step.action_reason })) })) },
      dispatch: { state: "not_run", reason: "offline mode validates registry and planner metadata only; no workflow or tool was dispatched" },
    },
    expected_action: expectAction || null,
    expected_tool: expectTool || null,
    failures,
    metadata_ok: failures.length === 0,
  };
}

function parseArgs(argv) {
  const options = { live: false, agentUrl: "http://127.0.0.1:4099", expectAction: "", expectTool: "" };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--live") options.live = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--agent-url") options.agentUrl = argv[++index] || options.agentUrl;
    else if (arg.startsWith("--agent-url=")) options.agentUrl = arg.slice("--agent-url=".length);
    else if (arg === "--expect-action") options.expectAction = argv[++index] || "";
    else if (arg.startsWith("--expect-action=")) options.expectAction = arg.slice("--expect-action=".length);
    else if (arg === "--expect-tool") options.expectTool = argv[++index] || "";
    else if (arg.startsWith("--expect-tool=")) options.expectTool = arg.slice("--expect-tool=".length);
    else positional.push(arg);
  }
  return { options, positional };
}

function loadPackIdentity(directory) {
  const manifestPath = path.join(directory, "sidekick.pack.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof manifest.name !== "string" || !manifest.name) throw new Error("Pack manifest has no valid name");
  return manifest.name;
}

async function runLive(goal, options) {
  const base = options.agentUrl.replace(/\/$/, "");
  const created = await fetch(`${base}/api/agent/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }) });
  if (!created.ok) throw new Error(`Agent run request failed: HTTP ${created.status}`);
  const task = await created.json();
  if (!task.taskId) throw new Error("Agent run response did not contain taskId");
  const deadline = Date.now() + 120000;
  let transcript = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/agent/run/${encodeURIComponent(task.taskId)}`);
    if (response.ok) {
      transcript = await response.json();
      if (["completed", "failed", "cancelled", "iteration_limit", "waiting_for_approval"].includes(transcript.status)) break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!transcript) throw new Error(`Agent task ${task.taskId} did not publish a transcript before timeout`);
  const toolSteps = (Array.isArray(transcript.steps) ? transcript.steps : []).filter(step => step?.type === "tool");
  return { task_id: task.taskId, status: transcript.status, tool_steps: toolSteps.map(step => ({ tool: step.tool, action: step.args?.action || step.action || null, ok: step.ok !== false && !step.error })), dispatched_tools: toolSteps.map(step => step.tool).filter(Boolean), dispatch_succeeded: transcript.status === "completed" && toolSteps.some(step => step.ok !== false && !step.error), result: String(transcript.result || transcript.error || "").slice(0, 1000) };
}

async function main(argv = process.argv.slice(2)) {
  const { options, positional } = parseArgs(argv);
  if (options.help || positional.length < 2) {
    console.log("Usage: node scripts/agent-workflow-smoke.js <pack-path> <goal> [options]");
    console.log("Options: --expect-action <action> --expect-tool <tool> --live --agent-url <url>");
    return options.help ? 0 : 2;
  }
  const packDirectory = path.resolve(root, positional[0]);
  const goal = positional.slice(1).join(" ");
  const failures = [];
  let output = {};
  try {
    const owner = loadPackIdentity(packDirectory);
    const offline = runOffline({ owner, goal, expectAction: options.expectAction, expectTool: options.expectTool });
    output = { offline };
    failures.push(...offline.failures);
    if (options.live) {
      output.stages = { ...offline.stages, dispatch: { state: "running" } };
      output.live = await runLive(goal, options);
      output.stages.dispatch = { state: output.live.dispatch_succeeded ? "passed" : "failed", ...output.live };
      if (!output.live.dispatch_succeeded) failures.push(`live Agent did not complete a successful tool-backed task (status: ${output.live.status})`);
      if (options.expectTool && !output.live.dispatched_tools.some(tool => cleanToolName(tool) === cleanToolName(options.expectTool))) failures.push(`live Agent did not dispatch expected tool '${options.expectTool}'`);
      if (options.expectAction && !output.live.tool_steps.some(step => cleanToolName(step.tool) === cleanToolName(options.expectTool) && step.action === options.expectAction && step.ok)) failures.push(`live Agent did not successfully dispatch expected action '${options.expectAction}' on '${options.expectTool || "the expected tool"}'`);
    } else output.stages = offline.stages;
  } catch (error) {
    failures.push(error.message);
  }
  output.ok = failures.length === 0;
  if (failures.length) output.failures = failures;
  console.log(JSON.stringify(output, null, 2));
  return failures.length ? 1 : 0;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(JSON.stringify({ ok: false, failures: [String(error.message || error)] }, null, 2));
  process.exitCode = 1;
});

module.exports = { cleanToolName, parseActionOptions, actionOptionsFromSchema, stepActionValues, resolveWorkflowDependencies, loadRuntimeCatalog, resolveAllWorkflows, workflowOwnerState, runOffline, parseArgs, loadPackIdentity, runLive, main };
