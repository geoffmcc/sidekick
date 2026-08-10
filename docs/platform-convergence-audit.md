# Platform Convergence Audit

Status: Current-state audit
Verified commit: d2db2658ef0fbf862c64b09315279562caa5bb8e
Verified date: 2026-08-05T16:16:46-04:00

## Scope

`git ls-remote origin refs/heads/main` and the fetched `origin/main` independently returned the verified commit above. The audit branch was created from that exact commit. The worktree was clean before investigation. No production source or migration files are changed by Phase 0R.

The active Sidekick handoff was treated as historical evidence. Current repository code and the verified remote ref are authoritative.

## Findings

Sidekick already has a central dispatcher, source-aware policy and approvals, additive execution/event/artifact records, durable workflow primitives, project workspaces, capability grants, Brain, Compute Placement, memory intelligence, and a dashboard. It does not yet have a real installable module runtime, canonical project identity, unified scheduler/runner, unified artifact/execution ownership, live event delivery, multi-user RBAC, or dashboard control-plane coverage for most kernel objects.

Do not introduce a second registry, dispatcher, policy engine, approval store, project store, workflow engine, model registry, or execution ledger.

## Refactor Archaeology

| Period | Established | Invalidated assumption |
|---|---|---|
| 2026-07-15 | Kernel, execution control, adapters, capabilities, workflows, workspaces, model registry, extensions | The platform is not missing; the kernel is real but additive and broad. |
| 2026-07-16 | Registry, dispatcher, identity hardening | `src/tools.js` is not the production monolith; dispatcher identity is authoritative. |
| 2026-07-17 to 18 | Compute worker lifecycle, placement, Brain, follow-ups | Compute and orchestration are implemented, but use separate lifecycle stores. |
| 2026-07-19 | Approval continuation and reconciliation | Task approvals are durable; standalone JSON approvals remain compatibility-owned. |
| 2026-08-05 | 40 tools in 14 families and legacy memory cleanup | Storage/memory/filesystem extraction is no longer future work. |

Material commits: `1b93eece` (kernel), `7cb084f7`/`a7aa6fa9` (execution adapters), `6ded46e` (scheduler adapters), `1f3f24a9` (execution control), `be970ab1` (capabilities), `6fcc134d` (workflows), `273f7644` (workspaces/models), `de6f5ebf` (extensions), `71970b8a`/`0620d4b7`/`31e229e4` (registry/dispatcher/identity), `922c1d0e` (Brain), `4fde6ed3` (placement), `58e92be5`/`34e7cc95` (continuation/reconciliation), and extraction commits `70e384b` through `e73f24e`.

## Reality Matrix

| Capability | Classification | Evidence and callers | Persistence/tests | Works, gap, convergence |
|---|---|---|---|---|
| Tools/descriptors | IMPLEMENTED BUT PARTIAL | `src/tools/{descriptor,registry,dispatcher}.js`; MCP, Agent, dashboard, Brain | 107 `TOOL_DEFS`; registry/dispatcher tests | 40 descriptors/14 families, 67 legacy handlers; five duplicate storage schemas remain. Continue one-owner migration. |
| Modules/extensions | FOUNDATION ONLY | `platform/kernel.js` extension CRUD | `platform_extensions`; kernel tests | Records are not a loader/contract. Build module runtime over registry/dispatcher/services. |
| Dispatcher | AUTHORITATIVE AND IN USE | `dispatcher.js` and source wrappers | `tool_logs`, platform mirrors; dispatcher tests | Validation, policy, approval, timeout, redaction and audit are centralized. Legacy is an adapter. |
| Policy/approvals | IMPLEMENTED BUT PARTIAL | `tools/policy.js`, `approvals/*`, legacy adapters | JSON approval doc plus tables; approval tests | Task continuation is durable; standalone approvals remain a parallel path. |
| Identity/capabilities | IMPLEMENTED BUT PARTIAL | dispatcher contexts, `platformGuard` | `platform_capabilities`, change sets; capability tests | Actor/source/project/expiry grants work; no users, teams, memberships or full RBAC. |
| Projects | MISSING canonical entity | String `project`/`project_id` across services | KV, memory, jobs, executions | Scope fields work but there is no project lifecycle/ownership table. Add a projection, not a competing store. |
| Workspaces | IMPLEMENTED WITH ENCRYPTED SECRETS | kernel workspace CRUD + secret store | `platform_project_workspaces`; `platform_workspace_secrets`; workspace/project-identity tests | Active workspace/config/limits work; `secrets_json` retained for legacy rows; new encrypted secrets stored per-secret as ciphertext envelopes (see `docs/workspace-secret-references.md`). |
| Sessions/handoffs | IMPLEMENTED BUT PARTIAL | memory families, Agent lineage, MCP sessions | `memory_task_sessions`, `memory_handoffs`, resume/context, transcripts | Durable pieces work but identities are distributed. Keep session, handoff and memory distinct. |
| Memory | AUTHORITATIVE AND IN USE | `src/memory.js`, memory families, dashboard | `memories`, `memory_*`, context; memory tests | Structured redacted memory is primary; context/KV/resume remain compatibility stores. |
| Executions | IMPLEMENTED BUT PARTIAL | kernel plus Agent, Black Box, generated, scheduler, approval adapters | `platform_executions`, transitions; kernel/control tests | Parent/root/correlation and transitions work; Compute jobs remain parallel. |
| Events | FOUNDATION ONLY | kernel `appendEvent` | `platform_execution_events` | Durable ledger with dedupe/correlation/causation; no publisher, subscribers, delivery, offsets or retry semantics. |
| Artifacts | IMPLEMENTED BUT PARTIAL | kernel artifacts and Compute manager | `platform_artifacts`, `compute_artifacts` | Hash/size/lineage fields work; two active artifact models remain. |
| Workflows | IMPLEMENTED BUT PARTIAL | kernel workflow methods, Brain runner | `platform_workflows`/steps; workflow tests | Ordered steps/checkpoints/pause/retry state work; no common runner/branching/compensation contract. Phase 4/B first slice adds the kernel execution claim/lease/checkpoint/cancel/recovery contract (`platform_execution_claims`, migration 028; see `docs/execution-claim-contract.md`) with delay as the first adapter. |
| Runbooks/missions/batch | COMPATIBILITY LAYER | legacy tools and mission router | feature stores; ops/runbook tests | Useful wrappers, not one workflow engine. Adapt later. |
| Queues/retries | COMPATIBILITY LAYER | queue/retry, approvals, Compute claimers | separate stores | Multiple guarantees; do not call one unified queue. |
| Cron/delay/watch | IMPLEMENTED BUT PARTIAL | legacy tools and Agent startup | JSON docs/feature stores; scheduler tests | Durable definitions and mirrors exist; schedulers are feature-specific. |
| Agent Bridge | AUTHORITATIVE AND IN USE | `src/agent.js`, `agent-loop.js` | transcripts/platform mirrors; Agent tests | Task API, lineage, evidence, follow-up and approval flows work. |
| Brain | IMPLEMENTED BUT PARTIAL | `src/brain/*`, Agent integration | checkpoints/approvals/transcripts; Brain tests | Bounded plan validation and continuation work, off by default; resumed memory context is incomplete. |
| Models/Compute | AUTHORITATIVE AND IN USE | `src/compute/*`, placement, worker protocol | Compute migrations; placement/lifecycle/E2E tests | Provider/model registry, placement, workers, leases and artifacts work; kernel model registry duplicates it. |
| Connectors | MISSING generic contract | provider/webhook/Compute protocols | feature stores | No generic lifecycle, health, secrets or event contract. |
| Dashboard | IMPLEMENTED BUT PARTIAL | `src/dashboard.js`, static UI | direct feature APIs; dashboard tests | Tools, approvals, memory, Compute and Mission Control work; most kernel objects lack API surfaces. |
| Evaluation/replay | MISSING | deterministic tests only | test fixtures | Need immutable inputs/evidence and side-effect-safe replay. |
| Authentication | AUTHORITATIVE AND IN USE | MCP bearer, dashboard Basic Auth, worker credentials | security tests/config | Service auth works; principal identity is not multi-user identity. |
| Users/teams | MISSING | no domain found | none | Capability rows are not RBAC. |
| Migrations | IMPLEMENTED BUT PARTIAL | migration runner plus runtime ensures | migrations 001-025; focused tests | Kernel runtime creates more tables than migration 011; bootstrap parity is untested. |

## Current Dependency Diagram

```text
MCP -> src/index.js ----------------------------+
Dashboard -> src/dashboard.js -> Agent Bridge  |-> src/tools/index.js
Agent -> src/agent.js -> Brain (optional) -----+       |
Compute HTTP/worker -------------------------------   registry
Generated/Evolve -> dynamic-tools ------------------   |-- 40 family descriptors
                                                      |-- 67 legacy handlers
                                                      v
                                             src/tools/dispatcher.js
                                             | context/validation/policy/approval
                                             | timeout/redaction/audit
                                             v
                         platform/kernel.js -> SQLite platform tables
                         compatibility paths -> JSON/files/feature tables
                         Compute -> compute_* tables/artifacts
```

Authoritative: dispatcher, family descriptors, Compute placement/job contracts, Brain continuation transactions, and kernel guard/transition primitives. Compatibility: `tools-legacy.js`, `TOOL_DEFS`, JSON approvals, context/resume, feature stores and platform mirrors. Undesirable coupling: dispatcher top-level legacy import, Brain legacy catalog imports, runtime schema creation, and dashboard routes bypassing kernel services. Security-sensitive: every dispatcher entry, approval continuation, path policy, worker authentication, secret handling and dashboard mutation.

## Document Status

| Document | Status | Note |
|---|---|---|
| `architecture.md` | CURRENT | Current service overview; verified header added. |
| `data-model.md` | PARTIALLY CURRENT | Core storage is accurate; kernel/Compute coverage is incomplete. |
| `platform-architecture-assessment.md` | HISTORICAL SNAPSHOT | Pre-consolidation baseline, now labeled. |
| `tool-architecture.md` | CURRENT | Family inventory and next slice corrected. |
| `structured-memory-plan.md` | PARTIALLY CURRENT | Implemented scope current; remaining work is proposal. |
| `adr-approval-continuation.md`, `adr-brain.md`, `adr-compute-placement.md` | CURRENT / ACCEPTED ADR | Implemented contracts with stated limitations. |
| `agent-bridge.md`, `brain.md`, `compute.md`, `dashboard.md`, `security.md` | CURRENT | Current runtime behavior and limitations. |
| `project-review.md`, `technical-paper.md` | PARTIALLY CURRENT | Older recommendations/overview; not current source of truth. |
| `memory-intelligence-findings.md` | HISTORICAL SNAPSHOT | Pre-redesign rationale, now labeled. |
| `tool-creation.md` | SUPERSEDED | Pre-registry instructions, now labeled. |

## Unresolved Decisions

1. Keep `platform/kernel.js` as a stable facade while splitting implementation internally, or expose service files publicly later.
2. Make platform executions the common Compute adapter without copying Compute job state.
3. Make `memory_handoffs` canonical with `resume` as index, or define a durable peer relationship.
4. Define event delivery guarantees before naming the ledger an event bus.
5. ~~Move workspace secrets to encrypted references without breaking existing deployments.~~ **RESOLVED** — implemented in migration `027` as an additive `platform_workspace_secrets` child table storing per-secret ciphertext envelopes (AES-256-GCM via `src/core/secret-cipher.js`); legacy `secrets_json` retained. See `docs/workspace-secret-references.md`. Legacy plaintext backfill is implemented as the kernel export `backfillWorkspaceSecrets` (idempotent, never overwrites an existing envelope, retains plaintext rather than risk data loss, fails closed without `SIDEKICK_SECRET_KEY`). The legacy writers are closed: `createProjectWorkspace` routes `secrets` through the encrypted store, `updateProjectWorkspace` rejects the field, and workspace getters no longer expose `secrets`/`secrets_json`.
6. Define the minimum user/team/membership model for meaningful capability grants.
7. Use the extracted data-utilities family as the first module proof, not security research or extension CRUD alone. The security-research roadmap must target the currently working `security-research` surface; the unavailable Workbench is optional future integration, not a prerequisite.
