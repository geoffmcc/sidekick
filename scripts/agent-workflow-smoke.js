"use strict";

// Developer diagnostic for generic Agent capability discovery.
//
// Offline mode reads repository pack metadata only. --live additionally uses
// the Agent Bridge HTTP API and is intended to run on the Sidekick host (or
// with --agent-url pointing at an authorized test endpoint). No credentials,
// raw tool output, or hidden reasoning are collected.

const fs = require("fs");
const path = require("path");
const { discoverCapabilities, buildAgentCapabilityMetadata } = require("../src/agent/capability-broker");
const { buildPlannerSystemPrompt } = require("../src/brain");

const root = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const options = { live: false, agentUrl: "http://127.0.0.1:4099", expectAction: "", expectTool: "" };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--live") options.live = true;
  else if (arg === "--help" || arg === "-h") options.help = true;
  else if (arg === "--agent-url") options.agentUrl = argv[++i] || options.agentUrl;
  else if (arg.startsWith("--agent-url=")) options.agentUrl = arg.slice("--agent-url=".length);
  else if (arg === "--expect-action") options.expectAction = argv[++i] || "";
  else if (arg.startsWith("--expect-action=")) options.expectAction = arg.slice("--expect-action=".length);
  else if (arg === "--expect-tool") options.expectTool = argv[++i] || "";
  else if (arg.startsWith("--expect-tool=")) options.expectTool = arg.slice("--expect-tool=".length);
  else positional.push(arg);
}

if (options.help || positional.length < 2) {
  console.log("Usage: node scripts/agent-workflow-smoke.js <pack-path> <goal> [options]");
  console.log("Options: --expect-action <action> --expect-tool <tool> --live --agent-url <url>");
  process.exit(options.help ? 0 : 2);
}

const packDir = path.resolve(root, positional[0]);
const goal = positional.slice(1).join(" ");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

function loadPack(dir) {
  const manifest = readJson(path.join(dir, "sidekick.pack.json"));
  const modules = [];
  const tools = [];
  for (const ref of manifest.modules || []) {
    const moduleManifest = readJson(path.join(dir, ref.path, "manifest.json"));
    modules.push({ name: moduleManifest.name, manifest: moduleManifest });
    for (const [name, details] of Object.entries(moduleManifest.tools || {})) {
      tools.push({
        name,
        enabled: true,
        risk: details.risk || "medium",
        description: moduleManifest.description || `${name} capability`,
        args: { action: "string" },
      });
    }
  }
  const workflows = (manifest.workflows || []).map(ref => ({
    state: "registered",
    definition: readJson(path.join(dir, ref.path)),
  }));
  return { manifest, modules, tools, workflows };
}

function runOffline(pack) {
  const metadata = buildAgentCapabilityMetadata({
    packs: [{ ...pack.manifest, state: "enabled", manifest: pack.manifest }],
    modules: pack.modules,
    workflows: pack.workflows,
  });
  const candidates = discoverCapabilities(goal, pack.tools, { limit: 12, metadata });
  const prompt = buildPlannerSystemPrompt(candidates, null, metadata);

  if (options.expectAction) check(prompt.includes(options.expectAction), `expected action '${options.expectAction}' was not rendered in the planner prompt`);
  if (options.expectTool) check(candidates.some(tool => tool.name === options.expectTool), `expected tool '${options.expectTool}' was not shortlisted`);

  // Generic risk-ordering check: observation must prefer a read-only tool over
  // a control tool, without naming any real pack.
  const riskCandidates = discoverCapabilities("Is anything currently playing?", [
    { name: "example_control", description: "Control playback sessions", risk: "high", enabled: true },
    { name: "example_read", description: "Read-only playback session status", risk: "low", enabled: true },
  ], { limit: 2 });
  check(riskCandidates[0]?.name === "example_read", "observation did not rank the low-risk capability first");

  // Synthetic third-party workflow check: action semantics must reach Brain
  // without any Agent-specific pack knowledge.
  const syntheticMetadata = buildAgentCapabilityMetadata({
    workflows: [{ state: "registered", definition: {
      name: "example-frobnicator/status", title: "Frobnicator status", description: "Read current Frobnicator status",
      tags: ["frobnicator", "read-only"], steps: [{ title: "Current status", tool: "frobnicator", args: { action: "read_status", secret: "excluded" } }],
    } }],
  });
  const syntheticPrompt = buildPlannerSystemPrompt([
    { name: "frobnicator", enabled: true, risk: "low", description: "Frobnicator operations", args: { action: "string" } },
  ], null, syntheticMetadata);
  check(syntheticPrompt.includes("read_status"), "synthetic third-party workflow action was not rendered");
  check(!syntheticPrompt.includes("excluded"), "non-semantic workflow argument leaked into prompt metadata");

  return {
    pack: pack.manifest.name,
    goal,
    candidates: candidates.map(tool => tool.name),
    expected_action: options.expectAction || null,
    expected_tool: options.expectTool || null,
    action_visible: options.expectAction ? prompt.includes(options.expectAction) : null,
    synthetic_action_visible: syntheticPrompt.includes("read_status"),
    risk_ordering: riskCandidates.map(tool => tool.name),
  };
}

async function runLive() {
  const base = options.agentUrl.replace(/\/$/, "");
  const created = await fetch(`${base}/api/agent/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal }),
  });
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

  const steps = Array.isArray(transcript.steps) ? transcript.steps : [];
  const tools = steps.filter(step => step && step.type === "tool").map(step => step.tool).filter(Boolean);
  const evidence = steps.find(step => step && step.type === "evidence_ledger");
  if (options.expectTool) check(tools.includes(options.expectTool), `live Agent did not call expected tool '${options.expectTool}'`);
  if (options.expectAction) check(tools.length > 0, "live Agent produced no tool step for the expected evidence request");

  return {
    task_id: task.taskId,
    status: transcript.status,
    result: String(transcript.result || transcript.error || "").slice(0, 1000),
    tools,
    evidence_entries: Array.isArray(evidence?.entries) ? evidence.entries.length : 0,
  };
}

(async () => {
  let output;
  try {
    const pack = loadPack(packDir);
    output = { offline: runOffline(pack) };
    if (options.live) output.live = await runLive();
  } catch (error) {
    failures.push(error.message);
  }
  output = output || {};
  output.ok = failures.length === 0;
  if (failures.length) output.failures = failures;
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = failures.length ? 1 : 0;
})();
