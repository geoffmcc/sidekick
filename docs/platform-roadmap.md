# Platform Roadmap

Status: Residual completion roadmap (post-handoff convergence campaign)
Verified commit: 5e4dbfdb04c9878cbbd284bd950a6afbef78eec3
Verified date: 2026-08-12
Supersedes: the 2026-08-05 three-track roadmap pinned to `d2db2658`.

The prior 8-phase roadmap is fully committed (PRs #191–#235). Measurement of
those commits (`platform-convergence-audit.md`) showed the platform had broad
foundations but thin production integration. Since that audit, Track A completed
(PRs #236, #238), the entire legacy handler decomposition landed (B1–B2, PRs
#240–#245), and the first project-identity slice landed (B3-1, PR #246). Many
kernel exports still have no production caller; wiring them is the remaining
campaign, not adding another foundation layer.

Work is classified into four tracks. **Convergence tracks (A–C) are the
campaign; product track (D) is explicitly optional.**

## Track A — Correctness and verification (do first; small, high-value)

Track A is complete (PRs #236, #238).

| # | Slice | Status | Bounded goal / resolution |
|---|---|---|---|
| A1 | Register orphaned tests | **done** (#236) | 9 CI-excluded suites registered; suite runs green. |
| A2 | Migration self-containment (C1) | **done** (#236) | Migrations build the schema standalone; migrations-only boot succeeds. |
| A3 | Cross-process schema safety (C2) | **done** (#236) | Idempotent `ADD COLUMN`; runtime-then-migration boot no longer collides. |
| A4 | Dashboard SQL/auth hardening | **done** (#238) | `/api/db/query` routed through `callDashboardTool` (write mode preserved but governed); `db/search` identifiers escaped. Auth-on-reads: verified the flagged read endpoints are network-gated by the blanket dashboard auth middleware (not an auth bypass); no change made. Routing the remaining read-only `/api/db/*` routes is a deferred lower-value follow-up. |

## Track B — Architectural convergence (dependency-ordered)

| # | Slice | Status | Bounded goal | Completion evidence |
|---|---|---|---|---|
| B1 | Dead legacy removal | **done** (#240) | Remove unreachable code from `tools-legacy.js` (legacy context block, `evolve` tail, orphans). | 1,163 dead lines removed; suite green; no export lost. |
| B2 | Legacy handler extraction | **done** (#241–#245) | Extract the 67 legacy handlers in the documented dependency order. Each a reviewable slice. | Zero production handlers in `tools-legacy.js` (now ~1,440 lines of policy/approval/audit machinery, ordering anchors, and compatibility exports); 96 family-owned + 6 module-owned + 6 compute tools; no family imports legacy at init. |
| B3 | Canonical project identity | **started** (B3-1, #246) | Register projects inside kernel writers; add adapters from the inferred string; invocation surface for backfills. | B3-1 delivered the shared canonicalization function (`src/core/project-identity.js`) and the kernel-registry choke point. Remaining: real callers in kernel/memory/KV writers, adapters replacing the three independent inference derivations, an invocation surface for `backfillProjectSources`, convergence of pre-existing mixed-case registry rows, `createScopeSnapshot` canonicalization, and a boundary policy for the ~11 unvalidated tool schemas. Isolation is untouched. |
| B4 | Execution convergence | pending | Make the ledger authoritative for one runner; wire `requestExecutionCancel`; wire or delete `checkpoint_json`; converge 3 claim implementations behind one contract. | Production caller uses the contract; cancel loop closed. (The shared claim helpers moved to `src/tools/scheduled-execution.js` during B2.) |
| B5 | Event consumption | pending | Add a delivery drainer + handler registry + event vocabulary; cap subscription backlog; move enqueue into the insert transaction. | A production consumer drains deliveries; hazard removed. |
| B6 | Artifact custody convergence | pending | Register worker-uploaded artifacts in the kernel; surface (not swallow) mirror failures; add artifact access auth. | One custody authority for the worker path. |
| B7 | Connector integration | pending | One real provider through the framework; secret-ref resolver bridging to the secret store. | A real integration governed by `platform_connectors`. |
| B8 | Compute/model dedup | pending | Deprecate `platform_model_registry` writers; make `capability-router` trust-aware; remove dead `checkWorkersOffline`; wire or drop `health_state`. | Single model authority; no trust-unaware selector. |
| B9 | Module third-party path | pending | Entry loader for verified `entry_point`; persist+verify `package_hash`; operator install/configure/upgrade/uninstall; health for non-builtins; converge/retire `platform_extensions`. | A synthetic third-party module completes the full lifecycle. |

## Track C — Foundation-to-production (only where the audit shows a real gap)

| # | Slice | Bounded goal | Completion evidence |
|---|---|---|---|
| C1 | Security-research wiring | Wire the generic domain records to tools/dashboard/dispatch **only against verified interfaces**; attach Scope Guard to dispatch; fix the disclosure create-path gate; validate evidence refs. External transport stays unavailable and is tested as such. Synthetic data only. | Fail-closed, human-gated, auditable; no confidential data; unavailable transport tested. |
| C2 | Durable identity (if pursued) | Durable users/teams/memberships tables (mig 036), single-operator bootstrap, capability bridge, API/UI, isolation tests. | Real persistence + authorization + audit, or explicitly deferred as product work. |
| C3 | Evaluation/replay usefulness (optional) | Durable records + execution/artifact linkage + regression diff + operator surface, preserving side-effect safety. | Reproducible comparison, or explicitly deferred. |

## Track D — Optional future product features (not convergence blockers)

Marketplace/module distribution, external research-workbench integration (needs a
verified transport first), RBAC beyond bounded roles, RSS/activity APIs. These do
not block convergence and must not be treated as exit criteria.

## Exit criteria

See `platform-convergence-audit.md` § "Exit criteria for this campaign". The
campaign is complete when tracks A–B are done, track C items are either done or
explicitly classified optional, the full suite passes with all suites
registered, security review finds no new bypass, and documentation describes the
final code. A row having a commit is not sufficient — production integration and
verification are required.

## Immediate next work

**Finish B3 — canonical project identity adoption.** B3-1 (#246) fixed the
identity function and the kernel-registry choke point; the value only lands when
production writers use it. The next slices are: register projects inside the
kernel writers (`startExecution`, `appendEvent`, `createProjectWorkspace`) and
the memory/KV writers; replace the three independent project-inference
derivations (`src/memory.js`, `src/agent.js`, `src/tools/context.js`) with the
shared canonicalizer; add an invocation surface for `backfillProjectSources`;
and converge any pre-B3-1 mixed-case `platform_projects` rows. After B3, B4
(execution convergence) is the next dependency-ordered slice.
