"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isBoundedCertificationFixtureOperation } = require("../src/certification/fixture-policy");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createAgentProxyHeaders, verifyAgentProxyRequest, assertDistinctProxySecret, assertDistinctAgentSchedulerSecret } = require("../src/security/agent-proxy-auth");
const { taskBelongsToIdentity, isAllowedCertificationRoute, isAllowedServiceRoute } = require("../src/agent/task-access");
const { reloadAgentScheduler } = require("../src/agent/scheduler-reload");
const { normalizePrincipalContext } = require("../src/agent/task-model");
const { registerAgentProxyRoutes } = require("../src/dashboard/agent-proxy-routes");
const { registerApprovalRoutes } = require("../src/dashboard/approval-routes");
const { createBlackboxQuery } = require("../src/blackbox/query");
const { clampOffset: clampPredictionOffset } = require("../src/predict");
const { HISTORY_LIMITS, clampHistoryOffset } = require("../src/agent-history");
const { dispatchTool } = require("../src/tools/dispatcher");
const { getStaticToolRisk } = require("../src/tools/metadata");
const { collectSnapshotRows } = require("../src/db/snapshot-bounds");
const { createEscalationApprovalRef, validateEscalationApprovalRef } = require("../src/agent/escalation-approval");
const { verifyRequiredRuntimeSecrets } = require("../scripts/verify-runtime-secrets");
const { boundedResultLimit, MAX_DIRECTORY_LIST_ENTRIES, MAX_SEARCH_SCAN_ENTRIES, MAX_FIND_RESULTS, MAX_FIND_SCAN_ENTRIES, MAX_FILTER_RESULTS, MAX_FILTER_SCAN_ENTRIES, MAX_SUMMARY_LINES } = require("../src/tools/families/filesystem");

const root = path.resolve(__dirname, "..");

test("escalation approval references are minted for the exact escalation, never borrowed from tool approvals", () => {
  const escalationId = "aep_01hxyz";
  const reference = createEscalationApprovalRef(escalationId);
  assert.equal(reference, "approval:escalation:aep_01hxyz");
  assert.deepEqual(validateEscalationApprovalRef(reference, escalationId), { ok: true });
  assert.equal(validateEscalationApprovalRef("approval:unrelated-tool-call", escalationId).reason, "approval_escalation_mismatch");
  assert.throws(() => createEscalationApprovalRef("bad id"), /invalid escalation id/);

  const source = fs.readFileSync(path.join(root, "src/agent.js"), "utf8");
  assert.match(source, /createEscalationApprovalRef\(escalation\.escalation_id\)/);
  assert.match(source, /new Set\(\["decision", "reason"\]\)/, "the caller cannot supply an approval reference");
});

test("all Sidekick processes migrate shared state before restoring module entries", () => {
  const source = file => fs.readFileSync(path.join(root, file), "utf8");
  const index = source("src/index.js");
  const dashboard = source("src/dashboard.js");
  const agent = source("src/agent.js");
  const mcpMigration = index.indexOf("dbStore.runPendingMigrations()");
  const packAttestation = index.indexOf("reconcileBundledPackModules()");
  const mcpProvision = index.indexOf("provisionBuiltinModules()");
  assert.ok(mcpMigration >= 0 && mcpMigration < packAttestation && packAttestation < mcpProvision,
    "MCP migrates, reconciles bundled provenance, then restores modules");
  assert.ok(dashboard.indexOf("dbStore.runPendingMigrations()") < dashboard.indexOf("provisionBuiltinModules()"),
    "Dashboard migrates before restoring modules");
  assert.ok(agent.indexOf("dbStore.runPendingMigrations()") < agent.indexOf("provisionBuiltinModules()"),
    "Agent migrates before restoring modules");

  for (const file of ["systemd/sidekick-dashboard.service", "systemd/sidekick-agent.service"]) {
    const unit = source(file);
    assert.match(unit, /^Requires=sidekick-mcp\.service$/m, `${file} requires the pack-attesting MCP service`);
    assert.match(unit, /^After=.*sidekick-mcp\.service/m, `${file} starts after MCP completes startup reconciliation`);
  }
  const mcpUnit = source("systemd/sidekick-mcp.service");
  assert.match(mcpUnit, /^ExecStartPost=\/usr\/bin\/node scripts\/wait-for-mcp-ready\.js$/m,
    "MCP is not considered started until its health endpoint responds");

  const deploySh = source("deploy.sh");
  assert.match(deploySh, /sudo install .*sidekick-mcp\.service .*sidekick-mcp\.service.*sudo install .*sidekick-agent\.service .*sidekick-agent\.service.*sudo install .*sidekick-dashboard\.service .*sidekick-dashboard\.service.*sudo systemctl daemon-reload/,
    "Bash deploy installs all dependent units and reloads systemd");
  assert.ok(deploySh.indexOf("ensure_secret_config\nsync_service_units") < deploySh.indexOf('if [ "$git_mode_used" = true ]'),
    "Bash deploy installs unit changes before restarting services");
  assert.match(deploySh, /restart_service "sidekick-mcp"\s+restart_service "sidekick-agent"\s+restart_service "sidekick-dashboard"/,
    "Bash deploy restarts core before its dependent services");

  const deployPs = source("deploy.ps1");
  assert.match(deployPs, /\$units = @\("sidekick-mcp\.service", "sidekick-agent\.service", "sidekick-dashboard\.service"\)/,
    "PowerShell deploy syncs all Sidekick units");
  assert.match(deployPs, /Run-Remote "sudo install -o root -g root -m 0644 \$source \$target"[\s\S]*sudo systemctl daemon-reload/,
    "PowerShell deploy installs unit files and reloads systemd");
  assert.ok(deployPs.indexOf("Ensure-SecretConfig\n  Sync-SidekickSystemdUnits") < deployPs.indexOf("if ($gitModeUsed)"),
    "PowerShell deploy installs unit changes before restarting services");
  assert.match(deployPs, /Restart-SidekickService "sidekick-mcp"\s+Restart-SidekickService "sidekick-agent"\s+Restart-SidekickService "sidekick-dashboard"/,
    "PowerShell deploy restarts core before dependent services");
});

test("all Core systemd services explicitly locate file-backed runtime secrets", () => {
  for (const file of [
    "systemd/sidekick-mcp.service",
    "systemd/sidekick-agent.service",
    "systemd/sidekick-dashboard.service",
  ]) {
    const unit = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(unit, /^Environment=SIDEKICK_SECRET_DIR=\/etc\/sidekick\/secrets$/m,
      `${file} must point at the directory provisioned by bootstrap`);
  }
});

test("deployment secret preflight covers every canonical file-backed secret", () => {
  const { FILE_SECRET_NAMES } = require("../src/core/runtime-secrets");
  const preflight = fs.readFileSync(path.join(root, "scripts/ensure-secret-config.js"), "utf8");
  for (const name of FILE_SECRET_NAMES) {
    assert.ok(preflight.includes(name), `deployment preflight must reject ${name} in .env`);
  }
});

test("selected privileged handler boundaries retain exact canonical dispatch guards", () => {
  const guardedHandlers = [
    ["src/tools/families/shell.js", "sidekick_bash", "bash"],
    ["src/tools/families/database-admin.js", "sidekick_db_restore", "db_restore"],
    ["src/tools/families/database-admin.js", "sidekick_db_migrate", "db_migrate"],
    ["src/tools/families/development.js", "sidekick_git", "git"],
    ["src/tools/families/capability-packs.js", "sidekick_capability", "capability"],
    ["src/tools/families/runbook.js", "sidekick_runbook", "runbook"],
    ["src/tools/families/security.js", "sidekick_sandbox", "sandbox"],
    ["src/tools/families/memory-maintenance.js", "sidekick_memory_maintenance", "memory_maintenance"],
    ["src/tools/families/evolve.js", "sidekick_evolve", "evolve"],
    ["src/tools/families/network-scopes.js", "sidekick_network_scopes", "network_scopes"],
    ["src/tools/families/operations.js", "sidekick_mission", "mission"],
    ["src/tools/families/workflow-definitions.js", "sidekick_workflow", "workflow"],
    ["src/tools/families/browser.js", "sidekick_browser", "browser"],
    ["src/tools/families/workspace.js", "sidekick_workspace", "workspace"],
    ["src/tools/families/module-management.js", "sidekick_module", "module", "requireCanonicalInvocation"],
    ["src/tools/families/project-registry.js", "sidekick_project_registry", "project_registry", "requireCanonicalInvocation"],
    ["src/tools/families/scheduling.js", "sidekick_cron", "cron"],
    ["src/tools/families/scheduling.js", "sidekick_delay", "delay"],
    ["src/tools/families/scheduling.js", "sidekick_watch", "watch"],
    ["src/tools/families/comms.js", "sidekick_notify", "notify"],
    ["src/tools/families/comms.js", "sidekick_webhook", "webhook", "requireCanonicalInvocation"],
    ["src/tools/families/security.js", "sidekick_anonymize", "anonymize", "requireCanonicalInvocation"],
    ["src/tools/families/storage.js", "sidekick_store", "store", "requireCanonicalInvocation"],
    ["src/tools/families/storage.js", "sidekick_get", "get", "requireCanonicalInvocation"],
    ["src/tools/families/storage.js", "sidekick_delete", "delete", "requireCanonicalInvocation"],
    ["src/tools/families/storage.js", "sidekick_list_projects", "list_projects", "requireCanonicalInvocation"],
    ["src/tools/families/storage.js", "sidekick_get_by_project", "get_by_project", "requireCanonicalInvocation"],
    ["src/tools/families/storage.js", "sidekick_cache", "cache", "requireCanonicalInvocation"],
    ["src/tools/families/storage.js", "sidekick_redis", "redis", "requireCanonicalInvocation"],
    ["src/tools/families/database-inspection.js", "sidekick_db_query", "db_query", "requireCanonicalInvocation"],
    ["src/tools/families/database-inspection.js", "sidekick_log_query", "log_query", "requireCanonicalInvocation"],
    ["src/tools/families/database-inspection.js", "sidekick_db_search", "db_search", "requireCanonicalInvocation"],
    ["src/tools/families/database-inspection.js", "sidekick_db_diff", "db_diff", "requireCanonicalInvocation"],
    ["src/tools/families/database-admin.js", "sidekick_db_backup", "db_backup", "requireCanonicalInvocation"],
    ["src/tools/families/database-admin.js", "sidekick_db_export", "db_export", "requireCanonicalInvocation"],
    ["src/tools/families/knowledge.js", "sidekick_knowledge", "knowledge", "requireCanonicalInvocation"],
    ["src/tools/families/memory-handoff.js", "sidekick_handoff", "handoff", "requireCanonicalInvocation"],
    ["src/tools/families/context.js", "sidekick_context", "context", "requireCanonicalInvocation"],
    ["src/tools/families/connectors.js", "sidekick_connector", "connector", "requireCanonicalInvocation"],
    ["src/tools/families/meta.js", "sidekick_debug_tool", "debug_tool", "requireCanonicalInvocation"],
    ["src/tools/families/net-fetch.js", "sidekick_web_fetch", "web_fetch", "requireCanonicalInvocation"],
    ["src/tools/families/media.js", "sidekick_download", "download", "requireCanonicalInvocation"],
    ["src/tools/families/inference.js", "sidekick_llm", "llm", "requireCanonicalInvocation"],
    ["src/tools/families/development.js", "sidekick_changelog", "changelog", "requireCanonicalInvocation"],
    ["src/tools/families/meta.js", "sidekick_fresheyes", "fresheyes", "requireCanonicalInvocation"],
    ["src/tools/families/media.js", "sidekick_ocr", "ocr", "requireCanonicalInvocation"],
    ["src/tools/families/media.js", "sidekick_media", "media", "requireCanonicalInvocation"],
    ["src/tools/families/media.js", "sidekick_transcribe", "transcribe", "requireCanonicalInvocation"],
    ["src/tools/families/media.js", "sidekick_analytics", "analytics", "requireCanonicalInvocation"],
    ["src/tools/families/memory-core.js", "sidekick_memory", "memory", "requireCanonicalInvocation"],
    ["src/tools/families/memory-lifecycle.js", "sidekick_memory_manage", "memory_manage", "requireCanonicalInvocation"],
    ["src/tools/families/memory-portability.js", "sidekick_memory_export", "memory_export", "requireCanonicalInvocation"],
    ["src/tools/families/memory-portability.js", "sidekick_memory_import", "memory_import", "requireCanonicalInvocation"],
    ["src/tools/families/memory-sync.js", "sidekick_sync_identity", "sync_identity", "requireCanonicalInvocation"],
    ["src/tools/families/memory-sync.js", "sidekick_sync_export", "sync_export", "requireCanonicalInvocation"],
    ["src/tools/families/memory-sync.js", "sidekick_sync_import", "sync_import", "requireCanonicalInvocation"],
    ["src/tools/families/memory-sync.js", "sidekick_sync_diff", "sync_diff", "requireCanonicalInvocation"],
    ["src/compute/tools.js", "sidekick_compute", "compute", "requireCanonicalInvocation"],
    ["src/compute/tools.js", "sidekick_compute_nodes", "compute_nodes", "requireCanonicalInvocation"],
    ["src/compute/tools.js", "sidekick_compute_models", "compute_models", "requireCanonicalInvocation"],
    ["src/compute/tools.js", "sidekick_compute_jobs", "compute_jobs", "requireCanonicalInvocation"],
    ["src/compute/tools.js", "sidekick_compute_route", "compute_route", "requireCanonicalInvocation"],
    ["src/tools/families/flow-control.js", "sidekick_queue", "queue"],
    ["src/tools/families/flow-control.js", "sidekick_orchestrate", "orchestrate"],
    ["src/tools/families/teach.js", "sidekick_teach", "teach"],
    ["src/tools/families/inference.js", "sidekick_ollama", "ollama"],
    ["src/tools/families/github.js", "sidekick_github", "github"],
    ["src/tools/families/observability.js", "sidekick_health", "health"],
    ["src/tools/families/observability.js", "sidekick_netdiag", "netdiag"],
    ["src/tools/families/observability.js", "sidekick_metrics", "metrics"],
    ["src/compute/tools.js", "sidekick_compute_providers", "compute_providers"],
  ];

  for (const [relative, functionName, toolName, guardType = "requireToolExecution"] of guardedHandlers) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    const functionStart = source.search(new RegExp(`(?:async\\s+)?function\\s+${functionName}\\b`));
    assert.notEqual(functionStart, -1, `${functionName} exists in ${relative}`);
    const nextFunction = source.slice(functionStart + 1).search(/\n(?:async\s+)?function\s+|\nconst (?:SCHEMAS|descriptors)\s*=/);
    const body = source.slice(functionStart, nextFunction < 0 ? source.length : functionStart + 1 + nextFunction);
    assert.match(body, new RegExp(`${guardType}\\s*\\(`), `${toolName} handler must authorize at its effect boundary`);
    assert.match(body, new RegExp(`${guardType}[^;]*["']${toolName}["']`), `${toolName} guard must bind the exact tool name`);
  }
});

test("every built-in medium, high, or critical descriptor has an exact tool-bound handler guard", () => {
  const descriptors = require("../src/tools/canonical-registry").getCanonicalRegistry().list();
  const privileged = descriptors.filter(descriptor => ["medium", "high", "critical"].includes(descriptor.risk));
  assert.ok(privileged.length > 0);
  for (const descriptor of privileged) {
    const source = String(descriptor.handler);
    const escaped = descriptor.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const canonical = new RegExp(`\\brequireCanonicalInvocation\\(\\s*[\"']${escaped}[\"']\\s*\\)`);
    const execution = new RegExp(`\\brequireToolExecution\\([\\s\\S]{0,320}[\"']${escaped}[\"'][\\s\\S]{0,80}\\)`);
    assert.ok(canonical.test(source) || execution.test(source), `${descriptor.name} must bind its handler grant to an exact canonical tool invocation`);
  }
});

test("privileged installers pin APT keys and avoid mutable vendor shell pipelines", () => {
  const bootstrap = fs.readFileSync(path.join(root, "scripts/bootstrap.sh"), "utf8");
  const setupTools = fs.readFileSync(path.join(root, "scripts/setup-tools.sh"), "utf8");
  const ollamaInstaller = fs.readFileSync(path.join(root, "scripts/lib/install-ollama.sh"), "utf8");
  const aptKeyHelper = fs.readFileSync(path.join(root, "scripts/lib/apt-repository.sh"), "utf8");
  const firstNodeInstallCall = bootstrap.indexOf("install_nodesource_repository", bootstrap.indexOf("# Install Node.js"));
  const nodeFunction = bootstrap.indexOf("install_nodesource_repository() {");

  assert.ok(nodeFunction >= 0 && nodeFunction < firstNodeInstallCall, "NodeSource helper must be defined before it is invoked");
  assert.ok(!bootstrap.includes("deb.nodesource.com/setup_"), "NodeSource bootstrap shell pipeline must not return");
  assert.ok(!setupTools.includes("get.docker.com | sh"), "Docker convenience installer pipeline must not return");
  assert.ok(bootstrap.includes("6F71F525282841EEDAF851B42F59B5F99B1BE0B4"));
  assert.ok(setupTools.includes("9DC858229FC7DD38854AE2D88D81803C0EBFCD88"));
  assert.ok(aptKeyHelper.includes("--show-keys --with-colons"));
  assert.ok(aptKeyHelper.includes("--proto '=https' --tlsv1.2"));
  assert.ok(setupTools.includes("Signed-By: /etc/apt/keyrings/docker.gpg"));
  assert.ok(!setupTools.includes("releases/latest/download/cloudflared"), "Cloudflare binary must not use mutable latest URL");
  assert.ok(setupTools.includes("CLOUDFLARED_VERSION=\"2026.10.1\""));
  assert.ok(setupTools.includes("CLOUDFLARED_SHA256=\"3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586\""));
  assert.ok(setupTools.includes("sha256sum --check --status"));
  assert.ok(setupTools.includes('source "$SCRIPT_DIR/lib/install-ollama.sh"'));
  assert.ok(setupTools.includes("install_ollama_verified"));
  assert.doesNotMatch(setupTools, /ollama\.com\/install\.sh\s*\|\s*sh/, "root setup must not pipe the mutable Ollama installer into a shell");
  assert.ok(ollamaInstaller.includes('local version="0.40.5"'), "Ollama version must be pinned");
  assert.ok(ollamaInstaller.includes("dc5eabc292f9949546c90a97c820f924b035e05243b0de13c7f366182562169c"));
  assert.ok(ollamaInstaller.includes("fbe71ebb1a10e59b8480c4d2839826b5f9dff1a6d5c142428b2e7db9b1a2c642"));
  assert.ok(ollamaInstaller.indexOf("sha256sum --check --status") < ollamaInstaller.indexOf("--extract --file"), "release digest must be verified before extraction");
  assert.ok(ollamaInstaller.includes("--proto-redir '=https'"), "redirects must remain HTTPS");
});

test("Blackbox incident pagination always binds a finite positive limit and non-negative offset", () => {
  const bindings = [];
  const dbStore = { getDb: () => ({ prepare: () => ({ all: (...args) => { bindings.push(args); return []; } }) }) };
  const query = createBlackboxQuery({ dbStore, ensureSchema() {}, safeId() {}, parseJson: value => value, nowIso: () => "now", readArtifactByPath: () => "", listAnalyses: () => [] });
  query.listIncidents({ limit: "-1", offset: "-10" });
  query.listIncidents({ limit: "999999", offset: "999999" });
  assert.deepEqual(bindings, [[50, 0], [200, 10000]]);
});

test("approval list storage rejects negative limits before binding SQL", () => {
  const dbPath = require.resolve("../src/db");
  const storePath = require.resolve("../src/approvals/store");
  const priorDb = require.cache[dbPath];
  const priorStore = require.cache[storePath];
  const bindings = [];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true, parent: module, children: [],
    exports: { getDb: () => ({ prepare: () => ({ all: (...args) => { bindings.push(args); return []; } }) }) },
  };
  delete require.cache[storePath];
  try {
    const approvals = require("../src/approvals/store");
    approvals.listApprovalRows({ limit: "-1" });
    approvals.listApprovalRows({ limit: "999999" });
    assert.deepEqual(bindings, [[100], [500]]);
  } finally {
    if (priorDb) require.cache[dbPath] = priorDb; else delete require.cache[dbPath];
    if (priorStore) require.cache[storePath] = priorStore; else delete require.cache[storePath];
  }
});

test("Blackbox search and Agent task listing bound hostile limits and offsets", () => {
  const blackbox = fs.readFileSync(path.join(root, "src/blackbox.js"), "utf8");
  const searchStart = blackbox.indexOf("function searchIncidents(query, options = {}) {");
  const searchBody = blackbox.slice(searchStart, searchStart + 450);
  assert.ok(searchBody.includes("Number.isSafeInteger(requestedLimit) && requestedLimit > 0"));
  assert.ok(searchBody.includes("Math.min(requestedLimit, 200)"));
});

test("prediction and history pagination offsets stay within returned-data bounds", () => {
  assert.equal(clampPredictionOffset(-1), 0);
  assert.equal(clampPredictionOffset("1.5"), 0);
  assert.equal(clampPredictionOffset(Number.MAX_SAFE_INTEGER), 10000);
  assert.equal(clampPredictionOffset("999999999999999999999"), 0);
  assert.equal(HISTORY_LIMITS.MAX_SCAN_FILES, 5000);
  assert.equal(clampHistoryOffset(-1), 0);
  assert.equal(clampHistoryOffset(1.5), 0);
  assert.equal(clampHistoryOffset(Number.MAX_SAFE_INTEGER), 5000);
});

test("filesystem directory listing and search have fixed result and scan ceilings", () => {
  assert.equal(MAX_DIRECTORY_LIST_ENTRIES, 500);
  assert.equal(MAX_SEARCH_SCAN_ENTRIES, 10000);
  assert.equal(MAX_FIND_RESULTS, 500);
  assert.equal(MAX_FIND_SCAN_ENTRIES, 10000);
  assert.equal(MAX_FILTER_RESULTS, 500);
  assert.equal(MAX_FILTER_SCAN_ENTRIES, 10000);
  assert.equal(MAX_SUMMARY_LINES, 500);
  assert.equal(boundedResultLimit(undefined), 50);
  assert.equal(boundedResultLimit(-1), 50);
  assert.equal(boundedResultLimit(1.5), 50);
  assert.equal(boundedResultLimit(1), 1);
  assert.equal(boundedResultLimit(500), 500);
  assert.equal(boundedResultLimit(100000), 500);
});

test("database content and execution-log reads require authenticated medium-risk execution", async () => {
  for (const name of ["db_search", "db_diff", "log_query"]) {
    assert.equal(getStaticToolRisk(name), "medium", `${name} must not be classified as a public low-risk read`);
    const result = await dispatchTool({
      name,
      args: name === "db_search" ? { query: "synthetic" } : {},
      context: { source: "mcp", requestId: `anonymous-${name}` },
    });
    assert.equal(result.isError, true, `${name} must refuse anonymous MCP dispatch`);
    assert.equal(result.code, "unauthenticated");
  }
});

test("embedding input is bounded at the tool boundary before Compute dispatch", async () => {
  const result = await dispatchTool({
    name: "embed",
    args: { text: "x".repeat(8 * 1024 + 1) },
    context: { source: "mcp", requestId: "oversized-embedding-input" },
  });

  assert.equal(result.isError, true);
  assert.equal(result.code, "validation_failed");
  assert.match(result.content[0].text, /<=8192 characters/i);
});

test("legacy installation API key denial explains scoped principal setup without granting authority", async () => {
  const result = await dispatchTool({
    name: "db_search",
    args: { query: "synthetic" },
    context: {
      source: "mcp",
      requestId: "legacy-key-no-principal",
      authIdentity: { authentication_method: "legacy_api_key", scopes: ["legacy"] },
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.code, "unauthenticated");
  assert.match(result.content[0].text, /legacy installation API key/);
  assert.match(result.content[0].text, /does not identify a principal/);
  assert.match(result.content[0].text, /Identity → Connect an MCP client/);
  assert.match(result.content[0].text, /service credential/);
});

test("legacy installation API keys cannot bypass scoped permission on low-risk workflow reads", async () => {
  const context = {
    source: "mcp",
    requestId: "legacy-key-scoped-read-no-principal",
    authIdentity: { authentication_method: "legacy_api_key", scopes: ["legacy"] },
  };

  for (const action of ["list", "show"]) {
    const result = await dispatchTool({
      name: "workflow",
      args: { action },
      context: { ...context, requestId: `${context.requestId}-${action}` },
    });
    assert.equal(result.isError, true, `workflow.${action} must enforce its scoped read permission`);
    assert.equal(result.code, "unauthenticated");
  }
});

test("database query, search, log, and diff handlers reject direct calls before access", async () => {
  const family = require("../src/tools/families/database-inspection");
  const results = await Promise.all([
    family.sidekick_db_query({ sql: "SELECT 1" }),
    family.sidekick_db_search({ query: "synthetic" }),
    family.sidekick_log_query({ limit: 1 }),
    family.sidekick_db_diff({ snapshot_a: "current", snapshot_b: "current" }),
  ]);
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.code, "canonical_dispatch_required");
  }
});

test("database diff bounds and validates imported snapshot files", async () => {
  const family = require("../src/tools/families/database-inspection");
  const context = require("./helpers/authorized-context").createServiceContext({ role: "operator", source: "mcp" });
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "sidekick-db-snapshot-"));
  const previousAllowed = process.env.SIDEKICK_ALLOWED_PATHS;
  try {
    process.env.SIDEKICK_ALLOWED_PATHS = directory;
    const oversized = path.join(directory, "oversized.json");
    fs.closeSync(fs.openSync(oversized, "w"));
    fs.truncateSync(oversized, family.MAX_SNAPSHOT_BYTES + 1);
    const tooLarge = await dispatchTool({ name: "db_diff", args: { snapshot_a: oversized, snapshot_b: "current" }, context });
    assert.equal(tooLarge.isError, true);
    assert.match(tooLarge.content[0].text, /exceeds the .* byte limit/);

    const malformed = path.join(directory, "malformed.json");
    fs.writeFileSync(malformed, JSON.stringify({ tables: { users: {} } }));
    const invalid = await dispatchTool({ name: "db_diff", args: { snapshot_a: malformed, snapshot_b: "current" }, context });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /row arrays/);

    const raced = path.join(directory, "raced.json");
    const displaced = path.join(directory, "displaced.json");
    fs.writeFileSync(raced, JSON.stringify({ tables: { users: [] } }));
    const originalOpenSync = fs.openSync;
    let replaced = false;
    fs.openSync = function (filePath, ...args) {
      if (!replaced && path.resolve(String(filePath)) === path.resolve(raced)) {
        replaced = true;
        fs.renameSync(raced, displaced);
        fs.writeFileSync(raced, JSON.stringify({ tables: { users: [{ unexpected: true }] } }));
      }
      return originalOpenSync.call(this, filePath, ...args);
    };
    let raceResult;
    try {
      raceResult = await dispatchTool({ name: "db_diff", args: { snapshot_a: raced, snapshot_b: "current" }, context });
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.equal(replaced, true, "test must replace the path between its lstat and open");
    assert.equal(raceResult.isError, true);
    assert.match(raceResult.content[0].text, /changed while being opened/);
  } finally {
    if (previousAllowed === undefined) delete process.env.SIDEKICK_ALLOWED_PATHS;
    else process.env.SIDEKICK_ALLOWED_PATHS = previousAllowed;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("database snapshot collection stops at configured row and byte budgets", () => {
  let yielded = 0;
  function* rows() {
    while (true) {
      yielded += 1;
      yield { value: "x" };
    }
  }
  assert.throws(
    () => collectSnapshotRows(rows(), { rows: 0, bytes: 0 }, { maxRows: 2, maxBytes: 1024 }),
    /exceeds the 2 row limit/,
  );
  assert.equal(yielded, 3, "iteration must stop at the first row beyond the cap");
  assert.throws(
    () => collectSnapshotRows([{ value: "long" }], { rows: 0, bytes: 0 }, { maxRows: 2, maxBytes: 2 }),
    /exceeds the 2 byte limit/,
  );
  assert.deepEqual(
    collectSnapshotRows([{ value: "ok" }], { rows: 0, bytes: 0 }, { maxRows: 1, maxBytes: 1024 }),
    [{ value: "ok" }],
  );
});

test("persistent knowledge and memory operations cannot run through identityless dispatch", async () => {
  for (const [name, args, expectedBaseRisk] of [
    ["knowledge", { action: "search", query: "security" }, "medium"],
    ["knowledge", { action: "add", category: "test", title: "synthetic", content: "synthetic" }, "medium"],
    ["memory_export", {}, "medium"],
    ["sync_export", {}, "medium"],
    ["sync_diff", { since: "2026-01-01T00:00:00.000Z" }, "medium"],
    ["sync_identity", { action: "set_user", user_id: "synthetic" }, "medium"],
    ["store", { key: "synthetic", value: "synthetic" }, "medium"],
    ["get", { key: "synthetic" }, "medium"],
    ["delete", { key: "synthetic" }, "medium"],
    ["list_projects", {}, "medium"],
    ["get_by_project", { project: "synthetic" }, "medium"],
    ["cache", { action: "list" }, "medium"],
  ]) {
    assert.equal(getStaticToolRisk(name), expectedBaseRisk);
    const result = await dispatchTool({
      name,
      args,
      context: { source: "mcp", requestId: `anonymous-persistence-${name}` },
    });
    assert.equal(result.isError, true, `${name} must refuse identityless dispatch`);
    assert.equal(result.code, "unauthenticated");
  }
});

test("direct knowledge mutation refuses before persistence", async () => {
  const knowledge = require("../src/tools/families/knowledge");
  const db = require("../src/db");
  const before = db.getDb().prepare("SELECT COUNT(*) AS count FROM knowledge WHERE title = ?").get("direct-call-canary").count;
  const result = await knowledge.sidekick_knowledge({ action: "add", category: "test", title: "direct-call-canary", content: "must not persist" });
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
  const after = db.getDb().prepare("SELECT COUNT(*) AS count FROM knowledge WHERE title = ?").get("direct-call-canary").count;
  assert.equal(after, before);
});

test("untrusted pack isolation limitation is explicit and not misrepresented as sandboxing", () => {
  const { assertExecutionIsolation, LOAD_FAILURES } = require("../src/modules/entry-loader");
  assert.throws(
    () => assertExecutionIsolation({ name: "untrusted-synthetic-pack", source: "third-party" }),
    error => error.code === LOAD_FAILURES.ISOLATION_UNAVAILABLE && /OS-enforced module isolation is unavailable/.test(error.message),
    "untrusted executable packs fail closed while no OS isolation backend is configured"
  );
});

test("first-party pack trust cannot be redirected through an environment path", () => {
  const bundled = require("../src/packs/bundled");
  const previous = process.env.SIDEKICK_BUNDLED_PACKS_DIR;
  process.env.SIDEKICK_BUNDLED_PACKS_DIR = path.join(root, "attacker-controlled-packs");
  try {
    assert.equal(bundled.bundledRoot(), path.join(root, "packs"));
  } finally {
    if (previous === undefined) delete process.env.SIDEKICK_BUNDLED_PACKS_DIR;
    else process.env.SIDEKICK_BUNDLED_PACKS_DIR = previous;
  }
});

test("public pack installation cannot accept caller-selected provenance", () => {
  const capabilityFamily = fs.readFileSync(path.join(root, "src/tools/families/capability-packs.js"), "utf8");
  const packLifecycle = fs.readFileSync(path.join(root, "src/packs/lifecycle.js"), "utf8");
  const installBranch = capabilityFamily.match(/if \(action === "install"\) \{([\s\S]*?)\n    if \(action === "configure"\)/)?.[1] || "";

  assert.ok(installBranch, "public capability install branch must remain identifiable");
  assert.match(installBranch, /provenance:\s*"third_party"/);
  assert.match(installBranch, /bundled\.installBundledPack/);
  assert.doesNotMatch(installBranch, /provenance:\s*(?:args\.)?[a-zA-Z_]/);
  assert.match(packLifecycle, /function moduleProvenance\(record\)/);
});

test("sensitive Dashboard permission checks do not depend on an attached principal", () => {
  for (const relative of ["src/dashboard.js", "src/dashboard/system-routes.js", "src/dashboard/stats-tools-routes.js", "src/dashboard/approval-routes.js"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, /if\s*\(\s*req\.authPrincipal\s*&&\s*(?:requireIdentityPermission\s*&&\s*)?!requireIdentity(?:Permission|Administrator)\s*\(/, `${relative} must not make authorization conditional on principal presence or authorization-service availability`);
  }
});

test("MCP centrally separates service credentials and Dashboard diagnostics use identity sessions", () => {
  const agent = fs.readFileSync(path.join(root, "src/agent.js"), "utf8");
  const dashboard = fs.readFileSync(path.join(root, "src/dashboard.js"), "utf8");
  const index = fs.readFileSync(path.join(root, "src/index.js"), "utf8");
  const authRoutes = fs.readFileSync(path.join(root, "src/dashboard/auth-routes.js"), "utf8");
  const secrets = fs.readFileSync(path.join(root, "src/core/runtime-secrets.js"), "utf8");
  const scheduling = fs.readFileSync(path.join(root, "src/tools/families/scheduling.js"), "utf8");
  assert.match(agent, /readSecret\("SIDEKICK_AGENT_PROXY_KEY", \{ required: true \}\)/);
  assert.doesNotMatch(agent, /SIDEKICK_API_KEY|assertDistinctProxySecret/);
  assert.match(agent, /assertDistinctAgentSchedulerSecret\(agentProxySecret, agentSchedulerSecret\)/,
    "Agent independently refuses scheduler-key reuse with its Dashboard proxy credential");
  assert.doesNotMatch(dashboard, /SIDEKICK_API_KEY|MCP_API_KEY|assertDistinctProxySecret/);
  assert.match(dashboard, /"Authorization": "Bearer " \+ \(req\.dashboardSessionToken \|\| ""\)/);
  assert.match(dashboard, /readSecret\("SIDEKICK_AGENT_PROXY_KEY", \{ required: true \}\)/);
  assert.match(authRoutes, /req\.dashboardSessionToken = identityToken/);
  assert.match(authRoutes, /req\.dashboardSessionToken = session\.token/);
  assert.match(index, /assertDistinctProxySecret\(API_KEY, agentProxyKey\)/);
  assert.match(index, /assertDistinctAgentSchedulerSecret\(agentProxyKey, agentSchedulerKey\)/);
  assert.match(index, /if \(!IS_LOCAL && process\.env\.NODE_ENV !== "test"\)/,
    "credential separation is mandatory in deployed runtimes while isolated test fixtures may omit service credentials");
  assert.match(secrets, /SIDEKICK_AGENT_PROXY_KEY:\s*"sidekick_agent_proxy_key"/);
  assert.match(secrets, /"SIDEKICK_AGENT_PROXY_KEY"/);
  assert.match(agent, /offeredService === "scheduler" \? agentSchedulerSecret : agentProxySecret/);
  assert.match(secrets, /SIDEKICK_AGENT_SCHEDULER_KEY:\s*"sidekick_agent_scheduler_key"/);
  assert.match(scheduling, /assertDistinctAgentSchedulerSecret\(/);
  assert.equal(assertDistinctProxySecret("synthetic-mcp-key", "synthetic-proxy-key"), true);
  assert.throws(() => assertDistinctProxySecret("same-synthetic-key", "same-synthetic-key"), /must differ/);
  assert.throws(() => assertDistinctProxySecret("", "synthetic-proxy-key"), /both be configured/);
  assert.equal(assertDistinctAgentSchedulerSecret("synthetic-proxy-key", "synthetic-scheduler-key"), true);
  assert.throws(() => assertDistinctAgentSchedulerSecret("synthetic-proxy-key", "synthetic-proxy-key"), /must differ/);
});

test("deployment secret preflight fails closed before restart when required credentials are unsafe", (t) => {
  const tempDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "sidekick-secret-preflight-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const apiPath = path.join(tempDir, "sidekick_api_key");
  const proxyPath = path.join(tempDir, "sidekick_agent_proxy_key");
  const writeSecrets = (api, proxy) => {
    fs.writeFileSync(apiPath, `${api}\n`, { mode: 0o600 });
    fs.writeFileSync(proxyPath, `${proxy}\n`, { mode: 0o600 });
  };

  assert.throws(() => verifyRequiredRuntimeSecrets(tempDir), /SIDEKICK_API_KEY is missing/);
  writeSecrets("synthetic-api-key", "synthetic-proxy-key");
  assert.equal(verifyRequiredRuntimeSecrets(tempDir), true);
  writeSecrets("synthetic-api-key", "synthetic-api-key");
  assert.throws(() => verifyRequiredRuntimeSecrets(tempDir), /must differ/);
  writeSecrets("sk-your-key-here", "synthetic-proxy-key");
  assert.throws(() => verifyRequiredRuntimeSecrets(tempDir), /placeholder/);

  writeSecrets("synthetic-api-key", "synthetic-proxy-key");
  if (process.platform !== "win32") {
    fs.chmodSync(tempDir, 0o777);
    assert.throws(() => verifyRequiredRuntimeSecrets(tempDir), /SIDEKICK_SECRET_DIR secret directory is writable by group or other users/);
    fs.chmodSync(tempDir, 0o700);
  }
  fs.rmSync(proxyPath);
  fs.symlinkSync(apiPath, proxyPath);
  assert.throws(() => verifyRequiredRuntimeSecrets(tempDir), /regular, non-symlink/);
});

test("Agent proxy identity requires a fresh request-bound signature and rejects replay", () => {
  const secret = "synthetic-agent-proxy-test-secret";
  const now = 1_800_000_000_000;
  const request = { method: "POST", path: "/api/agent/tasks/task-1/resume", body: "{}" };
  const headers = createAgentProxyHeaders({ ...request, secret, principalId: "principal-test", scopes: ["tools.execute"], now });
  const usedNonces = new Map();
  const verified = verifyAgentProxyRequest({ ...request, secret, headers, now, usedNonces });
  assert.equal(verified.principal_id, "principal-test");
  assert.deepEqual(verified.scopes, ["tools.execute"]);
  assert.equal(verifyAgentProxyRequest({ ...request, secret: "different-synthetic-mcp-client-key", headers, now, usedNonces: new Map() }), null, "the MCP client credential cannot authenticate Dashboard proxy assertions");
  assert.equal(verifyAgentProxyRequest({ ...request, secret, headers, now, usedNonces }), null, "a signed request nonce cannot be replayed in the same process");
  assert.equal(verifyAgentProxyRequest({ ...request, path: request.path + "?changed=1", secret, headers, now, usedNonces: new Map() }), null, "signature binds the exact route and query");
  assert.equal(verifyAgentProxyRequest({ ...request, body: "{\"changed\":true}", secret, headers, now, usedNonces: new Map() }), null, "signature binds the request body");
  assert.equal(verifyAgentProxyRequest({ ...request, secret, headers, now: now + 120_000, usedNonces: new Map() }), null, "expired signatures are rejected");
});

test("Dashboard approval forwards the authenticated reviewer scope and delegation", async () => {
  const routes = new Map();
  const app = { get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) };
  let captured = null;
  registerApprovalRoutes({
    app,
    listApprovals: () => [],
    renderContinuationApprovalPreview: () => ({ ok: true }),
    authenticatedUser: () => "scoped-reviewer",
    auditLog: () => {},
    logError: () => {},
    resolveApproval: async (...args) => { captured = args; return { content: [{ type: "text", text: "approved" }] }; },
    requireIdentityPermission: () => true,
    errorResponse: () => assert.fail("unexpected approval route error"),
  });
  const req = {
    params: { id: "approval-synthetic" },
    authPrincipal: { principal_id: "principal-reviewer", principal_type: "human", scopes: ["approvals.grant"], delegation_id: "delegation-review" },
  };
  const res = { json(value) { this.value = value; return this; }, status(code) { this.statusCode = code; return this; } };
  await routes.get("POST /api/approvals/:id/approve")(req, res);
  assert.equal(res.statusCode, undefined);
  assert.equal(captured[0], "approval-synthetic");
  assert.equal(captured[1], "approve");
  assert.deepEqual(captured[3], {
    reviewerPrincipalId: "principal-reviewer",
    reviewerAuthIdentity: {
      principal_id: "principal-reviewer",
      principal_type: "human",
      scopes: ["approvals.grant"],
      delegation_id: "delegation-review",
    },
  });
  const dispatcher = fs.readFileSync(path.join(root, "src/tools/dispatcher.js"), "utf8");
  assert.match(dispatcher, /credentialScopes: effectiveReviewerIdentity\?\.scopes/);
  assert.match(dispatcher, /authIdentity: effectiveReviewerIdentity/);
  assert.match(dispatcher, /reviewerAuthIdentity\.principal_id !== reviewerPrincipalId/);
  const approvalCompat = fs.readFileSync(path.join(root, "src/tools/approval-compat.js"), "utf8");
  assert.equal((approvalCompat.match(/reviewerAuthIdentity: options\.reviewerAuthIdentity/g) || []).length, 2);
});

test("identityless certification service can access only its durably attributed tasks", () => {
  const certification = { service: "certification", principal_id: null };
  assert.equal(taskBelongsToIdentity(certification, { principal_context: { service_identity: "certification" } }), true);
  assert.equal(taskBelongsToIdentity(certification, { principal_context: { service_identity: "dashboard-proxy" } }), false);
  assert.equal(taskBelongsToIdentity(certification, { actor_principal_id: "human-1" }), false);
  assert.equal(taskBelongsToIdentity(null, { actor_principal_id: "human-1" }), false);
  assert.equal(taskBelongsToIdentity({ principal_id: "human-1" }, { actor_principal_id: "human-1" }), false,
    "an unknown principal must not gain access by matching a stored task owner id");
  assert.equal(taskBelongsToIdentity({ principal_id: "human-2" }, { actor_principal_id: "human-1" }), false);
  assert.deepEqual(normalizePrincipalContext({ service_identity: "certification" }), {
    version: 1, credential_scopes: [], delegation_id: null, service_identity: "certification",
  });
  assert.throws(() => normalizePrincipalContext({ service_identity: "arbitrary-service" }), /not an allowed Agent task identity/);
  assert.equal(isAllowedCertificationRoute("POST", "/agent/run"), true);
  assert.equal(isAllowedCertificationRoute("GET", "/agent/tasks/agt_0123456789/control-room"), true);
  assert.equal(isAllowedCertificationRoute("POST", "/agent/run/agt_0123456789/cancel"), true);
  assert.equal(isAllowedCertificationRoute("GET", "/agent/tasks"), false);
  assert.equal(isAllowedCertificationRoute("POST", "/agent/run/agt_0123456789/follow-up"), false);
  assert.equal(isAllowedCertificationRoute("DELETE", "/agent/run/agt_0123456789/cancel"), false);
  assert.equal(isAllowedServiceRoute("certification", "POST", "/agent/run"), true);
  assert.equal(isAllowedServiceRoute("scheduler", "POST", "/delays/reload"), true);
  assert.equal(isAllowedServiceRoute("scheduler", "POST", "/watches/reload"), true);
  assert.equal(isAllowedServiceRoute("scheduler", "GET", "/delays/reload"), false);
  assert.equal(isAllowedServiceRoute("scheduler", "POST", "/agent/run"), false);
  assert.equal(isAllowedServiceRoute("dashboard-proxy", "POST", "/delays/reload"), false);
});

test("durable Agent contexts preserve role-derived scopes without widening explicit scope limits", () => {
  const { createTask } = require("../src/agent/task-model");
  assert.deepEqual(normalizePrincipalContext({ credential_scopes: null }), {
    version: 1, credential_scopes: null, delegation_id: null,
  });
  assert.deepEqual(normalizePrincipalContext({ credential_scopes: [] }), {
    version: 1, credential_scopes: [], delegation_id: null,
  });
  assert.deepEqual(normalizePrincipalContext({}), {
    version: 1, credential_scopes: [], delegation_id: null,
  }, "legacy or absent scope state remains fail-closed");
  assert.equal(createTask({ objective: "role scope", principal_context: { credential_scopes: null } }).principal_context.credential_scopes, null);
  assert.deepEqual(createTask({ objective: "empty scope", principal_context: { credential_scopes: [] } }).principal_context.credential_scopes, []);
  const { persistedTaskAuthIdentity } = require("../src/agent/task-identity");
  const roleTask = { actor_principal_id: "principal-1", principal_context: { version: 1, credential_scopes: null } };
  assert.equal(persistedTaskAuthIdentity(roleTask).scopes, null);
  const credentialTask = { actor_principal_id: "principal-1", principal_context: { version: 1, credential_id: "cred_test123", credential_scopes: ["memory.read", "tools.execute"] } };
  const credential = { credential_id: "cred_test123", principal_id: "principal-1", scopes: ["memory.read"], revoked_at: null, expires_at: null };
  assert.deepEqual(persistedTaskAuthIdentity(credentialTask, { getCredential: () => credential }).scopes, ["memory.read"], "recovery intersects the saved grant with current credential scopes");
  assert.equal(persistedTaskAuthIdentity(credentialTask, { getCredential: () => ({ ...credential, revoked_at: new Date().toISOString() }) }), null, "revoked credentials cannot authorize recovery");
  assert.equal(persistedTaskAuthIdentity(credentialTask, { getCredential: () => ({ ...credential, expires_at: new Date(Date.now() - 1000).toISOString() }) }), null, "expired credentials cannot authorize recovery");
  assert.equal(persistedTaskAuthIdentity(credentialTask, { getCredential: () => ({ ...credential, principal_id: "principal-2" }) }), null, "credential ownership must still match");
  assert.equal(persistedTaskAuthIdentity({ ...credentialTask, principal_context: { version: 1, credential_scopes: ["tools.execute"] } }), null, "unattributed persisted scope snapshots fail closed");
  const agent = fs.readFileSync(path.join(root, "src/agent.js"), "utf8");
  const continuation = fs.readFileSync(path.join(root, "src/agent/continuation-jobs.js"), "utf8");
  const taskIdentity = fs.readFileSync(path.join(root, "src/agent/task-identity.js"), "utf8");
  assert.match(agent, /credential_scopes: parentContext\.authIdentity \? \(parentContext\.authIdentity\.scopes \?\? null\) : \[\]/);
  assert.match(agent, /require\("\.\/agent\/task-identity"\)/);
  assert.match(taskIdentity, /lookup\(credentialId\)/);
  assert.match(taskIdentity, /current\.has\("\*"\) \|\| current\.has\(scope\)/);
  assert.match(continuation, /persistedTaskAuthIdentity\(durableTask\)/);
});

test("certification policy matches only schema-normalized immutable hermetic fixtures", () => {
  const scenarios = require("../src/certification/scenarios").scenarios;
  const fixture = scenarios.find(item => item.theme === "network-scope").fixture[0];
  assert.equal(isBoundedCertificationFixtureOperation(fixture.name, fixture.args), true);
  assert.equal(isBoundedCertificationFixtureOperation(fixture.name, { ...fixture.args, dry_run: false }), false);
  assert.equal(isBoundedCertificationFixtureOperation("network_scopes", { action: "create", policy: {} }), false);
});

test("scheduler reload uses a signed, route-bound service identity", async () => {
  const secret = "synthetic-agent-service-key";
  const usedNonces = new Map();
  let captured;
  let successfulBodyClosed = false;
  let rejectedBodyClosed = false;
  const http = {
    request(options, callback) {
      captured = options;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.end = () => {
        const identity = verifyAgentProxyRequest({
          secret,
          method: options.method,
          path: options.path,
          headers: options.headers,
          usedNonces,
        });
        assert.deepEqual(identity, { service: "scheduler", principal_id: null });
        assert.equal(verifyAgentProxyRequest({
          secret: "synthetic-dashboard-proxy-secret",
          method: options.method,
          path: options.path,
          headers: options.headers,
          usedNonces: new Map(),
        }), null, "the scheduler key does not authenticate Dashboard proxy assertions");
        const response = new EventEmitter();
        response.statusCode = 204;
        response.destroy = () => { successfulBodyClosed = true; };
        callback(response);
      };
      return req;
    },
  };
  assert.deepEqual(await reloadAgentScheduler("delays", { secret, http }), { ok: true });
  assert.equal(successfulBodyClosed, true, "successful reload response body is closed after the status is recorded");
  assert.equal(captured.path, "/api/delays/reload");
  assert.equal(captured.method, "POST");
  const rejectedHttp = {
    request(_options, callback) {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 403;
        response.destroy = () => { rejectedBodyClosed = true; };
        callback(response);
      };
      return req;
    },
  };
  assert.deepEqual(await reloadAgentScheduler("watches", { secret, http: rejectedHttp }), {
    ok: false, code: "agent_reload_rejected", status: 403,
  });
  assert.equal(rejectedBodyClosed, true, "rejected reload response body is closed after the status is recorded");
  assert.deepEqual(await reloadAgentScheduler("unknown", { secret, http }), { ok: false, code: "unsupported_reload" });
  assert.deepEqual(await reloadAgentScheduler("delays", { http }), { ok: false, code: "service_credential_unavailable" });
});

test("Dashboard Agent proxy signs the caller identity and exact forwarded body", async () => {
  const secret = "synthetic-dashboard-proxy-secret";
  const routes = new Map();
  const app = { post: (route, handler) => routes.set(`POST ${route}`, handler), get: (route, handler) => routes.set(`GET ${route}`, handler) };
  let captured = null;
  let forwardedBody = "";
  const http = {
    request(options, callback) {
      captured = options;
      const upstream = new EventEmitter();
      upstream.write = chunk => { forwardedBody += chunk; };
      upstream.end = () => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { "content-type": "application/json" };
        callback(response);
        response.end("{}");
      };
      return upstream;
    },
  };
  registerAgentProxyRoutes({ app, http, agentPort: 4099, agentProxySecret: secret, errorResponse: () => assert.fail("unexpected proxy error") });
  const path = "/api/agent/run?source=test";
  const body = { goal: "safe fixture", marker: "signed" };
  const response = new PassThrough();
  response.writeHead = (status, headers) => { response.statusCode = status; response.headers = headers; };
  const completed = new Promise(resolve => response.once("finish", resolve));
  routes.get("POST /api/agent/run")({ originalUrl: path, authPrincipal: { principal_id: "principal-test", scopes: ["agent.tasks.read"], delegation_id: "delegation-test" }, body }, response);
  await completed;

  assert.equal(captured.path, path);
  assert.equal(forwardedBody, JSON.stringify(body));
  const identity = verifyAgentProxyRequest({ secret, method: "POST", path, body: forwardedBody, headers: captured.headers, usedNonces: new Map() });
  assert.equal(identity.principal_id, "principal-test");
  assert.deepEqual(identity.scopes, ["agent.tasks.read"]);
  assert.equal(identity.delegation_id, "delegation-test");
});
