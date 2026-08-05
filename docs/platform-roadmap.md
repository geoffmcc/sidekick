# Platform Roadmap

Status: Proposed three-track roadmap from current main
Verified commit: d2db2658ef0fbf862c64b09315279562caa5bb8e
Verified date: 2026-08-05T16:16:46-04:00

Track A reduces tool ownership coupling. Track B converges existing platform foundations. Track C builds security research only after the generic contracts it needs are usable.

## Phases

| Phase/track | Bounded goal and foundation | Risks, tests and completion | Non-goals/review size |
|---|---|---|---|
| 1 / A | Remove duplicate storage schemas for `store`, `get`, `delete`, `list_projects`, `get_by_project`; extend registry/storage contract tests. Foundation: storage family/registry. | Preserve 107 tools, order, aliases, nested/batch dispatch and policy. Pass focused tests and `npm test`. Small PR. | No new family, module runtime or kernel split. |
| 2 / B | Reconcile migration 011 with runtime kernel schema; add fresh-vs-runtime bootstrap parity and stable service-facade design. Foundation: kernel/migrations. | Prevent fresh-install drift without dropping/renaming tables. Kernel/control/artifact tests plus parity test. Medium PR. | No event bus or public kernel split. |
| 3 / B | Canonical project projection and lifecycle; map workspace, memory, KV, Agent and Compute IDs; design encrypted workspace secret references. | Isolation/backfill audit and cross-project tests; preserve old IDs. Medium/large. | No full users/teams model. |
| 4 / B | Common workflow claim/checkpoint/cancel/recovery contract across kernel, Brain, approvals, runbooks, missions, cron, delay and watch. | Restart, idempotent claim, cancellation, approval continuation, retry classification and schedule dedupe tests; preserve Brain single runner. Large, split adapters. | No new workflow language first slice. |
| 5 / B+A | Prove module manifest/lifecycle/service context/permissions/config/health/migrations with extracted data-utilities. | Install/enable/disable, duplicate ownership, aliases, policy/approval, migration and catalog tests. Medium. | No security-research implementation. |
| 6 / B | Define artifact original/derivative custody, event delivery semantics, connector lifecycle and API integration for the working `security-research` surface; add dashboard service surfaces. | Delivery retry/offset/dead-letter, digest, connector auth/health, no private shared tables. Large, split contracts. The unavailable Workbench is not a prerequisite. | No marketplace or Workbench assumption. |
| 7 / C | Build `@sidekick/security-research`: scope snapshots, targets, campaigns, hypotheses, test runs, findings, reports, disclosure, Scope Guard, `security-research` connector and Evidence Vault lineage. | Fail-closed scope, human approval, immutable originals, truthful analysis-only status and bounded lab integration. Add an optional Workbench adapter only after its contract is verified. Large, domain slices. | No autonomous offensive system or hard-coded lab network. |
| 8 / B+C | Add evaluation/replay, users/teams/memberships and deployment profiles. | Side-effect-safe replay, capability scope and multi-user audit tests. Large. | No removal of single-operator mode. |

## Parallelism

Phase 1 can proceed independently. Phase 2 can start in parallel but should land before project/workflow convergence. Phase 3 and 4 serialize where identity and execution lineage are involved. Phase 5 depends on the registry contract from Phase 1. Phase 6 depends on execution/artifact boundaries from Phases 2-4. Phase 7 depends on Phases 2-6; Track A extraction can continue in parallel if module API ownership is kept stable.

## Exact Next-Phase Work Packet

Recommended next implementation phase: **Phase 1, Track A, storage schema ownership cleanup**. It is the smallest verified duplicate, preserves active refactor momentum, and establishes the registry invariant future modules must use.

1. Remove only the five duplicate storage schema entries from `src/tools/schemas/index.js` after comparing accepted arguments with `src/tools/families/storage.js`.
2. Add an assertion that each extracted descriptor has one schema owner and all 107 canonical tools remain in definition order.
3. Extend storage tests to all seven descriptors, aliases, batch/nested dispatch, policy/approval and Redis-unavailable behavior.
4. Run `node test/tool-registry-contract.test.cjs`, `node test/dispatcher.test.cjs`, the focused storage test, and `npm test`.
5. Update `docs/tool-architecture.md` only if measured behavior differs.

Explicit non-goals: no module runtime, security-research code, platform-kernel split, schema migration, deployment, commit or push during Phase 0R.
