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
// Suites opt into an explicit, machine-readable skip result with this exit code.
const SKIP_EXIT_CODE = 77;

const suites = [
  { file: 'test/invariants-doctor.test.js', critical: true, description: 'Read-only durable invariants, redacted Doctor diagnostics, and support-bundle safety' },
  { file: 'test/certification.test.js', critical: true, description: 'Versioned Agent certification scenarios, canonical tool assertions, and bounded reports' },
  { file: 'test/certification-isolation.test.js', critical: true, description: 'Certification isolation from operator data and temporary cleanup' },
  { file: 'test/certification-lifecycle.test.js', critical: true, description: 'Loopback Agent lifecycle certification, durable polling, cancellation, and bounded failures' },
  { file: 'test/live-agent-certification.test.js', critical: true, description: 'Loopback Agent-tab certification executor and durable terminal projection' },
  { file: 'test/agent-health-startup.test.js', critical: true, description: 'Agent startup migrations and truthful health readiness' },
  { file: 'test/release-manifest.test.js', critical: true, description: 'Release identity, worker checksum, and certification manifest' },
  { file: 'test/dashboard-doctor.test.js', critical: true, description: 'Authenticated Dashboard Doctor and redacted support bundle API' },
  { file: 'test/context-engine.test.js', critical: true, description: 'Context Engine scope isolation, bounded manifests, receipts, entity retrieval, and consolidation provenance' },
  { file: 'test/pack-services.test.js', critical: true, description: 'Capability Pack scoped services v2 and namespace isolation' },
  { file: 'test/identity-foundation.test.js', critical: true, description: 'Durable principals, users, password hashing, Owner bootstrap, and lifecycle foundation' },
  { file: 'test/identity-approval-governance.test.js', critical: true, description: 'Approval principal provenance, human approval, and self-approval enforcement' },
  { file: 'test/identity-authentication.test.js', critical: true, description: 'Server-side identity sessions and scoped machine credentials' },
  { file: 'test/identity-authorization.test.js', critical: true, description: 'Core permission bundles, authorization, bounded delegation, and Owner safety' },
  { file: 'test/identity-governance.test.js', critical: true, description: 'Provenance, secret authorization, safe logging, and authorization audit' },
  { file: 'test/identity-resource-authority.test.js', critical: true, description: 'Runner, artifact, task-session, and handoff ownership/provenance persistence' },
  { file: 'test/github-setup.test.js', critical: true, description: 'GitHub workflow and package script checks' },
  { file: 'test/static-code-quality.test.js', critical: true, description: 'Static safety checks' },
  { file: 'test/architecture-boundaries.test.js', critical: true, description: 'Dependency boundaries and cycle guard' },
  { file: 'test/config-registry.test.js', critical: true, description: 'Canonical safe configuration metadata' },
  { file: 'test/platform-errors.test.js', critical: true, description: 'Stable platform error taxonomy' },
  { file: 'test/security.test.js', critical: true, description: 'Redaction and dangerous command checks' },
  { file: 'test/command-execution.test.js', critical: true, description: 'Bounded command execution and shell safety checks' },
  { file: 'test/cron-safety.test.js', critical: true, description: 'Cron dispatch and crontab injection safety checks' },
  { file: 'test/outbound-url-security.test.js', critical: true, description: 'DNS-pinned outbound URL and SSRF regression checks' },
  { file: 'test/provider-outbound-security.test.js', critical: true, description: 'DNS-pinned provider endpoint regression checks' },
  { file: 'test/storage-isolation-security.test.js', critical: true, description: 'Principal/project KV isolation regression checks' },
  { file: 'test/tool-log-redaction.test.js', critical: true, description: 'Tool-log and auto-memory credential redaction' },
  { file: 'test/structured-tools-security.test.js', critical: true, description: 'Structured command-backed tool hardening' },
  { file: 'test/security-scan.test.js', critical: true, description: 'Read-only config and secret scan behavior' },
  { file: 'test/bash-tool.test.js', critical: true, description: 'Bash tool async execution, error shape, and event-loop non-blocking' },
  { file: 'test/path-policy.test.cjs', critical: true, description: 'Shared filesystem path policy boundary' },
  { file: 'test/ci-status.test.js', critical: true, description: 'Read-only GitHub CI status aggregation' },
  { file: 'test/health.test.js', critical: true, description: 'Composite health aggregation and stable failure shapes' },
  { file: 'test/agent-protocol.test.js', critical: true, description: 'Agent decision parsing, model selection, and chat roles' },
  { file: 'test/agent-capability-broker.test.js', critical: true, description: 'Generic canonical Agent capability discovery and live-state routing' },
  { file: 'test/agent-loop.test.js', critical: true, description: 'Agent Bridge tool-execution loop (approved, denied, unavailable, failing, and no-tool paths)' },
  { file: 'test/agent-capability-repair.test.js', critical: true, description: 'Generic Agent schema preflight, failure classification, and bounded repair guidance' },
  { file: 'test/agent-adaptive-durability.test.js', critical: true, description: 'Adaptive Agent authority envelopes, canonical effect classification, and fail-closed retries' },
  { file: 'test/agent-goal-contract.test.js', critical: true, description: 'Structured Agent goal criteria and evidence requirements remain bounded and durable' },
  { file: 'test/agent-authority-approval.test.js', critical: true, description: 'Agent authority approval reaches the canonical approval queue' },
  { file: 'test/agent-receipt-recovery.test.js', critical: true, description: 'Durable receipt lifecycle and crash recovery decisions' },
  { file: 'test/agent-workspace-transactions.test.js', critical: true, description: 'Durable workspace transaction pre-state, post-state, and rollback gating' },
  { file: 'test/agent-rollback-principal.test.js', critical: true, description: 'Workspace rollback preserves authenticated principal provenance through canonical dispatch' },
  { file: 'test/agent-task-branch.test.js', critical: true, description: 'Task-owned branch preparation preserves dirty worktrees and receipts branch mutations' },
  { file: 'test/evidence-projector.test.js', critical: true, description: 'Generic bounded Agent evidence projection, fairness, Context Engine content, errors, and synthesis delivery' },
  { file: 'test/agent-bridge-prompt.test.js', critical: true, description: 'Agent Bridge system prompt derives from the live canonical tool catalog' },
  { file: 'test/brain.test.js', critical: true, description: 'Brain v0.1 deterministic plan validator and orchestrator lifecycle/evidence/cancellation' },
  { file: 'test/brain-integration.test.js', critical: true, description: 'Brain v0.1 feature-flag safety and end-to-end plan→validate→dispatch→synthesize' },
  { file: 'test/brain-concurrency.test.js', critical: true, description: 'Bounded canonical read-only Brain concurrency' },
  { file: 'test/brain-profile-behavior.test.js', critical: true, description: 'Behaviorally distinct bounded Brain profile rounds' },
  { file: 'test/agent-task-model.test.js', critical: true, description: 'Durable Agent goal, state, budget, checkpoint, workspace, and result model' },
  { file: 'test/agent-task-store.test.js', critical: true, description: 'Durable Agent task persistence, redaction, plans, events, and failures' },
  { file: 'test/agent-durable-operations.test.js', critical: true, description: 'Durable hierarchical plans, escalation packages, and bounded repair operations' },
  { file: 'test/agent-recovery-scan.test.js', critical: true, description: 'Restart-safe Agent claim recovery and non-resumable handling' },
  { file: 'test/agent-durable-recovery-matrix.test.js', critical: true, description: 'Real SQLite Agent crash-boundary recovery matrix: retry, verification, ambiguity, and rollback' },
  { file: 'test/agent-verification.test.js', critical: true, description: 'Independent Agent evidence verification and honest terminal statuses' },
  { file: 'test/approval-continuation.test.cjs', critical: true, description: 'Approval continuation transactions T1-T10, durable checkpoints, risk gate, and resumption' },
  { file: 'test/agent-continuation.test.js', critical: true, description: 'Agent Bridge follow-up continuation-context builder (validation, redaction, bounding, lineage, cycles)' },
  { file: 'test/agent-bridge-followup.test.js', critical: true, description: 'Agent Bridge follow-up API and security (lineage, terminal-parent, traversal, malformed transcript, tool-boundary)' },
  { file: 'test/agent-followup-ui.test.js', critical: false, description: 'Agent tab follow-up UI controls, lineage rendering, and endpoint wiring' },
  { file: 'test/tool-summary-cards.test.js', critical: false, description: 'Tools page summary card id parity and pending-vs-gated approval counts' },
  { file: 'test/reconciliation-ui.test.js', critical: false, description: 'Reconciliation surface wiring, decision vocabulary parity, and confirmation on the redispatching decision' },
  { file: 'test/deploy-scripts.test.js', critical: false, description: 'Deploy script checks' },
  { file: 'test/metrics-collector.test.js', critical: false, description: 'Metrics collector tool_logs queries and dashboard variable pinning' },
  { file: 'test/metrics-surface.test.js', critical: false, description: 'Influx measurement and field result normalization' },
  { file: 'test/dashboard-performance.test.js', critical: false, description: 'Bounded Dashboard RED metrics and route normalization' },
  { file: 'test/documentation-drift.test.js', critical: true, description: 'Documentation references and generated drift guard' },
  { file: 'test/git-deploy.test.js', critical: false, description: 'Read-only Git deployment hardening' },
  { file: 'test/mcp-session.test.js', critical: false, description: 'MCP stale session recovery behavior' },
  { file: 'test/mcp-v2-runtime.test.cjs', critical: true, description: 'MCP v2 protocol discovery, annotations, and governed invocation' },
  { file: 'test/ini-v7-compat.test.cjs', critical: true, description: 'INI v7 parsing, security, and serialization compatibility' },
  { file: 'test/local-stdio.test.js', critical: true, description: 'Local packaged-style stdio MCP startup, governance, persistence, and stdout purity' },
  { file: 'test/ops-workflows.test.js', critical: false, description: 'Packaged operations workflow metadata' },
  { file: 'test/platform-kernel.test.js', critical: false, description: 'Unified execution, event, and artifact primitives' },
  { file: 'test/platform-event-consumption.test.js', critical: false, description: 'Transactional event fan-out, backlog cap, delivery drainer, handler registry, and event vocabulary' },
  { file: 'test/compute-artifact-custody.test.js', critical: false, description: 'Compute worker artifacts registered with the kernel custody authority, surfaced custody failures, and the dry-run reconciler' },
  { file: 'test/per-action-risk.test.js', critical: false, description: 'Per-action tool risk resolution, fail-closed downgrade rules, and approval/policy decisions at the dispatcher boundary' },
  { file: 'test/compute-model-dedup.test.js', critical: false, description: 'Single model authority, shared trust ordering between router and placement, and maintained worker health_state' },
  { file: 'test/kernel-migration-parity.test.js', critical: true, description: 'Fresh migration boot vs runtime kernel boot schema parity' },
  { file: 'test/fts-migration-parity.test.js', critical: true, description: 'Migration-owned knowledge FTS schema and runtime repair parity' },
  { file: 'test/migration-self-containment.test.js', critical: true, description: 'Migrations build a complete schema standalone (C1) and tolerate runtime-created columns (C2)' },
  { file: 'test/reliability-fixes.test.js', critical: true, description: 'Bounded reliability regressions for suite selection, custom database paths, and migration locking' },
  { file: 'test/project-identity.test.js', critical: false, description: 'Canonical project projection, cross-source identity, backfill, and encrypted workspace secrets' },
  { file: 'test/project-context-isolation.test.js', critical: true, description: 'Canonical project context aggregation and cross-project log isolation' },
  { file: 'test/project-registry-tool.test.js', critical: false, description: 'Project registry invocation surface and gated backfill' },
  { file: 'test/workspace-identity-wiring.test.js', critical: true, description: 'Workspace ownership and secret mutation actor provenance from durable identity' },
  { file: 'test/compute-audit-fixes.test.js', critical: false, description: 'Compute placement explain arguments, device allowlists, model fallback, and requested-device placement' },
  { file: 'test/compute-cancellation.test.js', critical: false, description: 'Compute two-phase cancellation, legal transitions, lease recovery, and active admission accounting' },
  { file: 'test/compute-direct-runner.test.js', critical: false, description: 'Direct compute runner source failures, lease caps, interruption recovery, and cancellation' },
  { file: 'test/compute-migration-parity.test.js', critical: true, description: 'Compute migration table, column, and index parity across boot paths' },
  { file: 'test/compute-telemetry.test.js', critical: true, description: 'Local-only Compute/GPU telemetry collection, sanitization, and safe projection' },
  { file: 'test/openvino-helper-contract.test.js', critical: false, description: 'OpenVINO helper requested-device and provenance contract' },
  { file: 'test/agent-cancel.test.js', critical: false, description: 'Agent Bridge cancellation, crash-stranded execution sweep, and honest stream errors' },
  { file: 'test/dashboard-honesty.test.js', critical: false, description: 'Dashboard honest status, governed mutations, and real error codes' },
  { file: 'test/task-runner-heartbeat.test.js', critical: false, description: 'Approval continuation runner liveness and stale-heartbeat honesty' },
  { file: 'test/queue-recover.test.js', critical: false, description: 'Queue poisoned-slot recovery and honest durability behavior' },
  { file: 'test/scheduling-cancel.test.js', critical: false, description: 'Cron/watch cancellation coordination for live execution claims' },
  { file: 'test/pack-manifest-consistency.test.js', critical: false, description: 'Capability-pack module dispatch and manifest permission consistency' },
  { file: 'test/tools.test.js', critical: false, description: 'Core tool behavior' },
  { file: 'test/knowledge-promotion.test.js', critical: true, description: 'Governed promotion of taught procedures into redacted, attributed knowledge' },
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
  { file: 'test/pack-contract.test.js', critical: true, description: 'Pack contract: pack_api versioning, permission declarations, dependency resolution/cycles/ordering, transition legality, structured validation' },
  { file: 'test/developer-pack.test.js', critical: true, description: 'Developer pack behaviour against real git repositories: repo profile, change summary, governed verification, and runnable workflows' },
  { file: 'test/semantic-repository.test.js', critical: true, description: 'Semantic Repository Intelligence: static multi-language parsing, determinism, cache invalidation, safety and integrity' },
  { file: 'test/execution-node.test.js', critical: true, description: 'Governed execution node workspace containment, placement, leases, idempotency, and receipts' },
  { file: 'test/execution-node-protocol.test.js', critical: true, description: 'Authenticated execution-node protocol lifecycle and bounded response behavior' },
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
  { file: 'test/handoff-versioning.test.js', critical: true, description: 'Handoff v2 versioning: append-only history, optimistic concurrency, restore, and metadata preservation' },
  { file: 'test/integration.test.js', critical: false, description: 'Integration behavior' },
  { file: 'test/dashboard-api.test.js', critical: false, description: 'Dashboard API behavior' },
  { file: 'test/compute.test.js', critical: false, description: 'Compute provider-neutral inference and job system' },
  { file: 'test/compute-dashboard-ui.test.js', critical: false, description: 'Compute tab UI labelling, job detail fields, action-state parity, and refresh' },
  { file: 'test/compute-placement.test.js', critical: false, description: 'Compute Placement v1 shared decision core, provenance, and explain parity' },
  { file: 'test/compute-provider-bootstrap.test.js', critical: false, description: 'Compute provider/model bootstrap from env, idempotency, secure-by-default cloud, and secret-reference credential resolution' },
  { file: 'test/inference-convergence.test.js', critical: true, description: 'Production inference callers route only through Compute (no direct Ollama/Groq egress)' },
  { file: 'test/connector-authority.test.js', critical: false, description: 'GitHub connector bootstrap, secret-ref resolution, github tool routing through the connector authority, and read-only connector tool redaction' },
  { file: 'test/browser-egress.test.js', critical: true, description: 'Governed Browser Automation egress/policy: metadata/link-local/private fail-closed, DNS-rebinding pin, allowed_hosts narrowing, scheme refusal, live proxy enforcement, config clamping, secret scrubbing' },
  { file: 'test/browser-subsystem.test.js', critical: false, description: 'Governed Browser Automation real-Chromium E2E through the dispatcher: sessions, navigation, JS-rendered inspection, extraction, forms, secret-safe login, consequential submit, screenshot/download custody, upload, popups, redirects, cancellation, isolation, hostile-page handling, no leaked processes (self-skips if the browser runtime is not installed)' },
  { file: 'test/browser-automation-pack.test.js', critical: false, description: 'Governed Browser Automation capability pack: full lifecycle (install/configure/enable/health/disable/re-enable/uninstall) plus real-Chromium exercise of the pack tools (web_capture/web_extract/web_check) and the ui-smoke and authenticated-ui-check workflows through the dispatcher (self-skips real-browser parts if the runtime is not installed)' },
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

function discoverSuites(testDir = __dirname) {
  const discovered = fs.readdirSync(testDir)
    .filter((file) => /\.test\.(?:js|cjs)$/.test(file))
    .sort();
  const metadata = new Map(suites.map((suite) => [suite.file, suite]));
  const explicit = suites.filter((suite) => {
    const expectedPath = path.resolve(root, suite.file);
    return path.dirname(expectedPath) === path.resolve(testDir) && fs.existsSync(expectedPath);
  });
  const explicitFiles = new Set(explicit.map((suite) => path.basename(suite.file)));
  const discoveredSuites = discovered
    .filter((file) => !explicitFiles.has(file))
    .map((file) => metadata.get(`test/${file}`) || { file: `test/${file}`, critical: false, description: 'Discovered test suite' });
  return [...explicit, ...discoveredSuites];
}

function matchesSelection(suite, name) {
  return name === suite.file || name === path.basename(suite.file);
}

function selectSuites(allSuites, requested) {
  if (allSuites.length === 0) {
    return { selected: [], unknown: [], error: 'No test suites were discovered.' };
  }
  if (requested.length === 0) return { selected: allSuites, unknown: [] };
  const unknown = requested.filter((name) => !allSuites.some((suite) => matchesSelection(suite, name)));
  const selected = allSuites.filter((suite) => requested.some((name) => matchesSelection(suite, name)));
  return { selected, unknown, error: unknown.length ? `Invalid test suite selection: ${unknown.join(', ')}` : null };
}

function boundedSuiteTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1000, Math.min(Math.trunc(parsed), 30 * 60 * 1000)) : 5 * 60 * 1000;
}

function killTimedOutSuite(result) {
  // spawnSync's timeout only signals the suite process. Run each suite in its
  // own Unix process group so a timed-out suite cannot orphan its server or
  // other descendants for the next suite.
  if (process.platform === 'win32' || !result?.pid) return;
  try { process.kill(-result.pid, 'SIGKILL'); } catch {}
}

function runSuites({ allSuites = discoverSuites(), requested = [], cwd = root, spawnSyncImpl = spawnSync, output = console, suiteTimeoutMs = boundedSuiteTimeout(process.env.SIDEKICK_TEST_SUITE_TIMEOUT_MS) } = {}) {
  const selection = selectSuites(allSuites, requested);
  if (selection.error || selection.selected.length === 0) {
    output.error(selection.error || 'No test suites selected.');
    return { passed: 0, failed: 1, skipped: 0, failures: [], notRun: [], exitCode: 1 };
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];
  const notRun = [];

  output.log('╔═══════════════════════════════════════════════════════════╗');
  output.log('║                    Sidekick Tests                         ║');
  output.log('╚═══════════════════════════════════════════════════════════╝');

  for (let index = 0; index < selection.selected.length; index++) {
    const suite = selection.selected[index];
    const suitePath = path.join(cwd, suite.file);
    if (!fs.existsSync(suitePath)) {
      if (suite.optional) {
        skipped++;
        output.log(`\n↷ Skipping optional missing suite: ${suite.file}`);
        continue;
      }
      failed++;
      failures.push(`${suite.file} (missing)`);
      if (suite.critical) {
        notRun.push(...selection.selected.slice(index + 1).map((remaining) => remaining.file));
        break;
      }
      continue;
    }

    output.log('\n' + '═'.repeat(60));
    output.log(`Running: ${suite.file}`);
    output.log(`Purpose: ${suite.description}`);
    if (suite.critical) output.log('Critical: yes');
    output.log('═'.repeat(60) + '\n');

    const result = spawnSyncImpl(process.execPath, [suitePath], {
      cwd,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: suiteTimeoutMs,
    });

    if (result.error && result.error.code === 'ETIMEDOUT') {
      killTimedOutSuite(result);
      failed++;
      failures.push(`${suite.file} (timeout after ${suiteTimeoutMs}ms)`);
      output.log(`\n❌ ${suite.file} timed out after ${suiteTimeoutMs}ms`);
      if (suite.critical) {
        notRun.push(...selection.selected.slice(index + 1).map((remaining) => remaining.file));
        output.log('\nStopping because a critical suite timed out.');
        break;
      }
    } else if (result.status === SKIP_EXIT_CODE) {
      skipped++;
      output.log(`\n↷ ${suite.file} skipped`);
    } else if (result.status === 0) {
      passed++;
      output.log(`\n✅ ${suite.file} passed`);
    } else {
      failed++;
      failures.push(suite.file);
      output.log(`\n❌ ${suite.file} failed`);
      if (suite.critical) {
        notRun.push(...selection.selected.slice(index + 1).map((remaining) => remaining.file));
        output.log('\nStopping because a critical suite failed.');
        break;
      }
    }
  }

  output.log('\n╔═══════════════════════════════════════════════════════════╗');
  output.log('║                       Summary                             ║');
  output.log('╚═══════════════════════════════════════════════════════════╝');
  output.log(`Passed:  ${passed}`);
  output.log(`Failed:  ${failed}`);
  output.log(`Skipped: ${skipped}`);

  if (failures.length) {
    output.log('\nFailed suites:');
    for (const failure of failures) output.log(`  - ${failure}`);
  }
  if (notRun.length) {
    output.log('\nNot run:');
    for (const suite of notRun) output.log(`  - ${suite}`);
  }

  return { passed, failed, skipped, failures, notRun, exitCode: failed > 0 ? 1 : 0 };
}

if (require.main === module) {
  const result = runSuites({ requested: process.argv.slice(2) });
  process.exit(result.exitCode);
}

module.exports = { SKIP_EXIT_CODE, discoverSuites, selectSuites, runSuites };
