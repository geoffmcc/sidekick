"use strict";

const { z } = require("zod");
const { scenarios, listScenarios } = require("./scenarios");
const { sanitize } = require("./reports");
const { dispatchTestTool } = require("../tools/dispatcher");
const { getBuiltinRegistry } = require("../tools");

const fixtureSchema = z.object({ text: z.string() });

function result(scenario, status, reason, details = {}) {
  return { id: scenario.id, version: scenario.version, mode: scenario.mode, status, reason: reason || null, details: sanitize(details) };
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
      const descriptor = registry.get("respond");
      if (!descriptor) return "canonical respond tool is unavailable";
      const dispatched = await dispatchTestTool({ descriptor, args: { text: "certification" }, context: { source: "test", project: "agent-certification" } });
      return dispatched.isError || dispatched.content?.[0]?.text !== "certification" ? "canonical dispatcher assertion failed" : null;
    }
    case "metadata_bounds": return null;
    case "expected_tools": {
      const missing = scenario.expected_tools.filter(tool => !registry.get(tool)).slice(0, 16);
      if (missing.length) return `expected tools unavailable: ${missing.join(", ")}`;
      return null;
    }
    case "forbidden_tools": return registry.get("executeAuthorizedTaskStep") ? "privileged runner seam is exposed in registry" : null;
    case "approval_contract": return scenario.approval.required && !scenario.approval.bypass_allowed ? null : "approval contract is incomplete";
    case "evidence_contract": return scenario.evidence.required && scenario.evidence.attributable ? null : "evidence contract is incomplete";
    case "outcome_contract": return scenario.outcome.terminal ? null : "outcome is not terminal";
    case "cleanup_contract": return scenario.cleanup.required && scenario.cleanup.idempotent ? null : "cleanup contract is incomplete";
    case "context_scope": return scenario.mode === "hermetic" ? null : "context scenario is not hermetic";
    case "redaction": return sanitize({ token: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456" }).token === "[REDACTED]" ? null : "redaction failed";
    case "unknown_tool": return registry.get("definitely_missing_certification_tool") ? "unknown tool resolved" : null;
    case "schema_validation": return fixtureSchema.safeParse({}).success ? "schema accepted invalid input" : null;
    case "fault_contract": return scenario.fault_point && scenario.outcome.expected === "failed" ? null : "fault does not fail closed";
    default: return scenario.expected_tools.length ? null : "scenario has no expected behavior";
  }
}

async function runLiveScenario(scenario, availability) {
  const available = typeof availability === "function" ? await availability(scenario) : Boolean(availability);
  if (!available) return result(scenario, "skipped", "live provider unavailable");
  return result(scenario, "blocked", "live execution requires an explicit live executor");
}

async function runCertification({ scenarioIds, mode, theme, availability = false, registry = getBuiltinRegistry() } = {}) {
  const selected = listScenarios({ mode, theme }).filter(scenario => !scenarioIds || scenarioIds.includes(scenario.id));
  const results = [];
  for (const scenario of selected) {
    if (scenario.mode === "live") {
      results.push(await runLiveScenario(scenario, availability));
      continue;
    }
    try {
      const reason = await assertScenario(scenario, registry);
      const blocked = reason && reason.startsWith("expected tools unavailable:");
      results.push(reason
        ? result(scenario, blocked ? "blocked" : "failed", reason)
        : result(scenario, "passed", null, { dispatcher: "canonical", registry: "canonical" }));
    } catch (error) {
      results.push(result(scenario, "blocked", "certification assertion could not run", { error: error.message }));
    }
  }
  const summary = Object.fromEntries(["total", "passed", "failed", "skipped", "blocked"].map(key => [key, key === "total" ? results.length : results.filter(item => item.status === key).length]));
  const verdict = summary.failed ? "failed" : summary.blocked ? "blocked" : "passed";
  return sanitize({ schema: "sidekick.agent-certification.v1", version: 1, generated_at: new Date().toISOString(), mode: mode || "all", verdict, summary, results });
}

module.exports = { runCertification };
