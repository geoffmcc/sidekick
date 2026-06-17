# Structured Memory Plan

Sidekick's automatic memory now stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON document. That is useful continuity, but it is still only the first layer of a fuller memory system. The next step is typed extraction, confidence management, and stronger recall.

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

## First Pass Scope

This branch implements the first structural pass:

- Add a `memories` SQLite table through migration `003_structured_memory.sql`.
- Add DB helpers for upsert, search, listing, and disabling memory rows.
- Write automatic tool-call and Agent Bridge task memories into the table.
- Add a heuristic extraction pass that can emit `fact`, `decision`, `preference`, `open_thread`, and `observation` rows from task text.
- Retain the existing `context.memories` and `context.sessions` writes for backward compatibility.
- Update automatic recall to search the structured table first, then merge legacy context entries.
- Add focused tests for table-backed memory storage, deduplication, and recall.
- Document the new table and env controls.

## Later Passes

- Replace the heuristic extraction rules with a stronger extractor, likely LLM-assisted, that converts task transcripts into facts, decisions, preferences, open threads, and procedures.
- Add conflict detection instead of silent overwrite when a newer memory contradicts an existing one.
- Add dashboard review UI for accepted, disabled, and pending memories.
- Add embeddings or FTS-backed ranking with project, type, confidence, recency, and confirmation weighting.
- Add user controls for memory type enablement, retention, export, and deletion.
- Add a compact Agent Bridge "Memory Brief" that separates facts, preferences, decisions, and open threads instead of injecting generic recalled items.
