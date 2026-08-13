# Platform Roadmap

Status: Residual completion roadmap (post-handoff convergence campaign)
Verified date: 2026-08-12
Supersedes: the 2026-08-05 three-track roadmap pinned to `d2db2658`.

**B9 is complete** (Capability Packs v1 campaign). B5, B6, B7 and B8 remain
open and are separate future campaigns — none of them was touched by that
work beyond the one change strictly required for workflow-step correctness
(`completeWorkflowStep` gained an `advance` option so a tolerated step failure
can be recorded accurately without stalling the durable cursor).

The prior 8-phase roadmap is fully committed (PRs #191–#235). Measurement of
those commits (`platform-convergence-audit.md`) showed the platform had broad
foundations but thin production integration. Since that audit, Track A completed
(PRs #236, #238), the entire legacy handler decomposition landed (B1–B2, PRs
#240–#245), and the project-identity/execution convergence slices landed (PRs
#246, #250, #252–#255). Many kernel exports still have no production caller;
those remain separately classified residual work, not part of this closeout.

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
| B3 | Canonical project identity | **done for this campaign** (#246, #255) | Register projects at execution creation, preserve scheduled project context, verify isolation, and run the confirmed source backfill. | Canonical execution registration and scheduled context are production-wired; project/isolation suites pass; dry-run and confirmed backfill both reported 40 rows across 9 source types and 18 projects. Broader memory/KV inference convergence remains separately classified residual work. |
| B4 | Execution convergence | **done for this campaign** (#250, #252–#254) | Make the ledger authoritative for the scheduled/runbook runners; wire cancellation and checkpoints. | Cancel requests and checkpoint cursors are production-wired for scheduled/runbook paths; scheduler suite passes; deployed verification passed at `51e4505`. Broader runner convergence remains separately classified residual work. |
| B5 | Event consumption | pending | Add a delivery drainer + handler registry + event vocabulary; cap subscription backlog; move enqueue into the insert transaction. | A production consumer drains deliveries; hazard removed. |
| B6 | Artifact custody convergence | pending | Register worker-uploaded artifacts in the kernel; surface (not swallow) mirror failures; add artifact access auth. | One custody authority for the worker path. |
| B7 | Connector integration | pending | One real provider through the framework; secret-ref resolver bridging to the secret store. | A real integration governed by `platform_connectors`. |
| B8 | Compute/model dedup | pending | Deprecate `platform_model_registry` writers; make `capability-router` trust-aware; remove dead `checkWorkersOffline`; wire or drop `health_state`. | Single model authority; no trust-unaware selector. |
| B9 | Module third-party path | **done** (Capability Packs v1) | Entry loader for verified `entry_point`; persist+verify `package_hash`; operator install/configure/upgrade/uninstall; health for non-builtins; converge/retire `platform_extensions`. | Managed module store (`<data>/modules/<name>/<version>/`); `src/modules/entry-loader.js` verifies whole-package hash, entry hash, containment, compatibility and configuration before `require`; `install_path`/`package_hash`/`provenance_json` persisted (migration 036); `src/modules/lifecycle.js` implements inspect/install/configure/enable/disable/upgrade/uninstall plus a derived health model; `platform_extensions` retired as a module concept (no production caller; `platform_modules` is the single authority). Proven end to end by `test/modules-third-party-lifecycle.test.js` (18 checks) against synthetic fixtures — including tamper-fails-closed and built-in-collision-refused — and in production by the Developer pack's `developer-tools` module, which installs through this path. |

## Track C — Foundation-to-production (only where the audit shows a real gap)

| # | Slice | Bounded goal | Completion evidence |
|---|---|---|---|
| C1 | Security-research wiring | Wire the generic domain records to tools/dashboard/dispatch **only against verified interfaces**; attach Scope Guard to dispatch; fix the disclosure create-path gate; validate evidence refs. External transport stays unavailable and is tested as such. Synthetic data only. | Fail-closed, human-gated, auditable; no confidential data; unavailable transport tested. |
| C2 | Durable identity (if pursued) | Durable users/teams/memberships tables (next free migration number — 036 was taken by Capability Packs v1), single-operator bootstrap, capability bridge, API/UI, isolation tests. | Real persistence + authorization + audit, or explicitly deferred as product work. |
| C3 | Evaluation/replay usefulness (optional) | Durable records + execution/artifact linkage + regression diff + operator surface, preserving side-effect safety. | Reproducible comparison, or explicitly deferred. |

## Track D — Optional future product features (not convergence blockers)

Marketplace/module distribution, external research-workbench integration (needs a
verified transport first), RBAC beyond bounded roles, RSS/activity APIs. These do
not block convergence and must not be treated as exit criteria.

**Delivered from this track: Capability Packs v1.** Not a convergence item — a
product capability built on top of the completed B9 module lifecycle, so
Sidekick Core no longer has to absorb every future area of functionality. It
adds a pack manifest, a managed pack store, a workflow **definition** registry
and runner over the existing kernel execution primitives, the `capability` and
`workflow` tools, a dashboard **Capabilities** page, and the first-party
Developer / Software Engineering pack. See `docs/capability-packs.md` and
`docs/developer-pack.md`. Remote/marketplace distribution is explicitly NOT
included.

## Exit criteria

See `platform-convergence-audit.md` § "Exit criteria for this campaign". The
campaign is complete when tracks A–B are done, track C items are either done or
explicitly classified optional, the full suite passes with all suites
registered, security review finds no new bypass, and documentation describes the
final code. A row having a commit is not sufficient — production integration and
verification are required.

## Campaign closeout record (2026-08-12)

The condensed B3/B4 campaign is closed through PR #255. The confirmed
`project_registry` backfill was preceded by a dry run and matched it exactly:
40 project-source rows across `kv` (10), `memory` (4), `execution` (13),
`compute` (2), `handoff` (5), `session` (4), and `predict` (2), with zero
workspace or blackbox rows. Verification found 40 stored source rows across
18 projects. Production was redeployed at `51e4505`; all three services were
active, restart smoke passed, and deployed-commit verification passed.

## Capability Packs v1 closeout record (2026-08-12)

B9 was completed as the foundation for Capability Packs v1, because packs
depend directly on a trustworthy third-party module lifecycle.

Delivered:

- **B9** — managed module store, safe package inspection, verified entry-point
  loading with whole-package integrity, real install/configure/enable/disable/
  upgrade/uninstall, derived health, cross-process code-change convergence.
- **Capability Packs v1** — `sidekick.pack.json` manifest, managed pack store,
  component ownership (`platform_capability_pack_components`), full lifecycle,
  derived health, bundled first-party packs.
- **Workflow definitions** — `platform_workflow_definitions` plus a runner that
  drives the EXISTING kernel workflow/execution primitives and the single tool
  dispatcher. Not a second engine.
- **Developer pack** — 3 tools, 7 runnable workflows, 8 knowledge assets,
  proven against real git repositories.

Migration `036_capability_packs.sql` (schema_version 36, platform kernel schema
version 10) is additive: three `platform_modules` columns and three new tables.
Both boot paths (migrations-only and runtime kernel) produce identical
`platform_*` schema.

## Immediate next work

Future work remains in the residual matrix above: **B5** (event consumption),
**B6** (artifact custody convergence), **B7** (connector integration) and
**B8** (compute/model deduplication) are all still pending and are separate
campaigns. Broader memory/KV project adapters and other
foundation-to-production gaps also remain.
