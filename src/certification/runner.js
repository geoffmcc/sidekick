"use strict";

const { z } = require("zod");
const { scenarios, listScenarios } = require("./scenarios");
const { sanitize } = require("./reports");
const { dispatchTool } = require("../tools/dispatcher");
const { createTestExecutionContext } = require("../tools/context");
const { getBuiltinRegistry } = require("../tools");

const fixtureSchema = z.object({ text: z.string() });

function result(scenario, status, reason, details = {}) {
  return { id: scenario.id, version: scenario.version, mode: scenario.mode, status, reason: reason || null, details: sanitize(details) };
}

function isExecutableDescriptor(descriptor) {
  return Boolean(descriptor && typeof descriptor === "object"
    && descriptor.schema && typeof descriptor.schema.safeParse === "function"
    && typeof descriptor.handler === "function");
}

async function assertScenario(scenario, registry) {
  if (scenario.bounded.max_output_chars > 10000 || scenario.bounded.max_steps > 8 || scenario.bounded.max_evidence > 16) return "metadata exceeds certification bounds";
  if (!Array.isArray(scenario.expected_tools) || !Array.isArray(scenario.forbidden_tools)) return "tool expectations are not arrays";
  if (scenario.forbidden_tools.some(tool => scenario.expected_tools.includes(tool))) return "tool is both expected and forbidden";
  if (scenario.approval.bypass_allowed) return "approval bypass is enabled";
  if (scenario.evidence.max_items > scenario.bounded.max_evidence) return "evidence bound is inconsistent";
  if (scenario.cleanup.external_mutation) return "certification cleanup may mutate external state";
  switch (scenario.assertion) {
    case "registry_tool": {
      if (!isExecutableDescriptor(registry.get("respond"))) return "canonical respond tool is unavailable";
      return executeFixture(scenario, registry);
    }
    case "metadata_bounds": return executeFixture(scenario, registry);
    case "expected_tools": {
      const missing = scenario.expected_tools.filter(tool => !isExecutableDescriptor(registry.get(tool))).slice(0, 16);
      if (missing.length) return `expected tools unavailable: ${missing.join(", ")}`;
      return executeFixture(scenario, registry);
    }
    case "forbidden_tools": return registry.get("executeAuthorizedTaskStep") ? "privileged runner seam is exposed in registry" : executeFixture(scenario, registry);
    case "approval_contract": return scenario.approval.required && !scenario.approval.bypass_allowed ? executeFixture(scenario, registry) : "approval contract is incomplete";
    case "evidence_contract": return scenario.evidence.required && scenario.evidence.attributable ? executeFixture(scenario, registry) : "evidence contract is incomplete";
    case "outcome_contract": return scenario.outcome.terminal ? executeFixture(scenario, registry) : "outcome is not terminal";
    case "cleanup_contract": return scenario.cleanup.required && scenario.cleanup.idempotent ? executeFixture(scenario, registry) : "cleanup contract is incomplete";
    case "context_scope": return scenario.mode === "hermetic" ? executeFixture(scenario, registry) : "context scenario is not hermetic";
    case "redaction": return sanitize({ token: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456" }).token === "[REDACTED]" ? executeFixture(scenario, registry) : "redaction failed";
    case "unknown_tool": return registry.get("definitely_missing_certification_tool") ? "unknown tool resolved" : executeFixture(scenario, registry);
    case "schema_validation": return fixtureSchema.safeParse({}).success ? "schema accepted invalid input" : executeFixture(scenario, registry);
    case "fault_contract": return scenario.fault_point && scenario.outcome.expected === "failed" ? executeFixture(scenario, registry) : "fault does not fail closed";
    default: return scenario.expected_tools.length ? executeFixture(scenario, registry) : "scenario has no expected behavior";
  }
}

async function executeFixture(scenario, registry) {
  if (!Array.isArray(scenario.fixture) || scenario.fixture.length === 0) return "no deterministic hermetic fixture is defined";
  if (scenario.fixture.length > scenario.bounded.max_steps) return "fixture exceeds scenario step bound";
  const expected = new Set(scenario.expected_tools);
  const observed = [];
  for (const step of scenario.fixture) {
    const name = String(step.name || "");
    if (!expected.has(name)) return `fixture tool is not declared expected: ${name}`;
    if (!isExecutableDescriptor(registry.get(name))) return `expected tools unavailable: ${name}`;
    const dispatched = await dispatchTool({
      name,
      args: step.args || {},
      context: createTestExecutionContext({ project: "agent-certification", correlationId: scenario.id }),
    });
    if (!dispatched || dispatched.isError) return `canonical dispatcher fixture failed for ${name}`;
    observed.push(name);
  }
  const missing = scenario.expected_tools.filter(name => !observed.includes(name));
  return missing.length ? `expected tools were not exercised: ${missing.join(", ")}` : null;
}

async function runLiveScenario(scenario, availability, liveExecutor) {
  const available = typeof availability === "function" ? await availability(scenario) : Boolean(availability);
  if (!available) return result(scenario, "skipped", "live provider unavailable");
  if (!liveExecutor || typeof liveExecutor.run !== "function") return result(scenario, "blocked", "live execution requires an explicit live executor");
  try {
    const observed = await liveExecutor.run(scenario);
    const terminal = observed && observed.timeout !== true && observed.state && ["completed", "partial", "failed", "cancelled", "timed_out", "blocked"].includes(observed.state);
    if (!terminal) return result(scenario, "blocked", "live executor did not return a terminal durable task", { observed });
    if (observed.source !== "durable_task_store") return result(scenario, "failed", "live executor did not provide the authoritative durable projection", { observed });
    if (!Array.isArray(observed.events)) return result(scenario, "failed", "live executor did not provide durable task events", { observed });
    const dispatchTotal = Number(observed.dispatch_counts?.total || 0);
    if (!Number.isInteger(dispatchTotal) || dispatchTotal < 1 || dispatchTotal > scenario.bounded.max_steps) {
      return result(scenario, "failed", "live executor did not provide a bounded dispatch", { observed });
    }
    const observedTools = new Set([
      ...(Array.isArray(observed.receipts) ? observed.receipts.map(item => String(item.capability || "")) : []),
      ...(Array.isArray(observed.events) ? observed.events.map(item => String(item.tool_name || item.capability || "")) : []),
    ].filter(Boolean));
    const forbidden = scenario.forbidden_tools.filter(tool => observedTools.has(tool) || observedTools.has(`sidekick_${tool}`));
    if (forbidden.length) return result(scenario, "failed", `forbidden tools were selected: ${forbidden.join(", ")}`, { observed });
    const missingExpected = scenario.expected_tools.filter(tool => !observedTools.has(tool) && !observedTools.has(`sidekick_${tool}`));
    if (missingExpected.length) return result(scenario, "failed", `expected tools were not observed: ${missingExpected.join(", ")}`, { observed });
    const expectedFailure = scenario.outcome.expected === "failed";
    const passed = expectedFailure
      ? ["failed", "blocked"].includes(observed.state)
      : observed.state === "completed" && observed.result?.status === "verified";
    return result(scenario, passed ? "passed" : "failed", passed ? null : `unexpected live task state: ${observed.state}`, { observed });
  } catch (error) {
    return result(scenario, "failed", "live certification execution failed", { error: error.message });
  }
}

async function runCertification({ scenarioIds, mode, theme, availability = false, liveExecutor = null, registry = getBuiltinRegistry() } = {}) {
  const selected = listScenarios({ mode, theme }).filter(scenario => !scenarioIds || scenarioIds.includes(scenario.id));
  const results = [];
  for (const scenario of selected) {
    if (scenario.mode === "live") {
      results.push(await runLiveScenario(scenario, availability, liveExecutor));
      continue;
    }
    try {
      const reason = await assertScenario(scenario, registry);
      const blocked = reason && (reason.startsWith("expected tools unavailable:") || reason === "no deterministic hermetic fixture is defined");
      results.push(reason
        ? result(scenario, blocked ? "blocked" : "failed", reason)
        : result(scenario, "passed", null, { dispatcher: "canonical", fixture: true }));
    } catch (error) {
      results.push(result(scenario, "blocked", "certification assertion could not run", { error: error.message }));
    }
  }
  const summary = Object.fromEntries(["total", "passed", "failed", "skipped", "blocked"].map(key => [key, key === "total" ? results.length : results.filter(item => item.status === key).length]));
  const verdict = summary.failed ? "failed" : summary.blocked || summary.skipped ? "blocked" : "passed";
  const certificationLevel = mode === "live" ? "optional_live" : mode === "hermetic" ? "required_hermetic" : "combined";
  return sanitize({ schema: "sidekick.agent-certification.v1", version: 1, generated_at: new Date().toISOString(), mode: mode || "all", certification_level: certificationLevel, verdict, summary, results });
}

module.exports = { runCertification };
