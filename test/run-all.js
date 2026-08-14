#!/usr/bin/env node

/**
 * Sidekick Test Runner
 *
 * Runs suites in a GitHub Actions friendly order. Security/static checks run
 * first, missing optional suites are skipped, and failures produce a summary.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const suites = [
  { file: 'test/github-setup.test.js', critical: true, description: 'GitHub workflow and package script checks' },
  { file: 'test/static-code-quality.test.js', critical: true, description: 'Static safety checks' },
  { file: 'test/security.test.js', critical: true, description: 'Redaction and dangerous command checks' },
  { file: 'test/tool-log-redaction.test.js', critical: true, description: 'Tool-log and auto-memory credential redaction' },
  { file: 'test/structured-tools-security.test.js', critical: true, description: 'Structured command-backed tool hardening' },
  { file: 'test/security-scan.test.js', critical: true, description: 'Read-only config and secret scan behavior' },
  { file: 'test/bash-tool.test.js', critical: true, description: 'Bash tool async execution, error shape, and event-loop non-blocking' },
  { file: 'test/path-policy.test.cjs', critical: true, description: 'Shared filesystem path policy boundary' },
  { file: 'test/ci-status.test.js', critical: true, description: 'Read-only GitHub CI status aggregation' },
  { file: 'test/health.test.js', critical: true, description: 'Composite health aggregation and stable failure shapes' },
  { file: 'test/agent-protocol.test.js', critical: true, description: 'Agent decision parsing, model selection, and chat roles' },
  { file: 'test/agent-loop.test.js', critical: true, description: 'Agent Bridge tool-execution loop (approved, denied, unavailable, failing, and no-tool paths)' },
  { file: 'test/agent-bridge-prompt.test.js', critical: true, description: 'Agent Bridge system prompt derives from the live canonical tool catalog' },
  { file: 'test/brain.test.js', critical: true, description: 'Brain v0.1 deterministic plan validator and orchestrator lifecycle/evidence/cancellation' },
  { file: 'test/brain-integration.test.js', critical: true, description: 'Brain v0.1 feature-flag safety and end-to-end plan→validate→dispatch→synthesize' },
  { file: 'test/approval-continuation.test.cjs', critical: true, description: 'Approval continuation transactions T1-T10, durable checkpoints, risk gate, and resumption' },
  { file: 'test/agent-continuation.test.js', critical: true, description: 'Agent Bridge follow-up continuation-context builder (validation, redaction, bounding, lineage, cycles)' },
  { file: 'test/agent-bridge-followup.test.js', critical: true, description: 'Agent Bridge follow-up API and security (lineage, terminal-parent, traversal, malformed transcript, tool-boundary)' },
  { file: 'test/agent-followup-ui.test.js', critical: false, description: 'Agent tab follow-up UI controls, lineage rendering, and endpoint wiring' },
  { file: 'test/tool-summary-cards.test.js', critical: false, description: 'Tools page summary card id parity and pending-vs-gated approval counts' },
  { file: 'test/reconciliation-ui.test.js', critical: false, description: 'Reconciliation surface wiring, decision vocabulary parity, and confirmation on the redispatching decision' },
  { file: 'test/deploy-scripts.test.js', critical: false, description: 'Deploy script checks' },
  { file: 'test/metrics-collector.test.js', critical: false, description: 'Metrics collector tool_logs queries and dashboard variable pinning' },
  { file: 'test/git-deploy.test.js', critical: false, description: 'Read-only Git deployment hardening' },
  { file: 'test/mcp-session.test.js', critical: false, description: 'MCP stale session recovery behavior' },
  { file: 'test/ops-workflows.test.js', critical: false, description: 'Packaged operations workflow metadata' },
  { file: 'test/platform-kernel.test.js', critical: false, description: 'Unified execution, event, and artifact primitives' },
  { file: 'test/platform-event-consumption.test.js', critical: false, description: 'Transactional event fan-out, backlog cap, delivery drainer, handler registry, and event vocabulary' },
  { file: 'test/compute-artifact-custody.test.js', critical: false, description: 'Compute worker artifacts registered with the kernel custody authority, surfaced custody failures, and the dry-run reconciler' },
  { file: 'test/per-action-risk.test.js', critical: false, description: 'Per-action tool risk resolution, fail-closed downgrade rules, and approval/policy decisions at the dispatcher boundary' },
  { file: 'test/compute-model-dedup.test.js', critical: false, description: 'Single model authority, shared trust ordering between router and placement, and maintained worker health_state' },
  { file: 'test/kernel-migration-parity.test.js', critical: false, description: 'Fresh migration boot vs runtime kernel boot schema parity' },
  { file: 'test/migration-self-containment.test.js', critical: true, description: 'Migrations build a complete schema standalone (C1) and tolerate runtime-created columns (C2)' },
  { file: 'test/project-identity.test.js', critical: false, description: 'Canonical project projection, cross-source identity, backfill, and encrypted workspace secrets' },
  { file: 'test/project-registry-tool.test.js', critical: false, description: 'Project registry invocation surface and gated backfill' },
  { file: 'test/tools.test.js', critical: false, description: 'Core tool behavior' },
  { file: 'test/dispatcher.test.cjs', critical: false, description: 'Centralized tool dispatcher behavior' },
  { file: 'test/tool-registry-contract.test.cjs', critical: false, description: 'Tool registry contract and descriptor coverage' },
  { file: 'test/tool-family-data-utilities.test.cjs', critical: false, description: 'Extracted data-utilities tool family behavior and dispatcher integration' },
  { file: 'test/tool-family-hashing.test.cjs', critical: false, description: 'Extracted hashing tool family behavior, policy, and compatibility' },
  { file: 'test/tool-family-storage.test.cjs', critical: false, description: 'Extracted storage tool family behavior, Redis fallback, and compatibility' },
  { file: 'test/tool-family-filesystem.test.cjs', critical: false, description: 'Extracted filesystem read/list/search family behavior and policy compatibility' },
  { file: 'test/tool-family-database-inspection.test.cjs', critical: false, description: 'Extracted read-only database inspection family behavior and compatibility' },
  { file: 'test/tool-family-monitoring.test.cjs', critical: false, description: 'Extracted monitoring tail family behavior, log sources, redaction, and policy compatibility' },
  { file: 'test/tool-family-memory-core.test.cjs', critical: false, description: 'Extracted memory-core family ownership, redaction, recall, evidence, and health behavior' },
  { file: 'test/tool-family-b5-extractions.test.cjs', critical: false, description: 'B-5 extracted families: registry ownership, risk parity, and validation-path smokes for all 24 moved handlers' },
  { file: 'test/tool-family-b6-extractions.test.cjs', critical: true, description: 'B-6 final extraction: zero legacy-owned handlers, dispatch seam + shared helpers, facade compat exports, validation-path smokes for the last 18 moved handlers' },
  { file: 'test/approval.test.js', critical: false, description: 'Approval queue behavior' },
  { file: 'test/scheduler-platform.test.js', critical: false, description: 'Scheduler and runbook platform adapters' },
  { file: 'test/execution-control.test.js', critical: false, description: 'Platform guard and state-machine enforcement' },
  { file: 'test/execution-claims.test.js', critical: false, description: 'Execution claim/lease/checkpoint/cancel/recovery contract' },
  { file: 'test/capability-rbac.test.js', critical: false, description: 'Capability RBAC and immutable change-set approvals' },
  { file: 'test/workflow-runner.test.js', critical: false, description: 'Durable workflow engine and isolated runner sessions' },
  { file: 'test/workspace-model.test.js', critical: false, description: 'Project workspaces and model registry' },
  { file: 'test/identity-deployment.test.js', critical: false, description: 'Identity/deployment-profile registry: bounded identifiers, role authorization, referential membership checks' },
  { file: 'test/evaluation-replay.test.js', critical: false, description: 'Side-effect-safe evaluation replay: deterministic digests, reference validation, hardcoded empty action list' },
  { file: 'test/security-research-adapter.test.js', critical: false, description: 'Security-research adapter contract: unavailable-by-default transport, capability gating, endpoint validation' },
  { file: 'test/security-research-evidence-vault.test.js', critical: false, description: 'Security-research Evidence Vault contract: reference normalization and bounded resolution' },
  { file: 'test/security-research-lab-policy.test.js', critical: false, description: 'Security-research lab policy: fail-closed isolation checks' },
  { file: 'test/modules-manifest.test.js', critical: false, description: 'Module manifest contract: normalization, semver, config validation, ownership and descriptor verification' },
  { file: 'test/modules-platform.test.js', critical: false, description: 'Module platform primitives: migration boundaries, progress and service facade' },
  { file: 'test/modules-repository.test.js', critical: false, description: 'Module lifecycle repository: manifest persistence, transitions, atomic migration progress, restart survival' },
  { file: 'test/modules-loader.test.js', critical: false, description: 'Module loader: registry wiring, facade isolation, fail-closed activation, restart restore' },
  { file: 'test/modules-permissions.test.js', critical: false, description: 'Module permissions: deny-by-default facade dispatch, risk caps, module attribution, risk parity' },
  { file: 'test/modules-builtin.test.js', critical: false, description: 'Builtin module provisioning: data-utilities registration, restart restore, catalog sync, operator intent' },
  { file: 'test/modules-entry-rebind.test.js', critical: false, description: 'Builtin module entry-hash re-binding: drift recovery on restart and third-party fail-closed guard' },
  { file: 'test/modules-observability.test.js', critical: false, description: 'Module observability: kernel lifecycle events, status/health exposure, cross-process disable gate, reconciliation' },
  { file: 'test/modules-discovery.test.js', critical: false, description: 'Module discovery: bounded roots, symlink rejection, realpath containment, execution-free manifest parsing' },
  { file: 'test/modules-installation.test.js', critical: false, description: 'Module installation: entry containment, regular-file check, entry hashing, discovered registration' },
  { file: 'test/modules-packaging.test.js', critical: false, description: 'Module packaging: deterministic per-file hashing, symlink/sensitive-file rejection, package hash derivation' },
  { file: 'test/modules-third-party-lifecycle.test.js', critical: true, description: 'B9 third-party module lifecycle: inspect, install, configure, enable, invoke, health, disable, upgrade, uninstall, tamper and collision fail-closed' },
  { file: 'test/workflow-definitions.test.js', critical: true, description: 'Workflow definition registry, reference validation, and the governed runner over kernel execution state' },
  { file: 'test/capability-packs.test.js', critical: true, description: 'Capability Packs v1 lifecycle: inspect, install, enable, configure, health, disable, upgrade, uninstall, ownership and integrity' },
  { file: 'test/developer-pack.test.js', critical: true, description: 'Developer pack behaviour against real git repositories: repo profile, change summary, governed verification, and runnable workflows' },
  { file: 'test/proxmox-unit.test.js', critical: true, description: 'Proxmox pack unit/security: endpoint/identifier/UPID validation, credential redaction, response normalization, error taxonomy, provider detection, profile resolution' },
  { file: 'test/proxmox-pack.test.js', critical: true, description: 'Proxmox pack integration: install/configure/health, pinned-CA TLS (and fail-closed without it), normalized discovery, guest lifecycle task monitoring, idempotency, and token-leak defense against a mock Proxmox API' },
  { file: 'test/jellyfin-pack.test.js', critical: true, description: 'Jellyfin pack profile security, deterministic playback diagnosis, capability normalization, and graceful degradation' },
  { file: 'test/jellyfin-lifecycle.test.js', critical: true, description: 'Jellyfin pack authoritative inspect/install/enable/health/disable/uninstall lifecycle' },
  { file: 'test/security-research-unit.test.js', critical: true, description: 'Security Research pack unit/boundary: external-workspace canonicalization and fail-closed rejection of the repo/data/store, probe scope/SSRF gating, deterministic comparison, and a pack-tree leakage self-scan' },
  { file: 'test/security-research-pack.test.js', critical: true, description: 'Security Research pack integration: install/health, campaign/hypothesis/scope/run lifecycle, bounded command probes composing bash, evidence integrity/redaction in an external workspace, deterministic comparison/validation, report material, scope enforcement, and both governed workflows' },
  { file: 'test/extension-docs.test.js', critical: false, description: 'Extension system and generated platform docs' },
  { file: 'test/backup-release.test.js', critical: false, description: 'Backup/restore and release maturity' },
  { file: 'test/new-tools.test.js', critical: false, description: 'Extended tool behavior' },
  { file: 'test/blackbox.test.js', critical: false, description: 'Structured Black Box incident evidence behavior' },
  { file: 'test/blackbox-lifecycle.test.js', critical: false, description: 'Black Box capture lifecycle, profile validation, and empty capture prevention' },
  { file: 'test/predict.test.js', critical: false, description: 'Predict tool and scoring engine behavior' },
  { file: 'test/predict-lifecycle.test.js', critical: false, description: 'Predict lifecycle, dedup, expiration, retention, and feedback behavior' },
  { file: 'test/predict-contract.test.js', critical: false, description: 'Predict dashboard/API contract and tool surface compatibility' },
  { file: 'test/tool-log-correlation.test.js', critical: false, description: 'MCP session/project correlation on tool logs' },
  { file: 'test/timestamp-format.test.js', critical: false, description: 'ISO timestamp storage and range-query correctness' },
  { file: 'test/insight-report.test.js', critical: false, description: 'Insight report tool behavior' },
  { file: 'test/evolve.test.js', critical: false, description: 'Evolve tool and retention behavior' },
  { file: 'test/db-tools.test.js', critical: false, description: 'Database tools behavior' },
  { file: 'test/automatic-memory.test.js', critical: false, description: 'Automatic memory capture and recall' },
  { file: 'test/memory-lifecycle.test.js', critical: false, description: 'Memory lifecycle behavior' },
  { file: 'test/memory-deferred.test.js', critical: false, description: 'Deferred memory lifecycle behavior' },
  { file: 'test/memory-sync.test.js', critical: false, description: 'Memory sync behavior' },
  { file: 'test/memory-intelligence.test.js', critical: false, description: 'Memory intelligence handoff/session behavior' },
  { file: 'test/integration.test.js', critical: false, description: 'Integration behavior' },
  { file: 'test/dashboard-api.test.js', critical: false, description: 'Dashboard API behavior' },
  { file: 'test/compute.test.js', critical: false, description: 'Compute provider-neutral inference and job system' },
  { file: 'test/compute-dashboard-ui.test.js', critical: false, description: 'Compute tab UI labelling, job detail fields, action-state parity, and refresh' },
  { file: 'test/compute-placement.test.js', critical: false, description: 'Compute Placement v1 shared decision core, provenance, and explain parity' },
  { file: 'test/compute-provider-bootstrap.test.js', critical: false, description: 'Compute provider/model bootstrap from env, idempotency, secure-by-default cloud, and secret-reference credential resolution' },
  { file: 'test/inference-convergence.test.js', critical: true, description: 'Production inference callers route only through Compute (no direct Ollama/Groq egress)' },
  { file: 'test/connector-authority.test.js', critical: false, description: 'GitHub connector bootstrap, secret-ref resolution, github tool routing through the connector authority, and read-only connector tool redaction' },
  { file: 'test/compute-recovery.test.js', critical: false, description: 'Scheduled lease recovery and heartbeat counter integrity' },
  { file: 'test/compute-worker-lifecycle.test.js', critical: false, description: 'Compute worker multi-dimensional lifecycle state model' },
  { file: 'test/compute-worker-disconnect.test.js', critical: false, description: 'Compute worker graceful disconnect protocol' },
  { file: 'test/compute-worker-config.test.js', critical: false, description: 'Compute worker persistent configuration and stable node id' },
  { file: 'test/compute-worker-credential.test.js', critical: false, description: 'Compute worker secure credential persistence' },
  { file: 'test/compute-worker-rotate.test.js', critical: false, description: 'Compute worker safe credential rotation workflow' },
  { file: 'test/compute-worker-enroll-guard.test.js', critical: false, description: 'Compute worker enrollment guard (stale/revoked credential handling)' },
  { file: 'test/compute-registry-tools.test.js', critical: false, description: 'Compute registry tool layer (provider/model create, update, filters, arg drift guard)' },
  { file: 'test/compute-jobs-mcp-contract.test.js', critical: false, description: 'Compute jobs MCP tool contract and surface compatibility' },
  { file: 'test/compute-reenrollment.test.js', critical: false, description: 'Compute worker re-enrollment (credential recovery)' },
  { file: 'test/compute-worker-cli.test.js', critical: false, description: 'Compute worker CLI subcommands and status formatting' },
  { file: 'test/compute-worker-reconnect.test.js', critical: false, description: 'Compute worker reconnection classification and backoff' },
  { file: 'test/compute-worker-resilience.test.js', critical: false, description: 'Compute worker run-loop resilience (reconnect + clean stop)' },
  { file: 'test/compute-worker-service.test.js', critical: false, description: 'Compute worker OS service definitions and installers' },
  { file: 'test/compute-worker-package.test.js', critical: false, description: 'Compute worker standalone package build' },
  { file: 'test/compute-worker-e2e.test.js', critical: false, description: 'Compute worker end-to-end acceptance (CLI credential lifecycle)' },
  { file: 'test/openvino-executor.test.js', critical: false, description: 'OpenVINO NPU executor and Python helper manager' },
  { file: 'test/openvino-startup-readiness.test.js', critical: false, description: 'OpenVINO startup capability readiness and advertisement' },
  { file: 'test/compute-protocol.test.js', critical: false, description: 'Compute authenticated worker protocol integration' },
  { file: 'test/compute-live-worker.test.js', critical: false, description: 'Opt-in live compute worker smoke test' },
];

const requested = process.argv.slice(2);
const selected = requested.length
  ? suites.filter((suite) => requested.includes(path.basename(suite.file)) || requested.includes(suite.file))
  : suites;

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║                    Sidekick Tests                         ║');
console.log('╚═══════════════════════════════════════════════════════════╝');

for (const suite of selected) {
  const suitePath = path.join(root, suite.file);
  if (!fs.existsSync(suitePath)) {
    if (suite.optional) {
      skipped++;
      console.log(`\n↷ Skipping optional missing suite: ${suite.file}`);
      continue;
    }
    failed++;
    failures.push(`${suite.file} (missing)`);
    if (suite.critical) break;
    continue;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Running: ${suite.file}`);
  console.log(`Purpose: ${suite.description}`);
  if (suite.critical) console.log('Critical: yes');
  console.log('═'.repeat(60) + '\n');

  const result = spawnSync(process.execPath, [suite.file], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
  });

  if (result.status === 0) {
    passed++;
    console.log(`\n✅ ${suite.file} passed`);
  } else {
    failed++;
    failures.push(suite.file);
    console.log(`\n❌ ${suite.file} failed`);
    if (suite.critical) {
      console.log('\nStopping because a critical suite failed.');
      break;
    }
  }
}

console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║                       Summary                             ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log(`Passed:  ${passed}`);
console.log(`Failed:  ${failed}`);
console.log(`Skipped: ${skipped}`);

if (failures.length) {
  console.log('\nFailed suites:');
  for (const failure of failures) console.log(`  - ${failure}`);
}

process.exit(failed > 0 ? 1 : 0);
