# Platform Convergence Audit

Status: Current-state audit (post-handoff convergence campaign)
Verified commit: 5e4dbfdb04c9878cbbd284bd950a6afbef78eec3
Verified date: 2026-08-12
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
| Tool ownership | **converged (B1/B2 done)** | Re-measured at `5e4dbfd`: **zero legacy-owned handler bodies**. 96 family-owned across 38 registered family files, 6 module-owned (`data-utilities`), 6 compute tools in `src/compute/tools.js` behind pass-through wiring. `TOOL_DEFS`=102 rows; registry 102/108 (module off/on). 1 alias (`modules`). `tools-legacy.js`=1,439 lines: policy/approval/audit machinery, ordering anchors, compatibility exports. | Optional follow-up: relocate the policy/approval machinery out of the legacy file and retire compatibility exports. |
| Dashboard `/api/db/*` dispatch | **fixed (#238)** | `/api/db/query` routed through `callDashboardTool` (write mode preserved but governed); `db/search` identifiers escaped. Remaining read-only `/api/db/*` routes are a deferred lower-value follow-up (network-gated by the blanket dashboard auth middleware). | — |
| DB-backed tool catalog | **duplicated** | `syncToolRegistry`→`tools` tables mirror the registry, feed agent allowlist + dashboard; drift mitigated by intersection, not eliminated. | Derive catalog from the registry, or document the mirror as intentional. |
| Module lifecycle — activation half | **production-usable but partial** | activation→registry→policy→audit→disable→health all wired, through the one registry (`registry.js:36-40`). Integrity re-hash at activation (`loader.js:182-197`). Only the built-in `data-utilities` module exercises it. | Health scheduling iterates `BUILTIN_MODULES` only. |
| Module lifecycle — third-party half | **foundation-only** | discovery/inspection/packaging/installation/configuration implemented + tested (tests registered in CI since #236), **zero `src/` callers**. No entry loader ever `require()`s `entry_point`; a third-party module can reach `configured` but never `enabled`. `package_hash` computed, never persisted/verified. Upgrade/uninstall contract-only. Install confined to repo root. | Entry loader, package-hash binding, operator actions, health for non-builtins, sandbox story (B9). |
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
| Workflow runner | **foundation-only (dead)** | `platform_workflows`/`_steps`/`_runner_sessions` + 8 kernel fns: zero production callers. mig 026 exists for boot parity only. | Adopt for one runner or delete. |
| Non-durable runners | **partial** | `mission` (router), `queue`/`orchestrate` (JSON, look durable), `retry` (in-process — loses work on crash). | Bring onto claims or document as non-durable. |
| Brain / approvals continuation | **production-complete (separate stack)** | `task_checkpoints`, `continuation.js` (1576 lines), sweeper, resume scheduler — production-wired; touches kernel via correlation fields only. | Keep distinct; do not force cosmetic unification. |
| Events — publish | **production-complete** | 14 prod publish sites + ~58 kernel-internal `appendEvent`; auto-enqueue into deliveries. | `enqueue` is outside the insert txn (fan-out can be silently lost). |
| Events — delivery/consume | **foundation-only (no consumers)** | `deliverEvent` referenced only by kernel + test. **No drainer** polls pending/retry deliveries. Offsets written, never read. `causation_id` never set. No event schema/vocabulary. `appendEvent` unauthorized; delivery ignores sensitivity. | Drainer + handler registry + vocabulary; cap subscription backlog. |
| Events — operational hazard | **partial** | `POST /api/event-subscriptions` creates a subscription → unbounded `pending` accumulation with nothing to drain it. | Backlog cap/TTL, or ship the drainer first. |
| Artifacts — kernel custody | **production-complete (write path)** | Insert-only identity, digest regex, role/lineage invariants (`kernel.js:874-883`). No recursive-lineage read API; no `storage_ref` byte resolver. | Lineage read API; retention (no sweeper/`deleted_at` writer exists). |
| Artifacts — convergence | **duplicated** | 4 active models (platform, compute, blackbox files, session JSON). Worker HTTP upload path (`worker-agent.js:558-572`) never registers in the kernel; the inline mirror swallows errors. `compute_artifacts` schema duplicated in migrations + `job-manager.js`. | Register worker artifacts in kernel; surface mirror failures. |
| Artifacts — access auth | **network-gated; project scoping missing** | `GET /api/artifacts` has no per-route auth, but the blanket dashboard auth middleware (`dashboard.js:373`, active whenever `DASHBOARD_USER`/`DASHBOARD_PASS` are set — they are in production) gates every route, so it is not an open endpoint. It has no `project_id` scoping and never invokes `checkCapability`. | Project scoping / capability check (deferred; not an auth bypass). |
| Connectors — lifecycle | **production-complete (records)** | Registration/config/state-machine/redaction-on-write + REST endpoints. | — |
| Connectors — integrations | **foundation-only (governs no traffic)** | Only provider is a declared stub; no connector-type→implementation dispatch. All real integrations (GitHub/Slack/Ollama/OpenAI) bypass the framework. `secret:` refs regex-validated but **unresolvable** (no bridge to secret store). No project binding; no UI. (The connector read endpoints have no per-route auth, but are network-gated by the blanket dashboard auth middleware like every route; the mutation routes' per-route `authenticatedUser` checks are for actor attribution, not gating — verified not an auth bypass, A4.) | First real provider through the framework; secret-ref resolver. |
| Compute — providers/models/workers/jobs/placement | **production-complete** | provider-registry (circuit breaker), model-registry, worker lifecycle 022/023/024, transactional job claim, placement decision core, OpenVINO manifest. **Do not rewrite.** | — |
| `platform_model_registry` | **duplicated** | Zero production callers (only tests); a second model registry parallel to `compute_models`. | Deprecate/demote; do not build a sync bridge. |
| `capability-router` selector | **duplicated (trust-unaware)** | Own `TRUST_ORDER` missing `private`; `selectProvider` never compares trust; reachable read-only via `compute_route explain`; can contradict `decidePlacement`. | Import placement trust or derive from `rankProviderCandidates`. |
| Compute schema parity | **partial** | Every compute table defined in migrations *and* runtime `ensureSchema`; 16 indexes exist only in migrations; parity test covers `platform_%` only. Dead `checkWorkersOffline`; inert `health_state` column. | `compute_%` parity test; remove dead code. |
| Ungoverned model literals | **partial** | `memory.js:14/289` embeddings bypass classification/trust gates; also `tools-legacy.js`, `agent.js` hardcoded Ollama endpoints. | Route through `inferenceService` with logged fallback. |
| Security-research domain | **foundation-only (records/contract)** | ~330 net lines. Records-only CRUD in the generic kernel; no MCP tools, no UI (3 scope JSON endpoints only). Scope Guard fail-closed **as a function**, not attached to dispatch. No installable module. | Wire tools/UI/dispatch attachment only against verified interfaces. |
| Security-research external transport | **UNAVAILABLE (correctly classified)** | Adapter contract-only; transport injected, `request()` throws before I/O. No client/endpoint/auth anywhere. Docs are honest. | None — leave unavailable; test the unavailable state. |
| Security-research fixtures | **synthetic ✓** | Only `example.test`/`synthetic-*`; zero real hosts/CVEs/tokens. `data/sidekick.db` untracked; `backups/` gitignored. Digest-only target projection verified. | No confidential research present. Preserve this. |
| Evaluation / replay | **foundation-only** | 21 lines, pure, non-durable, zero production callers. Side-effect invariant holds structurally (no dispatcher reference; actions hardcoded `[]`; records rejected otherwise) but it is an unused pure function, not a runtime sandbox. `evaluateReplay` without an expected digest returns `ok:true`. | Durable records, execution/artifact linkage, regression diff, operator surface — all optional product work. |
| Dashboard control plane | **partial** | Kernel-mediated endpoints (connectors/events/scope/artifacts) have **no UI**; UI endpoints (memory/evolve/predict/blackbox/compute/db) bypass the kernel. Auth is opt-in; `readonly:false` SQL route; `static/dashboard.js:562` calls a nonexistent route. | UI for authoritative objects; route UI mutations through services. |
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
   (`grant/revoke/checkCapability`), backups/releases/extensions, event
   delivery/consumption, `requestExecutionCancel`/`checkpointExecution`. The
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
7. Events have a production consumer/drainer where the architecture requires
   one, or subscriptions are prevented from accumulating unbounded.
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
