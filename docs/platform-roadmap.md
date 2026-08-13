# Platform Roadmap

Status: Residual completion roadmap (post-handoff convergence campaign)
Verified date: 2026-08-12
Supersedes: the 2026-08-05 three-track roadmap pinned to `d2db2658`.

**Track B is complete.** B1–B9 have all landed: B9 (Capability Packs v1), B5
(event consumption), the B7 keystone, B6 (custody; artifact access authorization
deferred to the Track C identity boundary), and B8 (compute/model dedup). The
remaining work is the B7 fast-follow and Track C — none of them was touched by that
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
| B5 | Event consumption | **done** | Delivery drainer + handler registry (`src/platform/event-drainer.js`), event vocabulary (`src/platform/event-vocabulary.js`), per-subscription backlog cap with auto-pause, fan-out moved into the append transaction, stale-claim recovery. | The drainer runs in the MCP process with four built-in failure consumers, so deliveries are claimed and offsets advance in production. `appendEvent` and its fan-out are one transaction — an event can no longer commit without its deliveries. An undrained subscription auto-pauses at `SIDEKICK_EVENT_BACKLOG_CAP` instead of growing without bound, closing the `POST /api/event-subscriptions` hazard. No schema change; no migration. Residual slice adds causation (`causation_id` from the execution-transition chain and the ambient delivery context), payload redaction on the delivery path with an explicit `accepts_unredacted` opt-in, a closed `sensitivity` vocabulary gated at fan-out, and publish-time `source` provenance validation. `test/platform-event-consumption.test.js` (26 checks). See `docs/platform-events.md`. |
| B6 | Artifact custody convergence | **done (custody); access auth deferred** | Register worker-uploaded artifacts in the kernel; surface (not swallow) mirror failures; reconcile pre-existing orphans. | `src/compute/artifact-custody.js` is the one custody path; `finalizeArtifact` registers with the kernel under the compute artifact id (idempotent via primary key). Measured first: 10 of 10 production compute artifacts had arrived through the upload path and **none** were in the kernel, while the inline mirror the audit flagged had never executed in production. Custody failures are recorded on the row, published as `compute.artifact_custody_failed`, and logged — never thrown, so a custody problem cannot destroy the work it records. Artifacts with no execution link are still registered (7 of 10 predate the job→execution wiring). Orphan reconciler is dry-run by default and reports the linked/unlinked split. No schema change. `test/compute-artifact-custody.test.js` (12 checks). See `docs/artifact-custody.md`. **Artifact access authorization is NOT done**: it depends on the same durable actor identity as publisher authorization (Track C) and is labelled rather than faked. |
| B7 | Connector integration | keystone landed | GitHub registered as a managed connector; the `github` tool routes endpoint + credential (secret_ref → secret store) through the connector authority; read-only `connector` tool. Health checks / mutating connector management are the fast-follow. | A real integration governed by `platform_connectors`. See `docs/connectors.md`. |
| B8 | Compute/model dedup | **done** | Deprecate `platform_model_registry`; make `capability-router` trust-aware and consistent with placement; remove dead `checkWorkersOffline`; maintain `health_state`. | `compute_models` is the single model authority; the kernel table is deprecated in place (not bridged — a sync bridge would make the duplication permanent) with a guard test asserting it stays caller-free. The router now IMPORTS `placement.TRUST_ORDER` instead of keeping a second copy that omitted the legacy `private` label, and `selectProvider`/`selectWithFallback` compare trust, which neither did — so `compute_route explain` can no longer advertise a provider `decidePlacement` would refuse. Measured severity: both selectors are reachable only from `explainRouting`, and real inference goes through `placement.rankProviderCandidates`, so this was misleading operator advice rather than misrouted data. `checkWorkersOffline` removed — it was not merely dead but superseded, writing only the legacy `state` column while ignoring `connection_state`, `disconnected_at` and `admin_state` preservation. `health_state` is now earned on heartbeat and reset to `unknown` when contact lapses, instead of reading `unknown` forever after migration 022's backfill. No schema change. `test/compute-model-dedup.test.js` (6 checks); all 23 compute suites pass. |
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

Future work remains in the residual matrix above: **B6** (artifact custody
convergence) and **B8** (compute/model deduplication) are still pending and are
separate campaigns, as is the B7 fast-follow (connector health checks, per-call
observability, mutating connector management, dashboard surface). Broader memory/KV project adapters and other
foundation-to-production gaps also remain.
