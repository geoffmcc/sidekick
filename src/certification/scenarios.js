"use strict";

const THEMES = Object.freeze([
  ["repository-path", "inspect a real repository code path", ["read", "respond"], "hermetic"],
  ["repository-profile", "profile a repository with dev_repo_profile", ["dev_repo_profile"], "hermetic"],
  ["semantic-search", "locate code with semantic_repo", ["semantic_repo"], "hermetic"],
  ["change-summary", "summarize a bounded change", ["dev_change_summary"], "hermetic"],
  ["repository-verify", "verify repository work with dev_verify", ["dev_verify"], "hermetic"],
  ["handoff-resume", "create and resume a handoff", ["handoff", "resume"], "hermetic"],
  ["research-session", "start and resume a security research session", ["research_project", "research_run"], "hermetic"],
  ["research-isolation", "preserve isolation between research projects", ["research_project", "research_scope"], "hermetic"],
  ["proxmox-read", "inspect an authorized lab with read-only Proxmox tools", ["proxmox"], "live"],
  ["network-scope", "reject an unauthorized network request", ["network_change", "network_scopes"], "hermetic"],
  ["mutation-approval", "request approval for a governed mutation", ["approval", "write"], "hermetic"],
  ["approval-resume", "resume correctly after approval", ["approval", "resume"], "hermetic"],
  ["cancel-terminal", "cancel a task and prevent later completion", ["cancel"], "hermetic"],
  ["restart-recovery", "recover after an Agent process restart", ["recovery_scan"], "hermetic"],
  ["ambiguous-effect", "park an ambiguous operation without repeating it", ["receipt", "recovery_scan"], "hermetic"],
  ["multi-pack", "use multiple compatible capability packs", ["dev_repo_profile", "research_status"], "hermetic"],
  ["result-vocabulary", "distinguish success, failure, unsupported, unknown, and partial", ["respond"], "hermetic"],
  ["verification-gate", "refuse completion when verification fails", ["dev_verify"], "hermetic"],
  ["child-authority", "create a bounded child task", ["act_on"], "hermetic"],
  ["provider-malformed", "handle provider failure or malformed model output", ["llm"], "live"],
]);

const ASSERTIONS = Object.freeze({
  "repository-path": "registry_tool",
  "repository-profile": "expected_tools",
  "semantic-search": "expected_tools",
  "change-summary": "expected_tools",
  "repository-verify": "expected_tools",
  "handoff-resume": "context_scope",
  "research-session": "expected_tools",
  "research-isolation": "expected_tools",
  "network-scope": "expected_tools",
  "mutation-approval": "approval_contract",
  "approval-resume": "approval_contract",
  "cancel-terminal": "outcome_contract",
  "restart-recovery": "cleanup_contract",
  "ambiguous-effect": "fault_contract",
  "multi-pack": "expected_tools",
  "result-vocabulary": "outcome_contract",
  "verification-gate": "evidence_contract",
  "child-authority": "expected_tools",
});

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

const scenarios = freeze(THEMES.map(([id, title, expectedTools, mode], index) => {
  const forbiddenTools = ["executeAuthorizedTaskStep", "tools-legacy"];
  const bounded = { max_output_chars: 2000, max_steps: id === "repository-path" ? 2 : 1, max_evidence: 4 };
  const approval = {
    required: ["approval-required", "approval-no-bypass", "mutation-approval", "approval-resume"].includes(id),
    bypass_allowed: false,
  };
  const evidence = {
    required: ["evidence-required", "evidence-attribution", "live-outcome", "verification-gate"].includes(id),
    attributable: true,
    max_items: 4,
  };
  const outcome = {
    expected: id === "outcome-failure" || id === "fault-dispatch" || id === "fault-policy" || id === "provider-malformed" || id === "ambiguous-effect" ? "failed" : "passed",
    terminal: true,
  };
  const cleanup = { required: !["hermetic-registry", "bounded-metadata", "redaction"].includes(id), idempotent: true, external_mutation: false };
  const fixture = id === "repository-path"
    ? [
      { name: "read", args: { path: require("path").join(__dirname, "../../docs/system-certification.md") } },
      { name: "respond", args: { text: "certification fixture verified" } },
    ]
    : id === "result-vocabulary"
      ? [{ name: "respond", args: { text: "certification fixture verified" } }]
      : null;
  return {
  id: `agent-cert.v1.${id}`,
  version: 1,
  title,
  theme: id,
   mode,
   classification: mode,
   objective: title,
   required_initial_state: { project: "agent-certification", workspace: "workspace:agent-certification", task: "new" },
   identity: { principal: "certification-principal", authority: "bounded-test-envelope" },
   enabled_capability_packs: [...new Set(expectedTools.map(name => name.startsWith("research_") ? "security-research" : ["dev_repo_profile", "semantic_repo", "dev_change_summary", "dev_verify"].includes(name) ? "developer" : name === "proxmox" ? "proxmox" : null).filter(Boolean))],
   model_provider: mode === "live" ? { provider: "local", required: true } : { provider: "hermetic", required: false },
   allowed_retries: 1,
   time_budget_ms: 120000,
  bounded,
  boundedMetadata: bounded,
  expected_tools: expectedTools,
  expectedTools,
  forbidden_tools: forbiddenTools,
  forbiddenTools,
  approval,
  approvalContract: approval,
  evidence,
  evidenceContract: evidence,
  outcome,
  outcomeContract: outcome,
   fault_point: ["fault-dispatch", "fault-policy", "ambiguous-effect"].includes(id) ? id : null,
   faultPoint: ["fault-dispatch", "fault-policy", "ambiguous-effect"].includes(id) ? id : null,
   cleanup,
   cleanupContract: cleanup,
    fixture,
    assertion: ASSERTIONS[id] || (mode === "live" ? "live_provider" : "metadata_bounds"),
  };
}));

function listScenarios({ mode, theme } = {}) {
  return scenarios.filter(scenario => (!mode || scenario.mode === mode) && (!theme || scenario.theme === theme)).map(scenario => ({ ...scenario }));
}

module.exports = { scenarios, listScenarios };
