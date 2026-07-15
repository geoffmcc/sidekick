# Structured Memory And Memory Intelligence Status

Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON document. The memory-intelligence pass adds explicit task sessions, first-class handoffs, evidence rows, scope metadata, temporal validity, source authority, and current-versus-historical fields while preserving KV, context, knowledge, and tool-log separation.

See `docs/memory-intelligence-findings.md` for the verified findings that drove this redesign.

## Remaining Logical Steps

1. Add stronger model-assisted extraction behind deterministic redaction and validation gates.
2. Expand entity and relationship extraction beyond explicit memory operations.
3. Add richer dashboard workflows for merge, supersede, conflict review, source-wide forget, and retrieval inspection.
4. Add evaluation coverage for extraction quality, recall relevance, stale-memory suppression, and cross-project leakage.

## Goals

- Store memories in a queryable SQLite table instead of only inside `json_documents.context`.
- Separate memory types so facts, preferences, procedures, decisions, open threads, observations, sessions, and tool calls can be ranked and managed differently.
- Preserve source information for auditability.
- Avoid duplicate memory spam by updating matching rows when the same memory is observed again.
- Keep the existing `sidekick_context` and Agent Bridge behavior working during the transition.
- Keep automatic memory bounded, redacted, and configurable.

## Memory Types

- `fact`: stable project, system, or user facts.
- `decision`: chosen approaches and rationale.
- `preference`: user style and workflow preferences.
- `procedure`: recurring workflows worth reusing.
- `open_thread`: unresolved issues, follow-ups, or TODOs.
- `observation`: lower-confidence recent notes.
- `session`: completed Agent Bridge task summaries.
- `tool_call`: useful tool call summaries.

## Memory Classes

- `semantic`: durable facts, preferences, constraints, and decisions.
- `episodic`: bounded sessions, incidents, deployments, experiments, and releases.
- `procedural`: reusable procedures, runbooks, validation paths, and recovery steps.
- `working`: short-lived task state with TTL/promotion rules.
- `prospective`: next steps, commitments, open threads, and revalidation items.
- `negative`: scoped failed approaches and rejected options.
- `relational`: relationships among entities.
- `artifact`: metadata and lineage for source artifacts such as handoffs and reports.
- `observational`: interpreted state observations with validity windows.
- `capability`: Sidekick/generated-tool capability and lifecycle knowledge.

## Implemented Scope

The current tree implements:

- Add a `memories` SQLite table through migration `003_structured_memory.sql`.
- Add DB helpers for upsert, search, listing, and disabling memory rows.
- Write automatic tool-call and Agent Bridge task memories into the table.
- Add a heuristic extraction pass that can emit `fact`, `decision`, `preference`, `open_thread`, and `observation` rows from task text.
- Retain the existing `context.memories` and `context.sessions` writes for backward compatibility.
- Update automatic recall to search the structured table first, then merge legacy context entries.
- Add memory lifecycle fields through `004_memory_lifecycle.sql`.
- Add origin and sync metadata through `005_sync_support.sql`.
- Add deferred state, confirmation, soft-delete, and expiration fields through `006_memory_deferred.sql`.
- Add `sidekick_memory_export`, `sidekick_memory_import`, `sidekick_memory_manage`, `sidekick_sync_identity`, `sidekick_sync_export`, `sidekick_sync_import`, and `sidekick_sync_diff`.
- Add focused tests for automatic memory, lifecycle, sync, deferred state, table-backed memory storage, deduplication, and recall.
- Document the new table and env controls.
- Add migration `009_memory_intelligence.sql` for memory classes, scopes, evidence, handoffs, task sessions, entities, relationships, and audit events.
- Add `sidekick_session` for explicit direct-MCP task envelopes.
- Add `sidekick_handoff` for first-class handoff preservation and idempotent extraction.
- Add `sidekick_memory` for typed remember/query/explain/correct/forget/pin/health/backfill operations.
- Extend dashboard memory APIs and cards with class, scope, evidence, authority, validity, current/historical, and revalidation metadata.

## Later Passes

- Promote generated-tool executions into procedural/capability memory after validation and user feedback.
- Rebuild current project/entity projections from typed memory and artifact history.
- Add source-wide purge propagation to embeddings and exported bundles.
