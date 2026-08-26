# Tool Architecture

Status: Current-state architecture
Verified date: 2026-08-14

Sidekick's canonical built-in registry is assembled from descriptor families and
may change as the project evolves. Active module,
capability-pack, and approved generated tools join that same registry at
runtime, so the live catalog count is deployment-dependent. Query `tools
action="overview"` for the current count. All contributions execute through
one descriptor registry and one centralized dispatcher.

The Track B legacy decomposition is **complete**: as of slice B-6,
`src/tools-legacy.js` owns **zero production tool handlers**. Core handlers are
owned by descriptor families, while the six `data-utilities` tools are
registered through the module loader and the six compute tools have handlers in
`src/compute/tools.js` behind pure pass-through wiring in `tools-legacy.js`.
`src/tools-legacy.js` is a small compatibility facade holding policy/approval,
registry-sync and tool-logging compatibility machinery plus re-exports. It owns
no canonical descriptor metadata or production handlers. `TOOL_DEFS` and the
legacy `TOOLS` map are derived projections; descriptor ownership lives in the
canonical registry and descriptor families. It is required by no descriptor
family at module load.

The path there: B-1 removed 1163 lines of proven-unreachable dead code; B-2
through B-5 extracted the read-only, self-contained, and cluster handlers into
descriptor families; B-6 extracted the final entangled tail — the
nested-dispatch tools, the scheduled-execution users, the secrets cluster, and
the registry/policy inspection surface. B-6 introduced two structural pieces:
`src/tools/dispatch-seam.js`, a dependency-free `callTool` seam that lets a
family run other tools without importing (and thus cycling through)
`tools-legacy.js` or reaching the privileged `executeAuthorizedTaskStep`; and
the shared helper modules `src/core/ids.js`, `src/core/procedures-store.js`,
`src/core/secrets-store.js`, and `src/tools/scheduled-execution.js`, each
extracted in its own step before the families that depend on it. See
`docs/platform-roadmap.md` Track B.

## Descriptor Model

Each tool has one normalized descriptor with its public name, description, Zod input schema, handler, explicit risk, category, origin, optional family, aliases, and policy-facing metadata.

Descriptors are validated by `src/tools/descriptor.js`. Validation rejects empty names, invalid names, missing descriptions, missing handlers, missing schemas, missing risks, and risks outside the supported vocabulary: `low`, `medium`, `high`, `critical`.

Extracted descriptor-owned families live under `src/tools/families/` and are aggregated by `src/tools/families/index.js`, which is the single source of extracted descriptors for the registry:

- `utility.js` — `respond`.
- `data-utilities.js` — `parse`, `extract`, `transform`, `diff`, `validate`, `template`. In-process data utilities: they perform no filesystem, database, network, or shell access. This is a description of their current dependencies, not a sandbox guarantee — `validate` compiles caller-supplied JSON Schema through Ajv and `template` compiles caller-supplied Handlebars templates, so their input is still untrusted code-shaped data.
- `hashing.js` — `hash`. File and string checksum generation and verification. It uses the shared filesystem path-policy boundary for file reads.
- `database-inspection.js` — `db_schema`, `db_query`, `db_stats`, `log_query`, `db_search`, `db_diff`. Read-only SQLite/Postgres inspection and snapshot comparison.
- `database-admin.js` — `db_backup`, `db_restore`, `db_export`, `db_migrate`. Database backup/restore/export and schema migration (the mutation counterpart to `database-inspection.js`). Uses the shared filesystem path policy; `db_restore` is `critical` and `db_migrate` is `high` risk, gated by the dispatcher.
- `inference.js` — `llm`, `embed`, `ollama`. LLM chat and text embeddings use the Compute inference service; `ollama` remains a model-management surface. `sidekick_llm` is exported for direct callers: the `development`, `meta`, and `black-box` families import it, and `tools-legacy.js` re-imports it for `teach` until B-6.
- `networking.js` — `tunnel`, `wireguard`, `nginx`. Cloudflare tunnels, WireGuard VPN, and Nginx reverse-proxy management. All `high` risk; shell-bound argument values are validated through `core/command-validation`.
- `comms.js` — `notify`, `webhook`. Outbound Discord/Slack/email notifications and received-webhook access (the dashboard keeps its own separate webhook receiver).
- `process-mgmt.js` — `process`, `service`, `archive`. Process management, systemd service control, and archive create/extract/list. `process` and `service` are `high` risk; command arguments are array-passed to execFileSync and output is redacted.
- `net-fetch.js` — `web_fetch`. Outbound HTTP fetch from the host.
- `observability.js` — `status`, `health`, `metrics`, `netdiag`. Unified system status, composite health checks with scoring, InfluxDB metrics, and network diagnostics. `health` and `netdiag` are `high` risk (custom health commands run through a shell; netdiag builds shell command strings with every user-supplied value passed through its `shellEscape` guard). `checkNetwork` keeps its injectable probe seams and is re-exported through the `src/tools` facade as a compatibility export; `sidekick_ops` (legacy) imports the family's `sidekick_status` for its incident snapshots.
- `storage.js` — `store`, `get`, `delete`, `list_projects`, `get_by_project`, `cache`, `redis`.
- `memory-sync.js` — `sync_identity`, `sync_export`, `sync_import`, `sync_diff`.
- `memory-portability.js` — `memory_export`, `memory_import`.
- `memory-lifecycle.js` — `memory_manage`.
- `memory-session.js` — `session`.
- `memory-handoff.js` — `handoff`.
- `memory-core.js` — `memory`.
- `context.js` — `context`.
- `filesystem.js` — `read`, `list`, `search`, `summarize`, `filter`, `write`, `diff_files`, `find`. `write` is `critical` risk.
- `monitoring.js` — `tail`, `snapshot`, `timeline`, `baseline`. Log tailing, system-state snapshots with drift comparison, chronological event timelines, and behavioral baselines with anomaly detection. `baseline` is `high` risk.
- `shell.js` — `bash`. Arbitrary shell execution (`critical` risk) with the `DANGEROUS_PATTERNS`/`isDangerous` pre-filter, which moved here and is re-exported through `tools-legacy.js` and the facade for `src/tools/policy.js` and the security tests.
- `development.js` — `git`, `changelog`, `depend`. Structured git operations, conventional-commit changelog generation (optional LLM summaries via the inference family), and npm/systemd/process dependency analysis.
- `media.js` — `ocr`, `media`, `transcribe`, `analytics`, `insight_report`, `download`. Tesseract OCR, ffmpeg processing, Whisper transcription, DuckDB analytics, evidence-backed insight reports (calls `ocr` in-family), and yt-dlp downloads. Managed downloads without an explicit output path are stored under the Sidekick data directory and registered through platform artifact custody; explicit output paths retain caller-selected destinations. `safeExecFileSync` and the yaml/fast-xml-parser/ini/`detectFormat` requires moved here with their only consumers. B-5 also fixed a latent bug: `analytics` used `os.tmpdir()` without requiring `os`, so every file/query call failed — the family adds the missing require.
- `security.js` — `security_scan`, `sandbox`, `anonymize`. Read-only config/secret scanning, sandboxed command execution with rollback (`critical` risk), and consistent text anonymization.
- `meta.js` — `predict`, `debug_tool`, `fresheyes`. Prediction engine access, persistent debug sessions, and fresh-perspective analysis (LLM via the inference family).
- `knowledge.js` — `knowledge`. Knowledge base management over the shared db store.
- `operations.js` — `ops` (`critical` risk). Packaged deploy/verify/restart/incident workflows, including `scheduleMcpRestart`; imports the observability family's `sidekick_status` for incident snapshots (now family-to-family).
- `black-box.js` — `black_box`. Incident evidence capture over the shared `src/blackbox` module; passes the inference family's `sidekick_llm` by reference into incident analysis.
- `github.js` — `github`, `ci_status`. GitHub API operations and read-only CI status aggregation. The token resolves from env or the encrypted-secrets store and is redacted from error text; the `parseGithubArgs`/`getGithubArg`/`getCiRevisionSelector`/`buildCiStatusResult`/`formatCiStatusText` helpers stay on the facade as compatibility exports. `github` is `high` risk.
- `secret.js` — `secret` (`high`). Encrypted secret storage over `src/core/secrets-store.js` and the shared AES-256-GCM cipher; wire format unchanged.
- `resume.js` — `resume`. First-class project resume/handoff records.
- `teach.js` — `teach` (`high`). Taught procedures over `src/core/procedures-store.js`; generates via the inference family's `sidekick_llm` and executes steps through the dispatch seam.
- `flow-control.js` — `queue`, `retry`, `orchestrate`, `batch`, `circuit`. Nested-dispatch workflow tools, all running other tools through the seam. `batch` carries `isBuiltinToolName` (resolving `TOOL_DEFS` lazily from the facade). `queue`/`orchestrate` are `high` risk.
- `scheduling.js` — `cron`, `delay`, `watch`. Scheduled and event-driven execution over the shared `src/tools/scheduled-execution.js` cluster; the delay/watch stores plus `recoverStrandedDelays`/`pauseWatchForCancel` move here and are re-exported through the facade for `src/agent.js`. All `high` risk.
- `runbook.js` — `runbook` (`critical`). Multi-step operational runbooks with platform-execution tracking; `recoverStrandedRunbooks` is re-exported for `src/agent.js`.
- `evolve.js` — `evolve` (`critical`). Thin wrapper over `src/evolve`, handed the registry-derived `TOOL_DEFS` and the shared procedures store.
- `tool-catalog.js` — `tools`. Tool catalog, discovery manifest, and policy inspector; reads the policy/approval/registry helpers that remain in `tools-legacy.js` lazily through the facade, and re-exports `buildPolicyInspection`/`summarizePolicyInspection` for `src/dashboard.js`.
- `module-management.js` — `module` (alias `modules`, `high` risk). Read/enable/disable/check/recover for platform module lifecycle state through the shared policy and approval path.
- `capability-packs.js` — `capability` (aliases `capability_pack`, `pack`; `critical` risk). Capability-pack lifecycle: list/available/show/inspect/install/configure/enable/disable/health/upgrade/uninstall. `critical` because installing or enabling a pack activates executable module code in the Sidekick process. Owns no lifecycle logic itself; delegates to `src/packs/`.
- `workflow-definitions.js` — `workflow` (alias `workflows`; `high` risk). List/show/run/resume registered workflow definitions. Each step is dispatched through the same dispatcher, so each individual tool's own policy and approval still apply on top.

Descriptor families plus `src/tools/families/compute.js` own all 108 built-in
descriptors; the `data-utilities` module contributes its six tools at runtime
through the same module registry path. Capability-pack modules contribute
further descriptors through that same path. Compute handlers remain implemented
in `src/compute/tools.js`, but their canonical registration is owned by
`families/compute.js`, not by the compatibility layer. `module-management.js` — `module` (with the one
declared alias in the codebase, `modules`) — exposes read/enable/disable/
check/recover for platform modules. `process-mgmt.js`, `net-fetch.js`, and
`observability.js` were added by Track B slice B-4; slice B-5 added `shell.js`,
`development.js`, `media.js`, `security.js`, `meta.js`, `knowledge.js`,
`operations.js`, and `black-box.js`, and extended `inference.js` (`llm`),
`filesystem.js` (`write`), and `monitoring.js` (`snapshot`, `timeline`,
`baseline`) — 24 handlers in one slice, verified by
`test/tool-family-b5-extractions.test.cjs`. Slice B-6 added `github.js`,
`secret.js`, `resume.js`, `teach.js`, `flow-control.js`, `scheduling.js`,
`runbook.js`, `evolve.js`, and `tool-catalog.js`, extended `operations.js`
(`mission`) and `context.js` (`project`), and reached zero legacy-owned
handlers — verified by `test/tool-family-b6-extractions.test.cjs`. Each family
owns its handlers, inline Zod schemas, risk, category, and compatibility metadata. The explicit `canonical-order.js` list preserves the existing compatibility order; `legacy-catalog.js` and `legacy-tool-map.js` are projections rather than owners. The five storage schemas (`store`, `get`, `delete`, `list_projects`, and `get_by_project`) have been removed from `src/tools/schemas/index.js`; storage has single ownership in `storage.js`, and a registry contract test asserts one schema owner per extracted descriptor.

The filesystem path policy now lives in `src/tools/path-policy.js`, the authoritative implementation of `enforcePathPolicy` and `getPathPolicyDecision`. It requires only `fs`, `path`, `src/core/policy-env.js`, and `src/tools/context.js`, so descriptor families can depend on it without requiring `src/tools-legacy.js` at module top level. `src/tools-legacy.js` consumes it and no longer defines its own copy.

`hash` is descriptor-family owned by `hashing.js`; its compatibility metadata is projected from the canonical descriptor. The live legacy handler and legacy schema entry have been removed.

## Registry Lifecycle

`src/tools/canonical-registry.js` assembles the canonical descriptor set and explicit order, including the Compute family. `src/tools/registry.js` validates and materializes that set, adds active module descriptors to the same registry, and resolves aliases. Legacy catalog/map exports are derived compatibility projections and are not inputs to canonical registry construction.

The registry rejects ambiguous names with order-independent validation. It collects canonical names first, rejects duplicate canonical names, then rejects aliases that collide with any other canonical name or alias. A descriptor may declare its own canonical name as an explicit self-alias. Built-in tools cannot be shadowed by generated tools; generated tools are resolved only when no built-in descriptor exists for the canonical name.

Compatibility maps are derived from the registry:

- `TOOLS`
- `TOOL_DEFS`
- schema lookup
- MCP definitions
- risk and category metadata for catalog display

New production code should depend on `src/tools/index.js`, `dispatchTool`, or `callTool`, not on `src/tools-legacy.js`.

## Dispatcher Pipeline

`src/tools/dispatcher.js` owns the runtime execution pipeline for production tool calls.

Pipeline order:

1. Reject caller-provided descriptors unless execution is using the test-only descriptor capability.
2. Create or inherit request-scoped execution context.
3. Look up the built-in descriptor or generated-tool descriptor.
4. Reject unknown tools and unclassified generated tools.
5. Validate arguments with the descriptor Zod schema.
6. Evaluate tool policy for the request source.
7. Evaluate approval requirements.
8. Queue approval or continue with a trusted approved execution.
9. Invoke the descriptor handler.
10. Apply timeout and cancellation boundaries where provided.
11. Normalize and sanitize success, validation, policy, approval, timeout, cancellation, handler, and dispatcher errors.
12. Log the invocation with redacted summaries and context metadata.
13. Report audit logging failure separately without misclassifying handler success or failure.
14. Let legacy platform/activity mirroring preserve dashboard compatibility.

Production transports must not directly invoke `descriptor.handler`, legacy handlers, or `dynamicTools.callDynamicTool`. They call the source-specific dispatcher wrappers exported from `src/tools/index.js`.

## Request-Scoped Context

`src/tools/context.js` uses `AsyncLocalStorage` for request-scoped source and invocation metadata. The compatibility `setSource` API remains for old tests and legacy helper calls, but dispatcher-created context is authoritative for tool execution.

Context fields include source, request ID, trace/correlation ID, invocation ID, parent invocation, actor, auth identity, session ID, task ID, project, tool name, approval ID, generated procedure name, execution IDs, operation ID, idempotency key, timeout, cancellation signal, and security metadata.

`correlation_id` is a client-neutral, optional 1-128 character identifier using
letters, numbers, `.`, `_`, `:`, or `-`. MCP exposes it on every tool schema.
It is validated before dispatch, inherited by child work, and persisted
separately from transport session, client session, request, task, execution,
and workflow identifiers. When omitted, the existing server-generated trace
identifier remains the operation correlation. `sidekick_log_query` can filter
by it and supports bounded incremental polling with `after_id`; JSON polling
responses include the returned count and next cursor.
For `log_query` and `timeline`, `correlation_id` is a stream filter rather than
the query operation's own correlation identifier, preventing an observer from
recording its polling calls into the stream it is observing.

Nested calls inherit the intended context fields and receive dispatcher-created invocation metadata. Concurrent calls do not share source or request identity. The legacy `setSource` compatibility setter must not be used around asynchronous execution; live request identity is passed into the dispatcher and carried by `AsyncLocalStorage`.

Generic `createExecutionContext` and compatibility `callTool` calls do not trust caller-supplied `source`. Only private source-specific factories can establish transport identity:

- `createMcpExecutionContext` / `callMcpTool`
- `createAgentExecutionContext` / `callAgentTool`
- `createDashboardExecutionContext` / `callDashboardTool`
- `createApprovalExecutionContext`
- `createInternalExecutionContext` / `callInternalTool`
- `createTestExecutionContext` for test-only descriptor execution

## Policy And Approval Boundary

Policy and approval decisions are evaluated in the dispatcher for all tool execution surfaces.

Approval behavior remains compatible with the existing dashboard approval workflow, but ordinary dispatcher callers cannot bypass approval with `bypassApproval`, `approvalBypass`, a supplied approval ID, or a caller-selected source.

- Required approvals queue encrypted payloads.
- Approval previews are redacted.
- Approval records store the canonical tool name, encrypted canonical arguments, an argument hash, requester/source metadata, timeout metadata, creation time, and expiration time.
- Dashboard approval calls `resolveApproval`, which uses the dispatcher-owned trusted `executeApprovedTool` path.
- The trusted path loads the stored approval, verifies it is pending and unexpired, authenticates and decrypts the stored arguments, leases it as `executing` in a database transaction, and executes the stored tool with the stored arguments.
- Approved execution re-resolves the current descriptor, revalidates arguments, rechecks current policy, and verifies current risk before handler invocation.
- Approval execution carries a trusted operation ID, executor ID, and idempotency key through context, timeout errors, tool logs, and finalization.
- Lease renewal updates approval heartbeat and lease expiration while the approved tool is running.
- Finalization requires matching operation ID and executor ID, then records `approved` or `failed`, stores a redacted result preview, discards the encrypted payload, and preserves platform approval/change-set events.
- Timed-out approved operations that may still be running move to `reconciliation_required` with `manual_review` instead of being treated as safely failed or safely retryable.
- Stale high-risk, critical, or unknown executing approvals move to `reconciliation_required`; stale low-risk approvals are only returned to `pending` when an explicit recovery policy allows low-risk retry.
- Pending, rejected, expired, failed, already-approved, and already-executing approvals cannot be executed.
- Approvals are single-use; concurrent duplicate execution is prevented by the leased `pending` to `executing` claim transition.

Operators investigating stale approvals should inspect the approval `operation_id`, `executor_id`, `heartbeat_at`, `lease_expires_at`, `attempt_count`, and `reconciliation_status` fields. Recovery events are recorded in `approval_execution_recovery_events` by migration `021_approval_execution_recovery.sql`.

Approval cannot be bypassed by using MCP, dashboard generated-tool runs, agent execution, scheduler execution, generated-tool nested steps, or legacy `callTool` compatibility APIs.

Future internal callers that need to execute a reviewed request must call the approval subsystem (`resolveApproval` or the dispatcher-owned approved-execution helper) with only an approval ID and reviewer identity. They must not pass replacement arguments or a replacement tool name.

## Risk Behavior

Built-in descriptors must have explicit risk metadata. Missing built-in risk metadata fails registry construction.

Generated tools are untrusted runtime data. Missing or invalid generated risk does not default to `low` or `medium`; dispatcher execution fails closed with `risk_unclassified` until the generated capability has a valid risk.

Legacy compatibility risk lookup returns `critical` for unknown tools so old policy inspection does not fail open.

## Invocation Surfaces

Current production surfaces and routing:

- MCP built-ins in `src/index.js`: register definitions from descriptors and call `callMcpTool`.
- MCP taught procedures: call `callMcpTool("teach", ...)`.
- MCP generated tools: call `callMcpTool(def.name, ...)`.
- Agent tasks and scheduled delay/watch actions in `src/agent.js`: call `callAgentTool`.
- Dashboard evolve actions and generated-tool runs in `src/dashboard.js`: call `callDashboardTool`.
- Legacy internal tool-to-tool calls in `src/tools-legacy.js`: local `callTool` delegates to the dispatcher.
- Generated/evolved tool steps in `src/dynamic-tools.js`: receive injected `callTool`, which is the dispatcher compatibility API.

Dashboard database API routes still use policy checks as HTTP route guards for dashboard-specific endpoints; they do not directly execute MCP tool handlers.

## Result And Error Model

Dispatcher results preserve MCP-compatible `{ content: [{ type: "text", text }] }` responses. Errors include `isError: true` and normalized codes such as:

- `unknown_tool`
- `validation_failed`
- `policy_denied`
- `approval_required`
- `approval_queue_unavailable`
- `descriptor_injection_denied`
- `risk_unclassified`
- `timed_out_operation_may_continue`
- `cancelled`
- `handler_error`
- `policy_evaluation_failed`
- `approval_evaluation_failed`
- `audit_persistence_failed`
- `dispatcher_internal_error`

Responses and logs use centralized result helpers and the shared redaction utility. Dispatcher-returned errors redact bearer tokens, API keys, authorization headers, password-like fields, private-key blocks, database URLs, and stack-trace frames.

Timeouts are best-effort for legacy handlers. The dispatcher passes an `AbortSignal` to handlers and requests cancellation on timeout, but it returns `timed_out_operation_may_continue` unless the caller cancellation signal is explicitly observed. It does not claim that underlying work was terminated when a legacy handler may still be running.

Audit logging is isolated from handler execution. Policy, validation, and approval failures remain denied even if logging later fails. A successful handler result remains successful if final audit persistence fails; the result includes observable audit-failure metadata and a structured application error is emitted with invocation ID, tool name, approval ID when present, and a sanitized error.

## Adding Or Migrating A Tool

For new descriptor-owned tools:

1. Add the handler and descriptors in a focused family module under `src/tools/families/`.
2. Include schema, args metadata, explicit risk, category, source, and family.
3. Register the family module in `src/tools/families/index.js`; `src/tools/registry.js` consumes that aggregate.
4. Remove the live legacy handler when safe.
5. Keep any needed legacy definition row only as a temporary ordering anchor.
6. Check for code that tests tool existence against the legacy `TOOLS` handler map. Such a check silently stops recognizing an extracted tool. Resolve built-in names from `TOOL_DEFS` or the registry instead — `sidekick_batch` did exactly this and lost access to every extracted tool until it was corrected.
7. Add dispatcher-level tests for success, validation failure, policy denial, approval behavior when relevant, logging, and compatibility exports.

Handlers should not implement their own policy or approval logic. Handlers that need nested tools should use an injected or imported dispatcher call path, not raw handler maps.

## Remaining Legacy Footprint

Handler extraction is finished — every migration sequence step that used to be
listed here has been completed (slices B-1 through B-6, PRs #240–#245). What
remains in `src/tools-legacy.js` is deliberate and bounded:

1. **Policy, approval, and audit machinery** — `getToolRisk`,
   `enforceToolPolicy`, `getToolPolicyDecision`, the standalone approval store
   (`queueApproval`, `resolveApproval`, `claimApprovalExecution`,
   `finalizeApprovalExecution`, recovery helpers), `logToolCall`, and the
   platform mirroring adapters. These are dispatcher dependencies, not tool
   handlers.
2. **Compatibility projections** — `legacy-catalog.js` and
   `legacy-tool-map.js` expose the old `TOOL_DEFS`/`TOOLS` shapes derived from
   canonical descriptors for existing consumers.
3. **Compatibility re-exports** — helpers whose implementations moved to
   families or shared modules but whose old import paths are kept for
   `src/agent.js`, `src/dashboard.js`, and existing tests.

Relocating the policy/approval machinery into `src/tools/` modules and retiring
the compatibility exports is routine follow-up work, not a security boundary:
the dispatcher is already the sole execution path. Family modules must not
require `src/tools-legacy.js` at module top level; the lazy `require` of the
dispatcher inside legacy functions is what keeps the dispatcher/legacy cycle
from forming, and `src/tools/dispatch-seam.js` gives families nested dispatch
without touching legacy at all.

Relocated so far, each for the same reason — a consumer that must not require legacy at top level:

| Helper | Now lives in | Driven by |
|---|---|---|
| `enforcePathPolicy`, `getPathPolicyDecision` | `src/tools/path-policy.js` | descriptor families needing the filesystem boundary |
| `canonicalizeApprovalValue`, `canonicalApprovalJson`, `approvalArgsHash` | `src/approvals/canonical-json.js` | approval continuation deriving durable digests from it |
| `getSecretKey`, `encryptSecret`, `decryptSecret` | `src/core/secret-cipher.js` | approval continuation encrypting checkpoints at rest |

The canonicaliser is now a **versioned wire format**, not an internal helper: `docs/adr-approval-continuation.md` §3 derives `args_digest`, `plan_version`, and `idempotency_key` from it and stores them durably, so changing its normalisation would silently invalidate every stored digest and fail re-verification for every previously approved action. It must not be modified in place; a change requires a new version prefix and a documented migration of stored digests.

The compatibility layer remains to preserve external clients, existing generated/evolved tools, dashboard catalogs, approval workflows, and tool logs during gradual extraction.

## Tests

Tool architecture tests live in:

- `test/tool-registry-contract.test.cjs`
- `test/dispatcher.test.cjs`
- `test/approval.test.js`
- existing dashboard, agent, compute, generated-tool, and security suites

Tests assert descriptor completeness, duplicate rejection, fail-closed risk behavior, dispatcher result normalization, approval behavior, concurrency-safe context, MCP routing through `callTool`, and extracted-family compatibility.
