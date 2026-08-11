# Platform Target Architecture

Status: Proposed target architecture grounded in the current tree
Verified commit: d2db2658ef0fbf862c64b09315279562caa5bb8e
Verified date: 2026-08-05T16:16:46-04:00

## Direction

CURRENT BEHAVIOR is in `architecture.md` and `platform-convergence-audit.md`. ACCEPTED DIRECTION is one secure runtime using the current dispatcher, policy, approvals, migrations, execution records, Compute Placement, memory, and dashboard APIs. This is a convergence design, not a Phase 0R implementation plan.

## Dependency Model

```text
Transports: MCP, Dashboard, Agent Bridge, worker protocols
                         |
Core Runtime -> Module Runtime -> Tool Runtime
                         |             |
Project/Workspace   Policy/Approval   Connector
Execution -> Event -> Artifact -> Workflow -> Scheduler
Agent -> Model/Compute -> Evaluation/Replay
                         |
                 Persistence/Migrations
                         |
                    Dashboard API
```

Transports and modules depend on service facades; services depend on persistence. Persistence never calls module handlers or transports. Policy and approval are at the dispatcher/execution boundary. Event publication and artifact lineage are service responsibilities, not module-local behavior.

## Boundary Disposition

| Target boundary | Existing foundation | Disposition |
|---|---|---|
| Core Runtime | `src/index.js`, `src/agent.js`, `src/platform/kernel.js` | Extend behind stable facades; do not expand kernel indiscriminately. |
| Module Runtime | `platform_extensions` records | Add loader/manifest/lifecycle; records alone are not modules. |
| Tool Runtime | descriptor registry/dispatcher/families | Authoritative; continue one-owner migration. |
| Policy/Approval | policy, approval adapters, `approvals/*` | Wrap and converge standalone/task stores later. |
| Identity/Capability | source contexts, auth, `platform_capabilities` | Extend toward users, teams, memberships and delegated grants. |
| Project Runtime | scattered project fields | Add canonical projection and migration; workspace remains related. |
| Execution Runtime | kernel plus feature mirrors | Kernel lifecycle/lineage authoritative; adapt Compute and feature stores. |
| Event Runtime | `platform_execution_events` | Add subscribers, delivery attempts, offsets, retry/dead-letter and idempotency before calling it a bus. |
| Artifact Runtime | platform and Compute artifacts | Common metadata/lineage with immutable original/derivative custody, SHA-256 digests, and specialized Compute upload/lease rules. |
| Workflow Runtime | kernel workflows, Brain, runbooks | Common definitions/claims incrementally; preserve Brain continuation transactions. |
| Scheduler Runtime | cron/delay/watch/Brain/approval/Compute schedulers | Common claim/cancel/recovery contract; feature schedulers remain adapters. |
| Connector Runtime | providers, webhooks, Compute protocols | Typed lifecycle, health, secrets references and event contract. |
| Agent Runtime | Agent Bridge and Brain | Keep both; both call dispatcher and common workflow/execution services. |
| Model/Compute | `src/compute/*`, kernel model registry | Compute remains operational authority; kernel registry becomes projection/adapter. |
| Evaluation/Replay | tests only | Add immutable evidence references and side-effect-safe replay. |
| Dashboard API | direct feature routes | Add service-backed kernel surfaces; never dashboard-only state. |
| Persistence/Migrations | migrations plus runtime ensures | Establish migration/runtime bootstrap parity. |

## Core Invariants

An execution is a correlation and lifecycle record, not an exactly-once guarantee. Events are currently a durable audit ledger, not a live bus. Artifacts are immutable originals plus explicit derivatives; redaction never overwrites originals. Project is durable identity, Workspace is environment allocation, Session is bounded interaction, Handoff is deliberate transfer, Memory is reusable knowledge, and Execution is operation lineage.

Every module action enters the centralized dispatcher or an execution service that invokes it. Domain checks add context but cannot replace authentication, policy, approval, capability, path, redaction or audit controls. Human approval authorizes; one runner executes; ambiguous high-risk work parks for authenticated reconciliation.

## Migration Rules

1. Preserve public names and `sidekick_` aliases through registry resolution.
2. Add adapters before changing source-of-truth ownership.
3. Preserve old tables until ownership migration and tests are complete.
4. Make fresh migration and runtime ensure paths produce equivalent schemas.
5. Never create module-local project, execution, event, artifact, policy, approval or model stores.
