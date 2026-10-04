const TOOL_RISK = {
  bash: "critical",
  write: "critical",
  db_restore: "critical",
  runbook: "critical",
  ops: "critical",
  mission: "critical",
  sandbox: "critical",
  evolve: "critical",
  process: "high",
  service: "high",
  cron: "high",
  delay: "high",
  watch: "high",
  github: "high",
  ci_status: "low",
  teach: "high",
  secret: "high",
  security_scan: "low",
  db_migrate: "high",
  queue: "high",
  orchestrate: "high",
  notify: "medium",
  read: "medium",
  archive: "medium",
  git: "medium",
  web_fetch: "medium",
  llm: "medium",
  context: "medium",
  session: "medium",
  handoff: "medium",
  memory: "medium",
  memory_export: "low",
  memory_import: "medium",
  memory_manage: "medium",
  sync_identity: "low",
  sync_export: "low",
  sync_import: "medium",
  sync_diff: "low",
  health: "high",
  snapshot: "medium",
  retry: "medium",
  fresheyes: "medium",
  batch: "medium",
  tail: "medium",
  find: "medium",
  status: "medium",
  extract: "medium",
  changelog: "medium",
  netdiag: "high",
  timeline: "medium",
  circuit: "medium",
  baseline: "high",
  depend: "medium",
  black_box: "medium",
  db_query: "medium",
  db_backup: "medium",
  db_export: "medium",
  redis: "medium",
  ocr: "medium",
  media: "medium",
  transcribe: "medium",
  analytics: "medium",
  insight_report: "low",
  embed: "low",
  ollama: "low",
  tunnel: "high",
  download: "medium",
  wireguard: "high",
  nginx: "high",
  tools: "low",
  respond: "low",
  list: "low",
  store: "low",
  get: "low",
  list_projects: "low",
  get_by_project: "low",
  search: "low",
  webhook: "low",
  transform: "low",
  parse: "low",
  diff: "low",
  hash: "low",
  validate: "low",
  template: "low",
  // medium, matching black_box: the purge action performs a bulk delete.
  predict: "medium",
  debug_tool: "low",
  cache: "low",
  summarize: "low",
  filter: "low",
  project: "low",
  diff_files: "low",
  anonymize: "low",
  db_schema: "low",
  db_stats: "low",
  log_query: "low",
  db_search: "low",
  db_diff: "low",
  knowledge: "low",
  compute: "medium",
  compute_nodes: "medium",
  // create/update select the endpoint inference traffic is sent to and set the
  // trust_level / data_classifications that placement gates on. These were
  // rated when both actions were inert (a parameter-mapping fault meant they
  // could never succeed); now that they work, the rating has to match.
  compute_providers: "high",
  compute_models: "medium",
  compute_jobs: "medium",
  compute_route: "medium",
  delete: "low",
  resume: "low",
  metrics: "low",
  module: "high",
  project_registry: "high",
  // Workspace writes provision project workspaces and manage encrypted
  // secrets; reads expose secret names (never values).
  workspace: "high",
  // Installing or enabling a capability pack activates third-party executable
  // module code inside the Sidekick process; that is a critical operation.
  capability: "critical",
  // A workflow run dispatches governed tool calls; each step's own tool risk
  // still applies on top of this at dispatch time.
  workflow: "high",
  // Health probes update connector state and emit health evidence events.
  connector: "medium",
  // Browser actions spend the server's network identity against arbitrary
  // sites and can mutate remote state (clicks, form submissions, uploads).
  // Read-level observation actions are downgraded in TOOL_ACTION_RISK.
  browser: "high",
};

const TOOL_CATEGORIES = {
  'bash': 'Core',
  'tools': 'Core',
  'read': 'Core',
  'write': 'Core',
  'list': 'Core',
  'search': 'Core',
  'web_fetch': 'Core',
  'respond': 'Core',
  'store': 'Storage',
  'get': 'Storage',
  'delete': 'Storage',
  'resume': 'Storage',
  'list_projects': 'Storage',
  'get_by_project': 'Storage',
  'redis': 'Storage',
  'db_schema': 'Database',
  'db_query': 'Database',
  'db_stats': 'Database',
  'db_backup': 'Database',
  'db_restore': 'Database',
  'db_export': 'Database',
  'db_search': 'Database',
  'db_migrate': 'Database',
  'db_diff': 'Database',
  'analytics': 'Database',
  'insight_report': 'Data Pipeline',
  'git': 'Git & GitHub',
  'github': 'Git & GitHub',
  'ci_status': 'Git & GitHub',
  'process': 'Services',
  'service': 'Services',
  'cron': 'Scheduling',
  'delay': 'Scheduling',
  'notify': 'Communication',
  'webhook': 'Communication',
  'context': 'Context & Learning',
  'session': 'Context & Learning',
  'handoff': 'Context & Learning',
  'memory': 'Context & Learning',
  'teach': 'Context & Learning',
  'memory_export': 'Context & Learning',
  'memory_import': 'Context & Learning',
  'memory_manage': 'Context & Learning',
  'sync_identity': 'Context & Learning',
  'sync_export': 'Context & Learning',
  'sync_import': 'Context & Learning',
  'sync_diff': 'Context & Learning',
  'transform': 'Data Pipeline',
  'parse': 'Data Pipeline',
  'diff': 'Data Pipeline',
  'hash': 'Data Pipeline',
  'validate': 'Data Pipeline',
  'template': 'Data Pipeline',
  'extract': 'Data Pipeline',
  'anonymize': 'Data Pipeline',
  'diff_files': 'Data Pipeline',
  'health': 'Monitoring',
  'status': 'Monitoring',
  'watch': 'Monitoring',
  'baseline': 'Monitoring',
  'snapshot': 'Monitoring',
  'timeline': 'Monitoring',
  'black_box': 'Monitoring',
  'log_query': 'Monitoring',
  'queue': 'Workflow',
  'retry': 'Workflow',
  'orchestrate': 'Workflow',
  'runbook': 'Workflow',
  'ops': 'Workflow',
  'mission': 'Workflow',
  'evolve': 'Meta',
  'predict': 'Meta',
  'debug_tool': 'Meta',
  'fresheyes': 'Meta',
  'batch': 'Efficiency',
  'cache': 'Efficiency',
  'summarize': 'Efficiency',
  'filter': 'Efficiency',
  'project': 'Efficiency',
  'tail': 'Efficiency',
  'find': 'Efficiency',
  'secret': 'Security',
  'security_scan': 'Security',
  'sandbox': 'Security',
  'tunnel': 'Networking',
  'wireguard': 'Networking',
  'nginx': 'Networking',
  'netdiag': 'Networking',
  'browser': 'Networking',
  'changelog': 'Development',
  'depend': 'Development',
  'circuit': 'Reliability',
  'archive': 'Archive',
  'ocr': 'Media',
  'media': 'Media',
  'transcribe': 'Media',
  'download': 'Media',
  'knowledge': 'Context & Learning',
  'metrics': 'Monitoring',
  'module': 'Services',
  'project_registry': 'Storage',
  'workspace': 'Storage',
  'capability': 'Services',
  'workflow': 'Services',
  'connector': 'Services',
  // Compute / inference subsystem. llm, embed and ollama are inference tools and
  // belong here rather than scattered across Core / Context & Learning.
  'llm': 'Compute',
  'embed': 'Compute',
  'ollama': 'Compute',
  'compute': 'Compute',
  'compute_nodes': 'Compute',
  'compute_providers': 'Compute',
  'compute_models': 'Compute',
  'compute_jobs': 'Compute',
  'compute_route': 'Compute',
};

const RISK_LEVELS = ["low", "medium", "high", "critical"];

function normalizeToolName(name) {
  return String(name || "").replace(/^sidekick_/, "");
}

function getStaticToolRisk(name) {
  const risk = TOOL_RISK[normalizeToolName(name)];
  if (!risk) throw new Error(`Missing risk metadata for tool: ${normalizeToolName(name)}`);
  return risk;
}

function getStaticToolCategory(name) {
  return TOOL_CATEGORIES[normalizeToolName(name)] || "Uncategorized";
}

function getToolEffectMetadata(name) {
  const canonical = normalizeToolName(name);
  const mapping = Object.prototype.hasOwnProperty.call(TOOL_ACTION_EFFECT, canonical) ? TOOL_ACTION_EFFECT[canonical] : null;
  const byAction = mapping ? Object.fromEntries(Object.entries(mapping).filter(([action]) => action !== "default").map(([action, effects]) => [action, [...effects]])) : {};
  let defaultEffects = mapping?.default ? [...mapping.default] : null;
  if (!defaultEffects) {
    const annotations = require("./annotations").getToolAnnotations(canonical);
    defaultEffects = annotations.readOnlyHint && !annotations.openWorldHint && !annotations.destructiveHint ? ["read_only"] : ["unknown"];
  }
  const conditional = (CONDITIONAL_TOOL_EFFECT[canonical] || []).map(rule => ({ ...rule, effects: [...rule.effects] }));
  return { source: mapping ? "declared_action_effects" : "conservative_default", default: defaultEffects, by_action: byAction, conditional };
}

/**
 * Per-action risk overrides for tools whose actions differ in danger.
 *
 * Risk was a per-TOOL label, which is wrong for a tool that both reads and
 * mutates. `capability` is the case that exposed it: installing or enabling a
 * pack executes third-party code in-process (correctly critical), but merely
 * LISTING packs is a read — and because the dashboard's Capabilities tab calls
 * `capability action="list"` on load, simply opening that tab filed a
 * critical-risk approval request. Rejecting it did not help; the tab refetched
 * and filed another.
 *
 * The damage is not the noise. It is that the operator learns `capability`
 * prompts are routine UI chatter, and the one prompt that genuinely matters —
 * an install activating unsandboxed third-party code — arrives looking exactly
 * like the twenty they already waved through. An approval control spent on
 * browsing is not protecting anything.
 *
 * Rules, all fail-closed:
 *   - Only actions listed here get a different risk. Anything unlisted,
 *     missing, or non-string keeps the tool-level risk.
 *   - Lookups are own-property only, so `__proto__`/`constructor` cannot
 *     inherit a truthy value and lower the risk of a mutating call.
 *   - This never applies to module-provided or generated tools: their risk is
 *     the risk of what actually executes, resolved before this table is
 *     consulted.
 *
 * Add an action here only when it cannot mutate state, spend credentials, or
 * execute foreign code. When unsure, leave it out — the cost of omitting one is
 * an extra prompt; the cost of adding one wrongly is a silent bypass.
 */
const TOOL_ACTION_RISK = Object.freeze({
  // Listing secret names is metadata-only and is separately authorized as
  // secrets.read_metadata. Secret disclosure and all mutations retain the
  // tool-level high risk.
  secret: Object.freeze({
    list: "low",
  }),
  knowledge: Object.freeze({
    promote: "high",
  }),
  // Read-only pack inspection. `inspect` is deliberately ABSENT: it reads a
  // caller-supplied path, so it keeps the tool-level risk.
  capability: Object.freeze({
    list: "low",
    available: "low",
    show: "low",
    health: "low",
  }),
  // Mixed project metadata surface. These actions only enumerate or inspect
  // registry rows; registration, archival, and backfill remain high risk.
  project_registry: Object.freeze({
    list: "low",
    get: "low",
    sources: "low",
  }),
  // `GET /api/capabilities/:name/workflows` dispatches `workflow action="list"`,
  // so viewing a pack's workflows is a read through a high-risk tool. It does
  // not prompt under the current risky mode (which gates on critical only), but
  // it would under strict, and a restricted policy would block the route
  // outright — the tab would fail rather than ask. `run` and `resume` dispatch
  // governed tool calls and stay high.
  workflow: Object.freeze({
    list: "low",
    show: "low",
  }),
  workspace: Object.freeze({
    list: "low",
    get: "low",
  }),
  // Browser observation of an ALREADY-OPEN session. `list` and `status` touch
  // no page at all. snapshot/extract/assert/pages/downloads read the rendered
  // page without navigating, clicking, or submitting — they cannot mutate
  // remote state or spend credentials, and their output is scrubbed of tracked
  // secrets. Everything that navigates, interacts, uploads, screenshots a
  // sensitive page, or runs a sequence keeps the tool-level `high`.
  browser: Object.freeze({
    list: "low",
    status: "low",
    snapshot: "medium",
    extract: "medium",
    assert: "medium",
    pages: "medium",
    downloads: "medium",
  }),
});

// Explicit per-action effects feed Agent authority and workflow disclosure.
// This is separate from risk: a screenshot can create a bounded artifact
// without changing the inspected target, while a browser click can change that
// target. Unlisted actions remain unknown and fail closed in strict no-write
// workflows/tasks.
const TOOL_ACTION_EFFECT = Object.freeze({
  // Bounded repository/system inspections used across first-party workflows.
  api_contract_check: Object.freeze({ default: ["target_read"] }),
  api_contract_matrix: Object.freeze({ default: ["target_read"] }),
  api_engineering_health: Object.freeze({ default: ["target_read"] }),
  assumptions: Object.freeze({ default: ["read_only"] }),
  assumptions_snapshot: Object.freeze({ default: ["read_only"] }),
  backup_dr_readiness: Object.freeze({ default: ["read_only"] }),
  backup_restore_preflight: Object.freeze({ default: ["read_only"] }),
  backup_database: Object.freeze({ default: ["artifact"] }),
  change_impact: Object.freeze({ default: ["read_only"] }),
  change_impact_gate: Object.freeze({ default: ["read_only"] }),
  ci_release_health: Object.freeze({ default: ["read_only"] }),
  release_readiness: Object.freeze({ default: ["read_only"] }),
  release_gate: Object.freeze({ default: ["read_only"] }),
  containers: Object.freeze({ inspect: ["read_only"], capabilities: ["read_only"], summary: ["read_only"], logs: ["read_only"], stats: ["read_only"], updates: ["read_only"] }),
  container_lifecycle: Object.freeze({ pull: ["external"], recreate: ["external"] }),
  database_admin: Object.freeze({ audit: ["read_only"], migrations: ["read_only"] }),
  database_migration_review: Object.freeze({ default: ["read_only"] }),
  ci_status: Object.freeze({ default: ["target_read"] }),
  github: Object.freeze({ issue_list: ["target_read"], pr_get: ["target_read"], pr_list: ["target_read"], repo_info: ["target_read"], commit_status: ["target_read"] }),
  dev_repo_profile: Object.freeze({ default: ["read_only"] }),
  dev_change_summary: Object.freeze({ default: ["read_only"] }),
  read: Object.freeze({ default: ["read_only"] }),
  search: Object.freeze({ default: ["read_only"] }),
  project: Object.freeze({ default: ["read_only"] }),
  store: Object.freeze({ default: ["application_state"] }),
  list: Object.freeze({ default: ["read_only"] }),
  tools: Object.freeze({ overview: ["read_only"], search: ["read_only"], get: ["read_only"], policy: ["read_only"] }),
  documentation_audit: Object.freeze({ default: ["read_only"] }),
  documentation_knowledge_operation: Object.freeze({ search: ["read_only"], get: ["read_only"], list: ["read_only"], update: ["application_state"], delete: ["application_state"] }),
  iac_inspect: Object.freeze({ validate: ["target_read"], diff: ["target_read"] }),
  iac_plan: Object.freeze({ default: ["target_read"] }),
  iac_health: Object.freeze({ default: ["read_only"] }),
  jellyfin: Object.freeze({ default: ["target_read"] }),
  jellyfin_playback: Object.freeze({ play: ["external"], pause: ["external"], resume: ["external"], stop: ["external"], seek: ["external"], fast_forward: ["external"], rewind: ["external"], set_volume: ["external"] }),
  linux_system_status: Object.freeze({ default: ["target_read"] }),
  linux_system_health: Object.freeze({ default: ["target_read"] }),
  linux_process_inspection: Object.freeze({ list: ["target_read"], top: ["target_read"], tree: ["target_read"] }),
  linux_service_operation: Object.freeze({ status: ["target_read"], logs: ["target_read"] }),
  model_readiness: Object.freeze({ default: ["read_only"] }),
  model_route_explain: Object.freeze({ default: ["read_only"] }),
  mcp_catalog_operation: Object.freeze({ overview: ["read_only"], search: ["read_only"], get: ["read_only"], policy: ["read_only"] }),
  mcp_compatibility: Object.freeze({ default: ["read_only"] }),
  network_change: Object.freeze({ plan: ["target_read"], preflight: ["target_read"], apply: ["external"], rollback: ["external"] }),
  network: Object.freeze({ default: ["target_read"] }),
  firewall: Object.freeze({ evaluate: ["target_read"], rules: ["target_read"] }),
  dhcp: Object.freeze({ status: ["target_read"] }),
  vpn: Object.freeze({ status: ["target_read"] }),
  network_connectivity_review: Object.freeze({ default: ["target_read"] }),
  network_service_audit: Object.freeze({ default: ["target_read"] }),
  network_service_inventory: Object.freeze({ default: ["target_read"] }),
  observability_health_review: Object.freeze({ default: ["read_only"] }),
  observability_incident_operation: Object.freeze({ list_incidents: ["read_only"], get_incident: ["read_only"], list_captures: ["read_only"], get_capture: ["read_only"], search: ["read_only"], analyze: ["read_only"] }),
  operational_readiness: Object.freeze({ default: ["read_only"] }),
  proxmox: Object.freeze({ default: ["target_read"] }),
  proxmox_provision: Object.freeze({ create_vm: ["external"], create_lxc: ["external"], clone: ["external"], configure: ["external"], snapshot_create: ["external"], convert_template: ["external"] }),
  reproducibility_compare: Object.freeze({ default: ["read_only"] }),
  supply_chain_provenance: Object.freeze({ default: ["read_only"] }),
  supply_chain_audit: Object.freeze({ default: ["read_only"] }),
  storage_capacity_audit: Object.freeze({ default: ["target_read"] }),
  storage_threshold_check: Object.freeze({ default: ["target_read"] }),
  storage_volume_inventory: Object.freeze({ default: ["target_read"] }),
  research_compare: Object.freeze({ default: ["read_only"] }),
  skeptical_compare: Object.freeze({ default: ["read_only"] }),
  skeptical_verify: Object.freeze({ default: ["read_only"] }),
  lab_preflight: Object.freeze({ default: ["read_only"] }),
  lab_run_lifecycle: Object.freeze({ plan: ["application_state"], start: ["application_state"], status: ["read_only"], resume: ["application_state"], cancel: ["application_state"], complete: ["application_state"] }),
  quality_lifecycle: Object.freeze({ plan: ["read_only"], execute: ["build_test", "local_process"], cancel: ["read_only"] }),
  browser: Object.freeze({
    list: ["read_only"], status: ["read_only"], snapshot: ["target_read"], extract: ["target_read"],
    assert: ["target_read"], pages: ["target_read"], downloads: ["target_read"],
    open: ["local_process"], close: ["local_process"], navigate: ["target_read"], back: ["target_read"],
    forward: ["target_read"], reload: ["target_read"], screenshot: ["artifact"],
    wait: ["target_read"], click: ["external"], fill: ["external"], clear: ["external"],
    select: ["external"], check: ["external"], press: ["external"], hover: ["external"],
    focus: ["external"], scroll: ["external"], secret_fill: ["external"], upload: ["external", "artifact"],
    sequence: ["unknown"],
  }),
  web_capture: Object.freeze({ capture: ["target_read", "artifact"], default: ["target_read", "artifact"] }),
  web_check: Object.freeze({ check: ["target_read"], default: ["target_read"] }),
  web_extract: Object.freeze({ extract: ["target_read"], default: ["target_read"] }),
  download: Object.freeze({ download: ["target_read", "artifact"], default: ["target_read", "artifact"] }),
  handoff: Object.freeze({ create: ["application_state"], update: ["application_state"], add_note: ["application_state"], transition: ["application_state"], claim: ["application_state"], renew_claim: ["application_state"], release: ["application_state"], archive: ["application_state"], unarchive: ["application_state"] }),
  research_hypothesis: Object.freeze({ create: ["application_state"], transition: ["application_state"], update: ["application_state"] }),
  research_project: Object.freeze({ create: ["application_state"], transition: ["application_state"] }),
  research_scope: Object.freeze({ create: ["application_state"], update: ["application_state"] }),
  research_run: Object.freeze({ plan: ["application_state"], start: ["application_state"], resume: ["application_state"], cancel: ["application_state"], complete: ["application_state"], provision: ["external", "application_state"], cleanup: ["external", "application_state"] }),
  research_probe: Object.freeze({ probe: ["external", "artifact", "application_state"], default: ["external", "artifact", "application_state"] }),
  research_evidence: Object.freeze({ capture: ["artifact", "application_state"], redact: ["artifact", "application_state"], list: ["read_only"], inspect: ["read_only"] }),
  research_report: Object.freeze({ materialize: ["artifact", "application_state"], list: ["read_only"], get: ["read_only"] }),
  black_box: Object.freeze({ capture: ["artifact", "application_state"], add_note: ["application_state"], update_incident: ["application_state"], pin: ["application_state"], extend_retention: ["application_state"], archive: ["application_state"], purge: ["application_state"] }),
  observability_incident_snapshot: Object.freeze({ snapshot: ["artifact", "application_state"], default: ["artifact", "application_state"] }),
  snapshot: Object.freeze({ capture: ["artifact", "application_state"], delete: ["application_state"] }),
  reproducibility: Object.freeze({ create: ["artifact", "application_state"], default: ["artifact", "application_state"] }),
  research_evidence_bundle: Object.freeze({ create: ["artifact", "application_state"], default: ["artifact", "application_state"] }),
  memory_maintenance: Object.freeze({ preview: ["application_state"], apply: ["application_state"], status: ["read_only"], cancel: ["application_state"], resume: ["application_state"] }),
  dev_verify: Object.freeze({ verify: ["build_test", "local_process"], default: ["build_test", "local_process"] }),
  quality_gate: Object.freeze({ verify: ["build_test", "local_process"], default: ["build_test", "local_process"] }),
  changelog: Object.freeze({ preview: ["read_only"], generate: ["read_only"], save: ["workspace_reversible"] }),
  git: Object.freeze({ status: ["read_only"], diff: ["read_only"], log: ["read_only"], show: ["read_only"], "ls-tree": ["read_only"], "ls-files": ["read_only"], add: ["workspace_reversible"], commit: ["workspace_reversible"], checkout: ["workspace_reversible"], stash: ["workspace_reversible"], push: ["external"], pull: ["external"], clone: ["workspace_reversible"] }),
});

const CONDITIONAL_TOOL_EFFECT = Object.freeze({
  api_contract_check: [{ argument: "capture_evidence", equals: true, effects: ["target_read", "artifact"] }],
  api_contract_matrix: [{ argument: "capture_evidence", equals: true, effects: ["target_read", "artifact"] }],
  api_engineering_health: [{ argument: "capture_evidence", equals: true, effects: ["target_read", "artifact"] }],
  web_check: [{ argument: "capture_evidence", equals: true, effects: ["target_read", "artifact"] }],
  dev_verify: [{ argument: "dry_run", equals: true, effects: ["read_only"] }],
  quality_gate: [{ argument: "dry_run", equals: true, effects: ["read_only"] }],
  release_gate: [{ argument: "execute", equals: true, effects: ["build_test", "local_process"] }],
  browser: [{ action: "wait", argument: "for", equals: "download", effects: ["target_read", "artifact"] }],
});

for (const actionMap of Object.values(TOOL_ACTION_EFFECT)) {
  for (const effects of Object.values(actionMap)) if (Array.isArray(effects)) Object.freeze(effects);
}
for (const rules of Object.values(CONDITIONAL_TOOL_EFFECT)) {
  for (const rule of rules) { Object.freeze(rule.effects); Object.freeze(rule); }
  Object.freeze(rules);
}

function resolveDeclaredActionEffects(name, action, args = {}) {
  const canonical = normalizeToolName(name);
  const conditional = CONDITIONAL_TOOL_EFFECT[canonical] || [];
  const conditionalEffect = conditional.find(rule => (rule.action === undefined || rule.action === action) && args?.[rule.argument] === rule.equals);
  if (conditionalEffect) return [...conditionalEffect.effects];
  const mapping = Object.prototype.hasOwnProperty.call(TOOL_ACTION_EFFECT, canonical) ? TOOL_ACTION_EFFECT[canonical] : null;
  const base = !mapping ? null
    : typeof action === "string" && Object.prototype.hasOwnProperty.call(mapping, action) ? [...mapping[action]]
      : Object.prototype.hasOwnProperty.call(mapping, "default") ? [...mapping.default]
        : null;
  const unresolvedCondition = conditional.find(rule => (rule.action === undefined || rule.action === action) && /^\$\{inputs\.[a-zA-Z0-9_-]+\}$/.test(String(args?.[rule.argument] || "")));
  return unresolvedCondition ? [...new Set([...(base || []), ...unresolvedCondition.effects])] : base;
}

module.exports = {
  TOOL_ACTION_RISK,
  TOOL_ACTION_EFFECT,
  TOOL_RISK,
  TOOL_CATEGORIES,
  RISK_LEVELS,
  getStaticToolRisk,
  getStaticToolCategory,
  getToolEffectMetadata,
  resolveDeclaredActionEffects,
};
