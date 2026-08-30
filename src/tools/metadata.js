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

module.exports = {
  TOOL_ACTION_RISK,
  TOOL_RISK,
  TOOL_CATEGORIES,
  RISK_LEVELS,
  getStaticToolRisk,
  getStaticToolCategory,
};
