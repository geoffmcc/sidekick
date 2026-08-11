# Platform Convergence Audit

Status: Current-state audit (post-handoff convergence campaign)
Verified commit: a88ea84577283899b2f02892e1dcbe9be0dcf509
Verified date: 2026-08-11
Supersedes: the 2026-08-05 audit pinned to `d2db2658` (45 PRs stale).

## Method

Measured directly from code at `a88ea84`. Handoffs, prior audits, roadmap
documents, PR descriptions, and phase numbers were treated as historical
evidence and re-checked against the implementation. Every classification below
is backed by a call-site or an empirical test, not by a documentation claim.

Baseline test run at this commit: `node test/run-all.js` → **93 passed, 0
failed, 0 skipped**. Critically, **9 test files exist but are not registered in
`test/run-all.js`**, so CI never runs them (see Systemic Findings).

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
| Tool ownership | **compatibility-owned (62%)** | Measured: **67 legacy-owned handlers** (61 in `tools-legacy.js` + 6 delegated to `compute/tools.js`), **41 family-owned** across 15 family files. `TOOL_DEFS`=102 rows; registry 102/108 (module off/on). 1 alias. `tools-legacy.js`=10,766 lines and has *grown* since the last extraction. | Extract remaining 67 in dependency order; ~825 lines dead legacy code to remove first. |
| Dashboard `/api/db/*` dispatch | **production-usable but partial** | 6 routes call `dbStore` directly with only `enforceToolPolicy` as an HTTP guard — skip Zod validation, approvals, redaction, audit. `POST /api/db/query` honors `readonly:false` → arbitrary SQL. | Delegate to `callDashboardTool` (`database-inspection` family already implements identical semantics). |
| DB-backed tool catalog | **duplicated** | `syncToolRegistry`→`tools` tables mirror the registry, feed agent allowlist + dashboard; drift mitigated by intersection, not eliminated. | Derive catalog from the registry, or document the mirror as intentional. |
| Module lifecycle — activation half | **production-usable but partial** | activation→registry→policy→audit→disable→health all wired, through the one registry (`registry.js:36-40`). Integrity re-hash at activation (`loader.js:182-197`). Only the built-in `data-utilities` module exercises it. | Health scheduling iterates `BUILTIN_MODULES` only. |
| Module lifecycle — third-party half | **foundation-only (orphaned)** | discovery/inspection/packaging/installation/configuration implemented + tested, **zero `src/` callers**. No entry loader ever `require()`s `entry_point`; a third-party module can reach `configured` but never `enabled`. `package_hash` computed, never persisted/verified. Upgrade/uninstall contract-only. Install confined to repo root. Its 3 tests are orphaned (not in CI). | Entry loader, package-hash binding, operator actions, health for non-builtins, sandbox story. |
| `platform_extensions` registry | **duplicated** | Kernel `platform_extensions` CRUD (`kernel.js:1759-1825`) is a second module-ish lifecycle, unconnected to `platform_modules`. | Converge or retire. |
| Projects — canonical identity | **foundation-only** | `platform_projects`/`_project_sources`/workspace/secret API (mig 027, `kernel.js:1405-1720`) durable + tested, **zero production callers**. Kernel writers accept `project_id` but never `registerProject`; no consumer FK. `backfillProjectSources`/`backfillWorkspaceSecrets` have no invocation surface. | Register projects inside kernel writers; add an invocation surface for backfills; API/UI. |
| Projects — production identity | **duplicated** | Free-text `project` string assigned by NL regex (`inferProjectFromText`, `memory.js:160`), three independent derivations (`memory.js`, `agent.js:927`, `context.js:37`). Live list = `kv_store.project` DISTINCT scan. Parallel: `ctx.projects{}` JSON doc, plus per-feature project columns. | Converge on the canonical projection via adapters. |
| Cross-project isolation | **missing** | Per-query opt-in `WHERE project = ?` only; no enforcement boundary; `checkCapability`/`platformGuard` capability path is dead in production (no call site passes `capability`+`actor_id`). | Enforcement boundary + isolation tests. |
| Workspaces + encrypted secrets | **production-complete impl, foundation-only deployment** | Fail-closed envelopes, plaintext writers closed, loss-averse backfill. Zero production callers. | Wire to a tool/route; trigger backfill. |
| Identity / teams / memberships | **foundation-only (below the bar)** | PR #235 = 18-line in-memory `Map`s, no migration/tables, no auth/authz integration, `authorize()` ignores `project_id`, no audit events, **test not in CI**. | Durable tables (mig 036), single-operator bootstrap, capability bridge, API/UI. |
| Deployment profiles | **foundation-only + duplicated** | In-memory, `required_checks` never evaluated. `MISSION_PROFILES` (`tools-legacy.js:6786`) is a separate, production-wired profile vocabulary. | Make profiles enforce runtime behavior; reconcile with mission profiles. |
| Single-operator auth | **production-complete** | Shared bearer key (MCP), env-var dashboard user (fails closed correctly), per-worker credentials, `meta.user_id` (memory sync). | Bootstrap path to a durable owner user when identity lands. |
| Durable executions | **production-usable but partial (projection)** | `platform_executions` written by 8 producers, all best-effort/try-catch-swallowed; authoritative state lives in per-feature JSON/tables. Recovery (`recoverOrphaned*`) is the load-bearing exception. | Make the ledger authoritative for ≥1 runner. |
| Execution claims/leases | **production-usable but partial** | Correct epoch-fenced claims used by 4 runners (cron/delay/watch/runbook) via shared helpers **in `tools-legacy.js`**. | Extract the helper module; converge 3 claim implementations behind one contract. |
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
| Persistence — migration self-containment | **BROKEN (verified)** | **C1**: pure-migration boot fails at `007` (`no such column: session_id`) — reproduced empirically. `007` indexes `tool_logs.session_id`/`task_id`, added only by runtime `db.js`. Migrations are not a standalone schema. | Make migrations self-contained. |
| Persistence — cross-process schema | **BROKEN (verified)** | **C2**: runtime `ensureSchema` creates `compute_*` columns; migrations 014–024 bare `ALTER ... ADD COLUMN` (no guard) → `duplicate column name` → fatal MCP boot. Reproduced empirically. Dashboard runs `compute.initialize()` without migrating. | Idempotent ALTER path; gate runtime ensures on migration completion. |
| Persistence — runtime-only schema | **partial** | 23 columns across 5 tables (`tool_logs`×11, `predictions`×4, etc.) exist in no migration; `setupFTS5` DROP+recreates ~66 unversioned virtual tables. Single `schema_version` int, no per-migration ledger, no down-migrations. | Migrate the columns; version FTS setup. |
| Module migration isolation | **production-complete** | `src/modules/migrations.js`: denylist + allowlist + `platform_` restriction + real tokenizer + atomic batch + pre-validation fail-closed. No gaps. | — |

## Systemic findings

1. **9 orphaned test suites** (`compute-jobs-mcp-contract`, `evaluation-replay`,
   `identity-deployment`, `modules-discovery`, `modules-installation`,
   `modules-packaging`, `security-research-adapter`,
   `security-research-evidence-vault`, `security-research-lab-policy`) exist and
   pass individually but are absent from `test/run-all.js`, so CI never runs
   them. Every headline foundation from PRs #227–#235 and the module third-party
   path is unverified in CI. **This is the highest-leverage, lowest-risk fix.**
2. **The "zero production callers" pattern is pervasive.** ~90 kernel exports
   have no production caller: canonical projects, workspaces/secrets, workflows,
   runner sessions, all 21 security-research functions, `platform_model_registry`,
   RBAC (`grant/revoke/checkCapability`), backups/releases/extensions. The
   authoritative platform tier is largely a test-only artifact. Convergence means
   wiring these into production, not adding more of them.
3. **Two verified startup-correctness bugs (C1, C2)** in the persistence layer,
   both reproduced empirically, both in the migration/runtime-ensure region that
   the parity test does not cover (`compute_*`, `tool_logs`).

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
| `platform-convergence-audit.md` | CURRENT | This file. |
| `platform-roadmap.md` | CURRENT | Rewritten for the residual roadmap. |
| `platform-target-architecture.md` | CURRENT (direction) | Direction still valid; header reverified. |
| `tool-architecture.md` | NEEDS COUNT CORRECTION | 40→41 family / 67 legacy; extraction stalled. |
| `ROADMAP.md` | STALE (product) | June-era "90 tools" list; product-facing, corrected header pending. |
| `architecture.md`, `data-model.md` | PARTIALLY CURRENT | Core accurate; kernel/compute coverage incomplete. |
