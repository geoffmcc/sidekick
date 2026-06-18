# Structured Memory Status

Sidekick's automatic memory now stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON document. The planned first and second passes have been implemented: similarity-based supersession, confirmation/decay metadata, review UI support, import/export, cross-machine sync metadata, and deferred lifecycle states are now part of the current system.

## Remaining Logical Steps

1. Replace the heuristic extraction rules with a stronger extractor, likely LLM-assisted, that converts task transcripts into facts, decisions, preferences, open threads, and procedures.
2. Continue improving recall ranking with project, type, recency, confidence, confirmation, and semantic-match weighting.
3. Expand dashboard review controls for richer conflict resolution and batch memory management.
4. Add evaluation coverage for extraction quality and recall relevance beyond the current lifecycle/sync/deferred tests.

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

## Later Passes

- Replace the heuristic extraction rules with a stronger extractor, likely LLM-assisted, that converts task transcripts into facts, decisions, preferences, open threads, and procedures.
- Improve compact Agent Bridge "Memory Brief" prompting as recall ranking evolves.
- Add user controls for memory type enablement and retention policy tuning.
