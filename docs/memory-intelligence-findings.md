# Memory Intelligence Verified Findings

Verified against the current working tree on branch `feat/memory-intelligence-system` after PR #70 was merged.

## Current Architecture

- `src/memory.js` keeps a bounded legacy `json_documents.context` document and writes selected Agent Bridge task summaries into the structured `memories` table.
- Direct tool calls are logged in `tool_logs` and copied to bounded legacy context, but `recordToolCallMemory()` intentionally does not create new structured `tool_call` memory rows.
- `migrations/003_structured_memory.sql`, `004_memory_lifecycle.sql`, `005_sync_support.sql`, and `006_memory_deferred.sql` created the current structured memory table, lifecycle fields, sync fields, and deferred review state.
- Recent Evolve work added generated capability and generated-tool execution tables, plus dashboard execution visibility. It does not yet promote generated-tool experience into procedural memory.
- KV storage remains separate from structured memory. Handoff/resume conventions are mostly KV/resume-document based, not first-class handoff records.
- Dashboard memory APIs read `memories`; dashboard KV APIs read `kv_store`; dashboard Activity reads `tool_logs`; knowledge APIs read `knowledge`.
- Qdrant embeddings are optional. SQLite remains the durable source for structured memory and legacy context.

## Confirmed Prompt Claims

- Normal direct MCP calls primarily produce operational history in `tool_logs` and bounded legacy context, not durable structured knowledge.
- Tool-call rows generally lack complete user goal, acceptance state, final task interpretation, and decision context.
- Agent Bridge task memory has better goal/task context than ordinary direct calls and already builds compact memory briefs.
- KV, handoffs, structured memories, context documents, knowledge, embeddings, and tool logs are separate systems with partial coordination.
- Handoffs stored in KV did not have a dedicated metadata table or reliable structured-memory ingestion path.
- Operational records can dominate loaded dashboard views even when durable memory is low.
- Dashboard terminology previously mixed loaded rows, durable rows, stale rows, and operational rows in ways that could obscure what was actually stored.
- Recall used simple scoped search and confidence/type weighting but did not model full temporal validity, evidence authority, or source directness.
- Duplicate/supersession logic existed for similar content but lacked explicit evidence, scope, validity windows, and conflict grouping fields.
- User corrections and explicit forgetting existed partly through lifecycle operations but were not first-class truth-maintenance actions with replacement provenance.
- Import/export/sync preserved many structured-memory fields but did not cover entities, handoffs, evidence, relationships, sessions, or artifact lineage.
- Evolve/generated-tool execution observability was present but not yet tied to procedural memory as a reusable memory class.
- Resume behavior still depended on formal resume records plus KV conventions instead of typed current-work/session projection.
- Entity relationships, artifact lineage, and bitemporal validity were not first-class tables.
- Extraction was heuristic and did not consistently distinguish direct evidence from inference.

## Dashboard Number Explanation

The reported pattern, such as `Loaded: 500`, `Durable Active: 0`, and `Operational: 462`, is consistent with the old separation:

- `Loaded` was the number of memory-like rows fetched into the Memory tab.
- `Operational` included telemetry-like rows or observations derived from tool activity.
- `Durable Active` counted non-operational structured rows such as facts, decisions, preferences, procedures, and open threads.
- Since direct MCP calls intentionally no longer create structured `tool_call` rows, useful durable rows only appeared when Agent Bridge/task extraction or explicit context tracking created them.

## Implemented Direction

This redesign adds a compatible foundation rather than replacing the existing stores:

- Full handoffs remain preserved as source artifacts.
- Extracted memories link back to source handoffs and evidence excerpts.
- Task sessions provide begin/checkpoint/end envelopes for direct MCP clients.
- Memory rows gain explicit class, scope, source, evidence, authority, confidence components, temporal validity, current/historical state, and sensitivity fields.
- New tables model handoffs, evidence, entities, relationships, task sessions, and audit events.
- Retrieval returns a scoped brief with selected items and reasons instead of dumping all memory.
