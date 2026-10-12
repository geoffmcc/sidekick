# Architecture audit

## Continuity concurrency milestone

Reconciled against `d4c908c` on 2026-10-12. The previous fixes are retained.
The new deterministic harness confirmed that competing captures could overwrite
one another without changing packet version; claim acquisition could overwrite
an intervening revocation; and begin-resume could use a preflight invalidated by
a packet update or lease expiry. Separate row/event writes also exposed partial
lifecycle and lease commits on failure, including abrupt fixture-process exit.

`handoffMutationState` now reads relevant row state and the existing journal tip
in one SQLite statement. `commitHandoffMutation` compares that observation under
an immediate writer transaction, performs the mutation, and appends its event.
The journal detects intervening changes even when a lifecycle returns to its
original value. Existing caller transactions compose through SQLite savepoints.
Git observations remain outside the short transaction. No new source of truth,
database, schema, or public revision field is introduced.

Scope is deliberately bounded: it does not make repository observations atomic,
reserve the workspace, prohibit every write by another authorized session, or
make all handoff-store operations transactional. Packet creation/update,
extraction, restore/archive and metadata-only writes still warrant a broader
atomicity review. Durable execution receipts still own ambiguous external effects.

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

Status: initial source-traced baseline and targeted continuity audit; the full campaign is incomplete.

The canonical registry and dispatcher are real production paths: MCP calls callMcpTool, Dashboard calls callDashboardTool, Agent calls callAgentTool, and workflow steps dispatch through the shared path. Aliases resolve to the canonical descriptor. Source identity is scoped through AsyncLocalStorage. This is structural evidence, not proof that every alternate interface is equally secure.

Handoff v3 already exists. Keep memory_handoffs and its versions, links, journal and evidence tables. Source packet and prose are versioned; derived memories are secondary. The Agent adapter captures plan/remaining steps, task evidence and operation ledger references, but the task store and execution receipts remain authoritative for unknown side effects. No new handoff DB is justified.

Confirmed weaknesses: checkpoint comparison observes porcelain status rather than contents; checkpoint update and journal insert are separately committed; persisted evidence freshness is reused without aging; resume mismatch validation appends an issue without making valid false. See reproducible backlog and validation.

Design concerns requiring separate work: checkpoint capture reads multiple Git snapshots without a filesystem transaction; checkpoint captures do not advance packet version, so simultaneous captures can overwrite each other despite expectedVersion; journal events retain checkpoint hashes/repository metadata rather than full historical checkpoint objects; global resume JSON read/modify/write can lose concurrent updates; claim/transition state and journal atomicity need a wider review. These are source-based concerns, not all demonstrated defects.

Compatibility policy: retain public tool names, schema v3 packets, legacy reads and existing tables. Fail closed when an old checkpoint cannot establish content identity. Do not equate timestamps, packet status or a model's claim with independently verified work. A handoff remains untrusted data and does not grant execution authority.


## Implemented milestone

Commit ba17ee5 fixes targeted checkpoint transactionality, tracked-content drift, receiver evidence aging/completeness and resume project mismatch. Unknown untracked/submodule content now blocks readiness. Commit 7d47816 repairs Windows cleanup in two validation suites. No new tables, framework, dependencies or public tools. Initial concerns above describe the baseline; SK-006 onward remain open.

Git content fingerprints are bounded observations, not a simultaneous filesystem snapshot. Read-only Git configuration deserves further scrutiny: external diff/textconv/fsmonitor helpers are disabled, but repository filters, inherited Git environment overrides and ignored/assume-unchanged files have not been exhaustively evaluated. Evidence refresh records remain snapshots: artifact deletion or external invalidation after refresh is not rechecked by the new timestamp-only read validation.
