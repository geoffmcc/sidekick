# Architecture

Status: Current-state architecture
Verified commit: 5e4dbfdb04c9878cbbd284bd950a6afbef78eec3
Verified date: 2026-08-12

For Phase 0R classifications, target boundaries, and the migration roadmap, see `platform-convergence-audit.md`, `platform-target-architecture.md`, and `platform-roadmap.md`.

Sidekick has three core Node.js services sharing a SQLite database and data directory, plus optional enrolled Compute worker processes.

```text
MCP client / agent
        |
        | Bearer token
        v
MCP Server :4097
        |
        v
src/tools/index.js -> descriptor registry -> centralized dispatcher
        |                                  |
        |                                  +-> policy / approvals / redaction / audit
        +-> descriptor-family handlers, module descriptors, or compute tools
        |
        +-> SQLite sidekick.db + selected artifacts

Browser -> Dashboard :4098 -> Agent Bridge :4099 -> centralized dispatcher

Enrolled Compute worker -> scoped /compute/worker/* protocol on :4097
```

## Service boundaries

### MCP server: `src/index.js`

The MCP server creates an `McpServer` from `@modelcontextprotocol/sdk`, registers built-in and approved generated tool definitions, and serves them over:

- `POST /mcp`, `GET /mcp`, and `DELETE /mcp` for Streamable HTTP;
- `GET /sse` and `POST /messages` for legacy SSE clients;
- `GET /health` for diagnostics;
- authenticated `/compute/enrollment/*`, `/compute/worker/*`, and `/compute/admin/*` routes for Sidekick Compute.

The server requires `Authorization: Bearer <SIDEKICK_API_KEY>` or `?api_key=<key>` for MCP and administrative routes and can enforce `SIDEKICK_ALLOWED_IPS`. Worker protocol routes use scoped worker credentials, while enrollment exchange uses one-time enrollment tokens.

### Tool runtime: `src/tools/`

`src/tools.js` is now a compatibility re-export to `src/tools/index.js`; it is not the implementation monolith or an alternate production execution path. The modular runtime is divided into:

- `descriptor.js` for normalized tool descriptors;
- `registry.js` for built-in descriptor registration and alias resolution;
- `dispatcher.js` for authoritative validation, policy, approvals, execution, timeout/cancellation handling, result normalization, and audit logging;
- `context.js` for request-scoped execution identity through `AsyncLocalStorage`;
- `approvals.js`, `policy.js`, `logging.js`, `result.js`, and `registry-sync.js` for focused boundary responsibilities;
- `schemas/`, `metadata.js`, and `families/` for schemas, explicit risk/category metadata, and extracted descriptor-owned tool families.

The current built-in registry contains 112 tools across 20 categories (106 in the core registry plus 6 from the bundled `data-utilities` module). Handler extraction out of `src/tools-legacy.js` is complete: every handler is owned by a descriptor family under `src/tools/families/`, the `data-utilities` module, or `src/compute/tools.js`. What remains in `src/tools-legacy.js` is the tool policy/approval/audit machinery, the `TOOL_DEFS` ordering anchors, the compute pass-through wiring, and compatibility re-exports — see `tool-architecture.md`.

Important compatibility exports from `src/tools/index.js` include `TOOLS`, `TOOL_DEFS`, `callTool`, source-specific call wrappers, policy/approval helpers, logging helpers, and registry synchronization. New production code should use the source-specific dispatcher wrappers rather than directly invoking handlers or relying on the legacy `setSource` compatibility setter.

### Evolve and dynamic tools

The Evolve implementation is intentionally split out of the large tool module:

- `src/evolve/analyzer.js` restores chronological log order, segments calls by source/session/task/inactivity gap, rejects retries and failure loops, and mines repeated successful multi-tool workflows.
- `src/evolve/validator.js` validates inferred schemas, referenced tools, recursive parameter substitution, security constraints, and dry-run/mock execution plans.
- `src/evolve/lifecycle.js` owns generated capability state transitions: `observed`, `candidate`, `validated`, `awaiting_approval`, `trial`, `active`, `deprecated`, `rejected`, and `failed_validation`.
- `src/evolve/index.js` implements the `evolve` action interface.
- `src/dynamic-tools.js` loads approved trial/active generated capabilities from SQLite, exposes schemas for MCP registration, executes approved procedure steps, and records audit/usefulness counters.

Verified problems in the previous Evolve implementation:

- Tool logs were read newest-first while adjacent entries were interpreted as forward chronological sequences.
- Sequence mining crossed unrelated global logs without source, session, task, project, or inactivity boundaries.
- Analysis used only tool names, not safe argument shape, result summary, success/failure, retries, or generated-call metadata.
- Procedure testing echoed proposal text in a sandbox instead of validating schemas, tool references, substitution, policy, or execution behavior.
- Approved workflow/config proposals had no reliable implementation path; procedure approvals were converted by another LLM prompt and stored behind `teach`.
- Generated capabilities were not independent discoverable MCP tools with a stable schema; legacy procedures were registered ad hoc at server construction rather than through first-class descriptors and lifecycle records.
- Documentation and tool descriptions overstated self-extension by calling proposals and procedures generated tools.

The replacement stores generated capabilities and audit history in SQLite. Trial and active capabilities are synced into the normal `tools` registry with names like `generated_<descriptive_name>`, registered by the MCP server on startup, and removed from discovery when rejected or deprecated without deleting audit history.

Generated tool invocations also mirror parent and per-step execution state into the additive platform kernel tables (`platform_executions` and `platform_execution_events`). The generated-tool tables remain the compatibility source of truth for existing APIs while the platform records provide the first shared execution graph adapter.

Direct MCP tool calls are mirrored from `logToolCall(...)` into the same platform kernel tables for non-generated tool activity. The legacy `tool_logs` table remains the compatibility source for existing Activity views and Evolve mining while the platform rows provide execution graph correlation.

Black Box captures also mirror capture lifecycle, source progress, and redacted source artifacts into the platform kernel. The Black Box incident/capture/source tables and artifact files remain the compatibility source of truth while `platform_executions`, `platform_execution_events`, and `platform_artifacts` provide shared execution graph visibility.

Dashboard quick actions mirror user-triggered dashboard operations into `platform_executions` with `operation_type='dashboard_action'`. Existing HTTP responses, audit logs, and dashboard behavior remain the compatibility source of truth while platform rows provide shared visibility for UI-initiated actions.

Agent Bridge tasks mirror task lifecycle, tool-call progress, and transcript artifacts into the platform kernel with `operation_type='agent_task'`. Existing agent HTTP APIs, event streams, conversation transcripts, and tool calls remain the compatibility source of truth while platform rows provide shared task visibility.

Memory intelligence operations emit platform events for handoff processing, session lifecycle changes, and explicit remember/correct actions. The memory, handoff, task-session, and audit tables remain the compatibility source of truth while platform events provide cross-subsystem chronology.

Approval requests mirror queue, approval, rejection, expiry, and terminal execution outcomes into the platform kernel with `operation_type='approval_request'`. Encrypted approval payloads and existing approval status remain in `json_documents('approvals')`; platform rows contain only lifecycle metadata and redacted result summaries.

Schedulers and guided operational workflows mirror definitions and execution attempts into the platform kernel. Cron jobs, delays, watches, and runbook instances keep their existing JSON/document stores as compatibility sources of truth while platform executions/events provide shared visibility for queued work, checks, triggers, manual runs, timer-fired background runs, step progress, completion, cancellation, and failures.

> **Production-integration status.** The platform kernel sections below
> describe implemented, tested APIs, but not all of them have production
> callers yet. In production use today: execution records (best-effort
> projection from eight producers), execution claims/leases (cron, delay,
> watch, runbook), events (write side), artifacts (three producers), and the
> module lifecycle (via the `data-utilities` module). Foundation-only, with no
> production callers yet: the durable workflow engine and runner sessions, the
> capability/RBAC grants, the kernel model registry, extensions,
> backups/releases, canonical project registration, workspaces/secrets, and
> event delivery/consumption. `docs/platform-convergence-audit.md` tracks the
> per-area classification and `docs/platform-roadmap.md` tracks the wiring
> work.

### Authoritative execution control: `platformGuard` and `findActiveExecution`

The platform kernel provides guard-first primitives that adapters use before starting or transitioning work:

- `platformGuard(executionId, expectedState, options)` validates an execution exists, is in the expected state, and is not terminal before allowing operations. Without an execution ID, it queries for concurrent active executions by `operation_type`, `tool_name`, `project_id`, or `dedupe_key` and blocks duplicates when `allowConcurrent: false`.
- `findActiveExecution(query)` returns non-terminal executions matching the query filters, enabling adapters to detect overlapping work.
- `TERMINAL_STATES` is exported so adapters can reason about lifecycle boundaries.

Adapters use the guard-first pattern:

- `recordPlatformToolCall` checks for an existing execution before creating a new one, preventing duplicate tool-call records when metadata carries an execution ID.
- `transitionPlatformApproval` validates the execution is not terminal before transitioning, silently returning for already-terminal approvals.
- `createScheduledPlatformExecution` checks for concurrent active executions of the same operation type before creating new schedule/delay/watch/runbook records.
- `transitionScheduledPlatformExecution` validates the execution is not terminal before transitioning.

Guard failures never block tool execution — they prevent platform state divergence. The kernel continues to validate transitions at the database level via `ALLOWED_TRANSITIONS`, and the guard adds pre-flight checks that adapters use to avoid redundant or conflicting state changes.

### Capability/RBAC and immutable change-set approvals

The platform kernel provides capability-based access control and tamper-evident approval records:

- `grantCapability({ actor_id, capability, project_id, granted_by, expires_at })` creates a capability grant. Capabilities are scoped by actor and optionally by project, with optional expiry.
- `revokeCapability(capabilityId, { revoked_by, reason })` soft-revokes a capability by setting `revoked_at`. Revoked capabilities are no longer active.
- `checkCapability(actorId, capability, projectId)` returns the active capability record if the actor has the capability (respecting project scope and expiry), or `null` if not.
- `platformGuard` integrates capability checks: when `options.capability` and `options.actor_id` are provided, it validates the capability before allowing the operation.

Immutable change-set approvals provide tamper-evident records:

- `createChangeSet({ approval_id, tool_name, actor_id, decision, args })` records an approval decision with a SHA-256 content hash computed from the operation parameters. The hash binds the decision to the specific tool, actor, and arguments.
- `verifyChangeSet(changeSetId)` recomputes the hash from stored parameters and returns `{ valid: true/false }`. A mismatch indicates the record has been tampered with.
- `getChangeSetsByApproval(approvalId)` returns all change-set records for an approval, providing a complete audit trail of decisions.
- Change-set records are linked to executions and produce `changeset.approved`, `changeset.rejected`, and `changeset.failed` events in the platform event log.

### Durable workflow engine and isolated runner sessions

The platform kernel provides durable workflow state and isolated execution contexts:

- `createWorkflow({ name, steps, created_by })` creates a workflow definition with ordered steps. Each step has a `tool_name`, `args`, and optional `max_retries`. Workflows start in `defined` state.
- `startWorkflow(workflowId)` transitions from `defined`/`paused` to `running`.
- `advanceWorkflow(workflowId)` marks the current step as `running` and emits `workflow.step_started`.
- `completeWorkflowStep(workflowId, stepId, { result_summary, error, shouldRetry })` completes or fails a step. On success, `current_step` increments and the workflow auto-completes when the last step finishes. On retry, the step resets to `pending`.
- `checkpointWorkflow(workflowId, checkpoint)` persists arbitrary checkpoint data for crash recovery.
- `pauseWorkflow(workflowId)` and `failWorkflow(workflowId, { reason })` manage workflow lifecycle.

Runner sessions provide isolated execution contexts:

- `createRunnerSession({ resource_limits })` creates an active runner with optional resource limits.
- `updateRunnerHeartbeat(runnerId, usage)` records resource usage and heartbeat.
- `completeRunnerSession(runnerId)` and `terminateRunnerSession(runnerId, { reason })` manage runner lifecycle.
- Runner sessions emit `runner.created`, `runner.completed`, and `runner.terminated` events.

Execution claims (Phase 4/B) give schedulers a fenced, leased claim on a platform execution before dispatching work — see `docs/execution-claim-contract.md`:

- `claimExecution({ execution_id, claimed_by, lease_ms })` — exactly one winner across concurrent runners (`BEGIN IMMEDIATE`, epoch-fenced); losers get `claim_held`.
- `renewExecutionLease` / `checkpointExecution` / `releaseExecutionClaim` — all writes fenced by `claimed_by` + `claim_epoch`, so a superseded claimant cannot corrupt state.
- `requestExecutionCancel(executionId)` — cooperative cancellation flag surfaced to claimants; nothing is force-killed.
- `recoverOrphanedExecutions()` — clears expired leases and transitions stranded `queued`/`running`/`waiting` executions to `orphaned` for re-queueing. Four schedulers use the claim contract in production — cron, delay, watch, and runbook — through the shared helpers in `src/tools/scheduled-execution.js` (`recoverStrandedDelays()` and `recoverStrandedRunbooks()` run at agent startup). `requestExecutionCancel` and `checkpointExecution` remain unwired: production code reads the cancel flag but nothing sets it yet.

### Project workspaces and model registry

The platform kernel provides isolated project environments and model management:

- `createProjectWorkspace({ name, project_id, owner_id, config, secrets, resource_limits })` creates an isolated project workspace. A `secrets` map is initial provisioning only: entries are routed into the encrypted secret store (requires `SIDEKICK_SECRET_KEY`; fails closed before the row is inserted) and never stored as plaintext. Workspaces start in `active` state.
- `getProjectWorkspace(workspaceId)` and `getWorkspaceByProject(projectId)` retrieve workspace details with parsed config and sorted `secret_names`; secret values are reachable only through `getWorkspaceSecret`.
- `updateProjectWorkspace(workspaceId, { config, resource_limits })` updates workspace configuration. Passing `secrets` throws — secrets are managed via `setWorkspaceSecret`/`deleteWorkspaceSecret`.
- `archiveProjectWorkspace(workspaceId)` transitions to `archived` state, excluding from active lookups.
- Workspaces emit `workspace.created`, `workspace.updated`, and `workspace.archived` events.

The model registry tracks available LLM models and their capabilities:

- `registerModel({ name, provider, version, capabilities, context_window, supports_streaming, supports_vision, supports_tools, cost_per_1k_input, cost_per_1k_output, rate_limit_rpm })` registers a model with its specifications.
- `getModel(modelId)` and `getModelByName(name, provider)` retrieve model details with parsed capabilities.
- `listModels({ state, provider, limit })` filters and lists registered models.
- `deprecateModel(modelId, { reason })` transitions to `deprecated` state with a warning event.
- `recordModelUsage(modelId)` increments usage counter and updates last-used timestamp.
- Models emit `model.registered` and `model.deprecated` events.

### Extension system and generated platform docs

The platform kernel provides a plugin/extension system and auto-generated documentation:

- `registerExtension({ name, version, type, author, description, entry_point, capabilities, dependencies, config_schema, config, hooks })` registers an extension. Extensions start in `registered` state.
- `getExtension(extensionId)` and `getExtensionByName(name)` retrieve extension details with parsed capabilities, dependencies, config, and hooks.
- `activateExtension(extensionId)` transitions from `registered` to `active`.
- `deactivateExtension(extensionId, { reason })` transitions from `active` to `deactivated`.
- `uninstallExtension(extensionId, { reason })` transitions to `uninstalled` with a warning event.
- `updateExtensionConfig(extensionId, config)` updates the extension's configuration.
- `recordExtensionUsage(extensionId)` increments usage counter and updates last-used timestamp.
- `listExtensions({ state, type, limit })` filters and lists registered extensions.
- Extensions emit `extension.registered`, `extension.activated`, `extension.deactivated`, and `extension.uninstalled` events.

Generated platform documentation:

- `generatePlatformDocs()` produces a comprehensive snapshot of platform state including execution counts, event counts, artifact counts, workflow counts, runner counts, workspace counts, model counts, extension counts, capability counts, change-set counts, execution state breakdown, recent events (24h), active models, active extensions, and a list of all platform tables.

### Backup/restore and release maturity

The platform kernel provides backup/restore operations and release tracking:

- `createBackup({ name, type, tables, compression })` creates a backup record with automatic row counts for all platform tables. Backups start in `created` state.
- `getBackup(backupId)` retrieves backup details with parsed tables and row counts.
- `completeBackup(backupId, { file_path, file_size_bytes, checksum })` verifies a regular file inside the managed backup directory, recomputes its size and SHA-256, and only then marks the backup completed.
- `restoreBackup(backupId)` is deliberately unsupported in the platform kernel; use the governed `db_backup`/`db_restore` path for real database recovery.
- `listBackups({ state, type, limit })` filters and lists backups.
- Backups emit `backup.created`, `backup.completed`, and `backup.restored` events.

Release maturity tracking:

- `createRelease({ version, codename, description, changelog, breaking_changes, deprecations, upgrade_notes, migration_version })` creates a release in draft state.
- `getRelease(releaseId)` and `getReleaseByVersion(version)` retrieve release details with parsed changelog and breaking changes.
- `publishRelease(releaseId)` transitions from draft to published.
- `listReleases({ state, limit })` filters and lists releases.
- Releases emit `release.created` and `release.published` events.

### Dashboard: `src/dashboard.js`

The dashboard serves a browser UI and JSON API. The server code lives in `src/dashboard.js`, the authenticated HTML shell lives in `src/dashboard.html`, and public CSS/JS assets live under `static/`. It reads the Sidekick data directory, reports system state, allows KV editing and deletion, exposes tool metadata, accepts webhooks, and proxies agent requests to the Agent Bridge.

It includes dashboard-specific protections: optional Basic Auth, IP allowlist, rate limiting, exact-host CSRF origin checks, audit logging, error logging, and policy-aware tool metadata.

The dashboard separates adjacent data domains instead of rendering every store as a raw event log:

- Activity shows what Sidekick did from `tool_logs`. `/api/logs` returns normalized raw calls plus session summaries. Sessions use real session/task identifiers when present; otherwise a deterministic source-plus-time-window fallback keeps legacy records grouped without inventing unsupported relationships.
- Data shows what Sidekick stores from `kv_store`. `/api/kv` derives namespace, type, size, preview, project/source metadata, and compact totals. The UI inspector renders structured JSON, plain text, and Markdown-like text safely. KV history is not shown because the backend stores only the current value.
- Memory shows what Sidekick learned from `memories`. The dashboard categorizes rows as durable, sessions, unresolved, or operational; existing `tool_call` memories stay readable under Operational instead of dominating the default view.

Dashboard-rendered arguments, outputs, KV values, and memory content are escaped in the browser. The API shaping layer applies the existing redaction rules to activity details and KV previews, and destructive KV/memory actions continue to use confirmation flows plus backend authorization checks.

### Agent Bridge: `src/agent.js`

The Agent Bridge accepts high-level task requests, builds a task transcript, repeatedly chooses tool calls, executes them through `callTool`, and streams progress events. It also loads scheduled delays and watches at startup.

The agent has a loop limit controlled by `SIDEKICK_MAX_ITERATIONS` and stores transcripts under `data/conversations/`. Before planning it builds a compact memory brief from structured memories and semantic recall when available. Its prompt is filtered through the active `agent` tool policy so blocked tools are not offered for planning.

## Session handling

The MCP server tracks sessions in memory. Sessions include the MCP server instance, transport, creation time, last access time, and initialization state. Inactive sessions are removed after 1 hour. Streamable HTTP GET and DELETE require a valid `mcp-session-id` header. Stale POST sessions return a structured JSON-RPC error and a replacement session ID header so the client can reinitialize.

## Shared storage

All services use the same `SIDEKICK_DATA_DIR`. By default, this is `data/` relative to the project during local development, and `/home/sidekick/sidekick/data` in the example deployment. Core KV, structured memories, tool logs, generated Evolve capabilities, generated-tool audit history, tool catalog data, knowledge base entries, and named JSON documents are stored in SQLite (`sidekick.db`). Some feature-specific artifacts still use files: agent transcripts, audit/error logs, secrets, snapshots, queues, runbooks, baselines, and similar operational bundles.

Back up both `sidekick.db` and the surrounding data directory. Keep logs trimmed, protect backups as sensitive operational data, and avoid using the KV store as a large application database.
