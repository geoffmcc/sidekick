# Platform Roadmap

Status: Residual completion roadmap (post-handoff convergence campaign)
Verified commit: a88ea84577283899b2f02892e1dcbe9be0dcf509
Verified date: 2026-08-11
Supersedes: the 2026-08-05 three-track roadmap pinned to `d2db2658`.

The prior 8-phase roadmap is fully committed (PRs #191–#235). Measurement of
those commits (`platform-convergence-audit.md`) shows the platform now has broad
foundations but thin production integration: ~90 kernel exports have no
production caller, 9 test suites are excluded from CI, and two verified startup
bugs sit in the migration layer. This roadmap finishes the transition rather
than adding another foundation layer.

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

| # | Slice | Bounded goal | Completion evidence |
|---|---|---|---|
| B1 | Dead legacy removal | Remove ~825 lines of unreachable code from `tools-legacy.js` (legacy context block, `evolve` tail, orphans). | File shrinks; suite green; no export lost. |
| B2 | Legacy handler extraction | Extract 67 legacy handlers in the documented dependency order (zero-helper handlers → media/git → self-contained clusters → scheduled-execution helper module → nested-dispatch tools). Each a reviewable slice. | Descriptor-owned families; no family imports `tools-legacy.js` at init; end state = zero production handlers in `tools-legacy.js`. |
| B3 | Canonical project identity | Register projects inside kernel writers; add adapters from the inferred string; invocation surface for backfills. | Real callers; consumer linkage; isolation tests. |
| B4 | Execution convergence | Make the ledger authoritative for one runner; wire `requestExecutionCancel`; wire or delete `checkpoint_json`; converge 3 claim implementations behind one contract. | Production caller uses the contract; cancel loop closed. |
| B5 | Event consumption | Add a delivery drainer + handler registry + event vocabulary; cap subscription backlog; move enqueue into the insert transaction. | A production consumer drains deliveries; hazard removed. |
| B6 | Artifact custody convergence | Register worker-uploaded artifacts in the kernel; surface (not swallow) mirror failures; add artifact access auth. | One custody authority for the worker path. |
| B7 | Connector integration | One real provider through the framework; secret-ref resolver bridging to the secret store. | A real integration governed by `platform_connectors`. |
| B8 | Compute/model dedup | Deprecate `platform_model_registry` writers; make `capability-router` trust-aware; remove dead `checkWorkersOffline`; wire or drop `health_state`. | Single model authority; no trust-unaware selector. |
| B9 | Module third-party path | Entry loader for verified `entry_point`; persist+verify `package_hash`; operator install/configure/upgrade/uninstall; health for non-builtins; converge/retire `platform_extensions`. | A synthetic third-party module completes the full lifecycle. |

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

**A1 — register the 9 orphaned test suites.** They pass individually; wiring them
in makes every foundation the prior campaign built actually CI-verified, and is
the precondition for safely extending or converging any of them. Then A2/A3 fix
the two verified startup bugs before any persistence-touching slice builds on the
schema.
