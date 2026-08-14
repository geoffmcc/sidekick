# Platform Convergence Audit

Status: Current-state audit (post-handoff convergence campaign)
Verified commit: 389a9698f7b66bbb5edb37b331e252f62e8c44f9
Verified date: 2026-08-14
Supersedes: the 2026-08-11 audit pinned to `a88ea84` (10 PRs stale) and the
2026-08-05 audit pinned to `d2db2658`.

## Method

Originally measured directly from code at `a88ea84`; rows affected by PRs
#236–#246 (Track A completion, B1/B2 legacy decomposition, module entry
re-binding, B3-1 project canonicalization) were re-measured at `5e4dbfd`.
Handoffs, prior audits, roadmap documents, PR descriptions, and phase numbers
were treated as historical evidence and re-checked against the implementation.
Every classification below is backed by a call-site or an empirical test, not
by a documentation claim.

Baseline at `5e4dbfd`: **106 test files registered in `test/run-all.js`**. The
9 suites that were orphaned at `a88ea84` were registered by PR #236 and now run
in CI (as `critical: false` entries).

## Closeout delta (2026-08-12)

The subsequent B3/B4 campaign slices were verified against deployed `51e4505`.
Execution creation now registers canonical projects, scheduled executions
inherit request project context, and the project/isolation suites cover the
boundary. The project-source backfill was run through the guarded dry-run then
confirmed path: both reports matched at 40 rows across 9 source types and 18
projects. Runbook cancellation/checkpoint behavior is ledger-backed for the
scheduled runners. The full suite and deployment smoke verification passed.

These changes close the condensed campaign scope; the broader residual matrix
below remains intentionally unchanged where it describes unrelated future work.

The prior 8-phase roadmap (`d9625a3`..`a88ea84`, PRs #191–#235) has a commit for
every phase. This audit measures what those commits actually delivered:
production-used capability versus foundation/contract-only scaffolding.

## Classification vocabulary

- **production-complete** — real callers, persistence, tests, failure behavior.
- **production-usable but partial** — works for its callers but has named gaps.
- **foundation/contract-only** — implemented and (sometimes) tested, but with
  zero production callers; a library, not a wired capability.
- **compatibility-owned** — still owned by the legacy monolith.
- **duplicated** — parallel authority awaiting convergence.
- **missing** — not implemented.

## Do not duplicate

Do not introduce a second registry, dispatcher, policy engine, approval store,
request identity system, project store, workflow engine, execution ledger, event
system, model registry, artifact system, connector framework, module lifecycle,
or authorization model. Extend or converge the existing authoritative
boundaries.

## Residual convergence matrix

| Area | Classification | Measured evidence | Residual gap |
|---|---|---|---|
| Tool descriptor/registry/dispatcher | **production-complete** | One path: `tools.js`→`tools/index.js`→`dispatcher.js`. All transports route through it. Fail-closed duplicate/risk; capability-Symbol privileged seams; audit failures surfaced. | None for the core; the gap is legacy ownership below. |
| Tool ownership | **converged (B1/B2 done)** | Re-measured on current `main`: **zero legacy-owned handler bodies**. `TOOL_DEFS`=106 rows; the default registry is 112 with the 6 module-owned `data-utilities` tools. `src/tools-legacy.js` is about 1,500 lines of policy/approval/audit machinery, ordering anchors, compute pass-through wiring, and compatibility exports. | Optional follow-up: relocate the policy/approval machinery out of the legacy file and retire compatibility exports. |
| Dashboard `/api/db/*` dispatch | **fixed (#238)** | `/api/db/query` routed through `callDashboardTool` (write mode preserved but governed); `db/search` identifiers escaped. Remaining read-only `/api/db/*` routes are a deferred lower-value follow-up (network-gated by the blanket dashboard auth middleware). | — |
| DB-backed tool catalog | **duplicated** | `syncToolRegistry`→`tools` tables mirror the registry, feed agent allowlist + dashboard; drift mitigated by intersection, not eliminated. | Derive catalog from the registry, or document the mirror as intentional. |
| Module lifecycle — activation half | **production-complete for bundled and installed modules** | Activation, registry, policy, audit, disable, reconciliation, and health use the one registry. Integrity is checked before entry loading, and module state is preserved across process restarts. | Installed code remains trusted executable code, not sandboxed. |
| Module lifecycle — third-party half | **production-complete (B9)** | Managed module storage, safe inspection, whole-package and entry integrity verification, compatibility/configuration checks, install/configure/enable/disable/upgrade/uninstall, and derived health are implemented and exercised by the bundled Developer pack. | Installed code remains trusted executable code, not sandboxed; marketplace distribution is not implemented. |
| `platform_extensions` registry | **duplicated** | Kernel `platform_extensions` CRUD (`kernel.js:1759-1825`) is a second module-ish lifecycle, unconnected to `platform_modules`. | Converge or retire. |
| Projects — canonical identity | **foundation-only (B3-1 landed)** | B3-1 (#246) added `src/core/project-identity.js` (`canonicalizeProjectName`: lowercase, non-`[a-z0-9_]` runs → `_`, trim underscores) and a `normalizeProjectId` choke point in the kernel registry functions, with display-name/original-spelling preservation on first registration. Registry still has **zero production callers**; kernel writers (`startExecution`, `appendEvent`, `createProjectWorkspace`) still accept raw `project_id`; `backfillProjectSources` still has no invocation surface; pre-B3-1 mixed-case registry rows are not converged; `createScopeSnapshot` does not canonicalize. | Remaining B3 slices: real callers in kernel/memory/KV writers; adapters replacing the three inference derivations; backfill invocation surface; legacy-row convergence; boundary policy for unvalidated tool schemas. |
| Projects — production identity | **duplicated** | Free-text `project` string assigned by NL regex (`inferProjectFromText`, `memory.js:160`), three independent derivations (`memory.js`, `agent.js:927`, `context.js:37`). Live list = `kv_store.project` DISTINCT scan. Parallel: `ctx.projects{}` JSON doc, plus per-feature project columns. | Converge on the canonical projection via adapters. |
| Cross-project isolation | **missing** | Per-query opt-in `WHERE project = ?` only; no enforcement boundary; `checkCapability`/`platformGuard` capability path is dead in production (no call site passes `capability`+`actor_id`). | Enforcement boundary + isolation tests. |
| Workspaces + encrypted secrets | **production-complete impl, foundation-only deployment** | Fail-closed envelopes, plaintext writers closed, loss-averse backfill. Zero production callers. | Wire to a tool/route; trigger backfill. |
| Identity / teams / memberships | **foundation-only (below the bar)** | PR #235 = 19-line in-memory `Map`s, no migration/tables, no auth/authz integration, `authorize()` ignores `project_id`, no audit events. Its test is now registered in CI (#236). | Durable tables (mig 036), single-operator bootstrap, capability bridge, API/UI. |
| Deployment profiles | **foundation-only + duplicated** | In-memory, `required_checks` never evaluated. `MISSION_PROFILES` (`tools-legacy.js:6786`) is a separate, production-wired profile vocabulary. | Make profiles enforce runtime behavior; reconcile with mission profiles. |
| Single-operator auth | **production-complete** | Shared bearer key (MCP), env-var dashboard user (fails closed correctly), per-worker credentials, `meta.user_id` (memory sync). | Bootstrap path to a durable owner user when identity lands. |
| Durable executions | **production-usable but partial (projection)** | `platform_executions` written by 8 producers, all best-effort/try-catch-swallowed; authoritative state lives in per-feature JSON/tables. Recovery (`recoverOrphaned*`) is the load-bearing exception. | Make the ledger authoritative for ≥1 runner. |
| Execution claims/leases | **production-usable but partial** | Correct epoch-fenced claims used by 4 runners (cron/delay/watch/runbook) via shared helpers, now in `src/tools/scheduled-execution.js` (extracted during B2). | Converge 3 claim implementations behind one contract (B4). |
| Checkpoints / cancel | **foundation-only (half-wired)** | `checkpointExecution` zero prod callers. `requestExecutionCancel` zero prod writers but 6+ prod readers — a built cancel loop with a test-only writer. | Wire cancel (~10 lines); wire or delete `checkpoint_json`. |
| Workflow runner | **production-usable (pack workflows)** | Capability-pack workflow definitions are registered and executed through `src/workflows/runner.js` using the existing kernel execution primitives, durable state, checkpoints, cancellation, approval continuation, and the single tool dispatcher. | The broader kernel surface still has residual APIs beyond the pack workflow path; no second workflow engine should be introduced. |
| Non-durable runners | **partial** | `mission` (router), `queue`/`orchestrate` (JSON, look durable), `retry` (in-process — loses work on crash). | Bring onto claims or document as non-durable. |
| Brain / approvals continuation | **production-complete (separate stack)** | `task_checkpoints`, `continuation.js` (1576 lines), sweeper, resume scheduler — production-wired; touches kernel via correlation fields only. | Keep distinct; do not force cosmetic unification. |
| Events — publish | **production-complete (B5)** | 14 prod publish sites + ~58 kernel-internal `appendEvent`; auto-enqueue into deliveries. Fan-out now runs **inside** the insert transaction, so an event cannot commit without its deliveries. `sensitivity` and `source` are validated at publish; `causation_id` is populated from the execution-transition chain and from the ambient delivery context. | — |
| Events — delivery/consume | **production-wired (B5)** | `src/platform/event-drainer.js` polls pending/retry, claims atomically, recovers stale `in_flight` claims, and runs handlers registered by subscription **name**; started from `src/index.js`. Four built-in failure consumers (`execution.failed`/`timed_out`/`rollback_failed`, `module.health.alert`) mean offsets advance in production. `src/platform/event-vocabulary.js` enforces `event_type` shape at subscription time and reports unknown namespaces. Delivery redacts any payload not stored redacted before it reaches a handler (44% of the ledger is `redaction_state: none`), reporting `redacted_by_delivery`/`original_redaction_state`, with an explicit per-subscription `accepts_unredacted` opt-in; fan-out withholds events above a subscription's `max_sensitivity` ceiling. | `appendEvent` still unauthorized (provenance is shape-validated, but single-operator mode has no durable actor identity to authorize against — Track C); offsets are not used for replay/backfill. |
| Events — operational hazard | **fixed (B5)** | Fan-out probes undelivered depth (`pending`/`retry`/`in_flight`, bounded `LIMIT cap + 1`) and auto-pauses the subscription at `SIDEKICK_EVENT_BACKLOG_CAP` (default 10000), recording `auto_pause_reason`. Publishers are never blocked or failed by a stalled consumer. Deliveries with no registered handler are left `pending` and counted, never acked. | — |
| Artifacts — kernel custody | **production-complete (write path)** | Insert-only identity, digest regex, role/lineage invariants (`kernel.js:874-883`). No recursive-lineage read API; no `storage_ref` byte resolver. | Lineage read API; retention (no sweeper/`deleted_at` writer exists). |
| Artifacts — convergence | **converged for the worker path (B6)** | Re-measured before the fix: **10 of 10** production `compute_artifacts` arrived via the worker HTTP upload path and **0** were in the kernel; the inline mirror the audit flagged had executed **zero** times in production, so its empty `catch {}` was not the live gap. `finalizeArtifact` now registers with the kernel through `src/compute/artifact-custody.js` under the compute artifact id (idempotent via primary key); failures are recorded on the row, published as `compute.artifact_custody_failed`, and logged. Dry-run-first orphan reconciler via `compute_jobs action="reconcile_artifact_custody"`. | `compute_artifacts` schema still duplicated in migrations + `job-manager.js`; blackbox files and session JSON remain separate models. |
| Artifacts — access auth | **network-gated; project scoping missing** | `GET /api/artifacts` has no per-route auth, but the blanket dashboard auth middleware (`dashboard.js:373`, active whenever `DASHBOARD_USER`/`DASHBOARD_PASS` are set — they are in production) gates every route, so it is not an open endpoint. It has no `project_id` scoping and never invokes `checkCapability`. | Project scoping / capability check (deferred; not an auth bypass). |
| Connectors — lifecycle | **production-complete (records)** | Registration/config/state-machine/redaction-on-write + REST endpoints. | — |
| Connectors — integrations | **production-usable but partial (B7 keystone)** | GitHub is registered as a managed connector; the `github` tool routes endpoint and secret references through the connector authority, and `connector` provides read-only inspection. Health checks, mutating connector management, and broader provider coverage remain follow-up work. | Extend governed connector traffic and dashboard coverage without creating a parallel provider authority. |
| Compute — providers/models/workers/jobs/placement | **production-complete** | provider-registry (circuit breaker), model-registry, worker lifecycle 022/023/024, transactional job claim, placement decision core, OpenVINO manifest. **Do not rewrite.** | — |
| `platform_model_registry` | **deprecated (B8)** | Still zero production callers. Deprecated in place with an explicit "do not add callers" contract and no sync bridge, since a bridge would make the duplication permanent. `test/compute-model-dedup.test.js` fails if production code starts calling it. | Delete outright once the schema/test dependency is retired. |
| `capability-router` selector | **converged (B8)** | Now imports `placement.TRUST_ORDER` rather than declaring a second copy, and both `selectProvider` and `selectWithFallback` compare trust against the request floor (defaulting to `trusted`, as placement does). Re-measured severity: both are reachable ONLY from `explainRouting`; real inference dispatches through `placement.rankProviderCandidates`, so the divergence produced misleading `explain` output, not misrouted data. | — |
| Compute schema parity | **partial (dead code cleared, B8)** | Every compute table defined in migrations *and* runtime `ensureSchema`; 16 indexes exist only in migrations; parity test still covers `platform_%` only. `checkWorkersOffline` REMOVED — it was superseded by `reconcileWorkerStates`, writing only the legacy `state` column while ignoring `connection_state`, `disconnected_at`, `last_disconnect_reason` and `admin_state` preservation, so calling it would have corrupted the state model. `health_state` is no longer inert: earned on heartbeat, reset to `unknown` when contact lapses. | `compute_%` parity test. |
| Ungoverned model literals | **converged for production inference** | Agent Bridge, memory/context embeddings, and `llm`/`embed` route through the Compute inference service and placement layer. Direct Ollama access remains only for the `ollama` model-administration tool and provider adapters. | Keep new inference callers on the Compute authority; do not add direct provider fallback trees. |
| Security-research domain | **production-usable but bounded** | The bundled Security Research pack provides governed campaign/project, hypothesis, scope, run, probe, evidence, comparison, validation, and report tools plus workflows. Probes compose the normal `bash`/`web_fetch` dispatcher paths; the pack enforces scope, integrity, redaction, and a public/private workspace boundary. | Lab provisioning and some optional integrations are configuration-dependent; this is not an unrestricted research shell or a Proxmox-specific system. |
| Security-research external transport | **UNAVAILABLE (correctly classified)** | Adapter contract-only; transport injected, `request()` throws before I/O. No client/endpoint/auth anywhere. Docs are honest. | None — leave unavailable; test the unavailable state. |
| Security-research fixtures | **synthetic ✓** | Only `example.test`/`synthetic-*`; zero real hosts/CVEs/tokens. `data/sidekick.db` untracked; `backups/` gitignored. Digest-only target projection verified. | No confidential research present. Preserve this. |
| Evaluation / replay | **foundation-only** | 21 lines, pure, non-durable, zero production callers. Side-effect invariant holds structurally (no dispatcher reference; actions hardcoded `[]`; records rejected otherwise) but it is an unused pure function, not a runtime sandbox. `evaluateReplay` without an expected digest returns `ok:true`. | Durable records, execution/artifact linkage, regression diff, operator surface — all optional product work. |
| Dashboard control plane | **partial** | The dashboard now exposes Mission Control, tools, approvals, memory/data, capabilities, Compute, agent tasks, and metrics. Some kernel-mediated objects and artifact authorization remain without dedicated UI or project scoping; dashboard auth remains opt-in and SQL mutations are governed through the tool boundary. | Continue UI coverage and identity/project scoping as Track C work. |
| Persistence — migration self-containment | **fixed (#236)** | C1 resolved: migrations build the schema standalone; a migrations-only boot succeeds. | — |
| Persistence — cross-process schema | **fixed (#236, #237)** | C2 resolved: idempotent `ADD COLUMN` path; runtime-then-migration boot no longer collides. PR #237 additionally fixed builtin-module entry-hash re-binding on a legitimate release change (attested rebind for `builtin` modules only; tamper case stays fail-closed). | — |
| Persistence — runtime-only schema | **partial** | 23 columns across 5 tables (`tool_logs`×11, `predictions`×4, etc.) exist in no migration; `setupFTS5` DROP+recreates ~66 unversioned virtual tables. Single `schema_version` int, no per-migration ledger, no down-migrations. | Migrate the columns; version FTS setup. |
| Module migration isolation | **production-complete** | `src/modules/migrations.js`: denylist + allowlist + `platform_` restriction + real tokenizer + atomic batch + pre-validation fail-closed. No gaps. | — |

## Systemic findings

1. ~~9 orphaned test suites~~ **Resolved (#236).** All previously orphaned
   suites are registered in `test/run-all.js` (as `critical: false`) and run in
   CI; 106 test files are registered at `5e4dbfd`.
2. **The "zero production callers" pattern is still the dominant residual gap.**
   ~90 kernel exports have no production caller: canonical projects (the
   registry, even after B3-1), workspaces/secrets, workflows, runner sessions,
   all security-research functions, `platform_model_registry`, RBAC
   (`grant/revoke/checkCapability`), backups/releases/extensions,
   `requestExecutionCancel`/`checkpointExecution`. (Event delivery/consumption
   left this list in B5.) The
   authoritative platform tier is largely a test-only artifact. Convergence
   means wiring these into production, not adding more of them.
3. ~~Two verified startup-correctness bugs (C1, C2)~~ **Resolved (#236).**
   Migrations are self-contained and the runtime-ensure path is idempotent.

## Exit criteria for this campaign

Convergence is complete when, with evidence:

1. One authoritative descriptor/registry/dispatcher path (already true; keep it).
2. `src/tools-legacy.js` owns zero production handlers, or any remainder is
   documented as an intentional blocker.
3. Module lifecycle is usable by a real independently packaged module
   (discover→install→configure→activate→dispatch→health→disable→upgrade),
   permission-bounded and integrity-checked.
4. Platform persistence builds correctly from migrations alone (C1 fixed) and
   runtime startup does not silently create undocumented schema needed for
   normal operation, and cannot wedge boot (C2 fixed).
5. Projects/authorization have one coherent identity boundary with real callers.
6. Durable execution primitives are used by their intended production callers;
   cancel/checkpoint are wired or removed.
7. ~~Events have a production consumer/drainer where the architecture requires
   one, or subscriptions are prevented from accumulating unbounded.~~ **Met
   (B5).** Both, in fact: the drainer runs in the MCP process with built-in
   consumers, and the backlog cap bounds any subscription nothing drains.
8. Artifacts have one custody authority; the worker path registers with it.
9. Connectors have one lifecycle model with ≥1 real provider distinguished from
   the generic contract; secret refs resolve.
10. Compute/model ownership has clear authority without weakening placement or
    worker-trust; duplicate registries deprecated.
11. Security-research functionality accurately separates generic capability,
    confidential external data (never in this repo), and unavailable external
    integration (tested as unavailable).
12. Evaluation/replay is side-effect-safe (keep) and either useful or explicitly
    optional.
13. Multi-user/identity is genuinely production-ready or explicitly optional —
    not falsely labeled complete; single-operator mode preserved.
14. Dashboard coverage matches the supported operator lifecycle through
    authoritative services.
15. The full suite passes with **all** suites registered; no test asserts an
    unavailable integration succeeded; no confidential research fixtures.
16. Documentation describes the code at the final commit.

## Document status

| Document | Status | Note |
|---|---|---|
| `platform-convergence-audit.md` | CURRENT | This file; changed rows re-verified at `5e4dbfd`. |
| `platform-roadmap.md` | CURRENT | Track A/B1/B2 marked done; B3-1 recorded; next work updated. |
| `platform-target-architecture.md` | CURRENT (direction) | Direction still valid. |
| `tool-architecture.md` | CURRENT | Reconciled at `5e4dbfd`: zero legacy handlers; 96 family + 6 module + 6 compute. |
| `ROADMAP.md` | CURRENT (product) | Rebuilt 2026-08-12: current status plus clearly-labeled feature history. |
| `architecture.md`, `data-model.md` | CURRENT | Reconciled at `5e4dbfd`; kernel sections carry production-integration status notes. |
