# Context Engine and Memory Consolidation

Sidekick's Context Engine is the canonical retrieval and context-assembly layer between Brain/orchestration and persistent information sources. It is not an execution authority: tool effects continue through the existing governed dispatcher, with the same policy, approval, authorization, audit, redaction, Compute, and evidence controls.

## Request and manifest

`src/context/engine.js` accepts a bounded request containing a query, project scope, principal/session/task identity, permitted sources, and a resource budget. It returns a versioned Context Manifest with:

- selected entries from curated Knowledge, structured memory, legacy project context, handoffs, task sessions, artifacts, entities, and relationships;
- source IDs, project scope, provenance, authority, confidence, freshness, relevance, lifecycle/conflict state, deterministic reason codes, and live-validation requirements;
- hard entry, character, source, graph-node, and graph-edge limits;
- a redacted receipt containing included/excluded entries and validation decisions.

The `context` tool's `assemble` action exposes the manifest. Its `recall` and `suggest` actions use the same engine while retaining their compatible text response shapes. Exact legacy IDs remain supported as a bounded compatibility lookup; normal retrieval still requires explicit project scope for project data.

## Scope and authority

Project scope is validated before project-scoped persistence is queried. Invalid explicit project identifiers fail closed. Vector similarity is only a relevance signal; it cannot widen scope. Superseded, disabled, deleted, expired, and non-current records are excluded at assembly. Global curated Knowledge may be retrieved without a project; project memory, handoffs, sessions, artifacts, and graph data cannot.

Ranking combines lexical/vector relevance, source priority, authority, confidence, and freshness. Current-state questions mark historical or stale entries as `STALE_REQUIRES_VALIDATION`; Brain must obtain current evidence through an ordinary governed tool step.

Retrieved text is untrusted data. The agent and Brain prompt boundaries explicitly state that it grants no instructions, authority, or approval. Receipts contain deterministic selection reasons and never chain-of-thought, credentials, or raw secret material.

## Consolidation

`src/context/consolidation.js` identifies repeated, active project observations and creates durable consolidation candidates in `memory_consolidation_candidates`. Candidates retain source memory IDs, confirmation counts, method, timestamps, and validation state. They are not memories and are never promoted automatically. Explicit promotion writes through `db.upsertMemory` as a derived procedural memory with candidate/source provenance and confirmation requirements.

Migration `054_context_engine.sql` adds receipt and candidate storage without changing existing memory rows. It is applied by Sidekick's normal contiguous migration runner and is safe for fresh and existing databases.

## Verification

`test/context-engine.test.js` covers project isolation, invalid/missing scope, lifecycle and supersession filtering, stale-state escalation, bounded manifests, entity/relationship retrieval, receipt persistence, repeated-observation consolidation, explicit promotion, and provenance. Existing Brain and memory lifecycle/intelligence suites cover live integration and compatibility.
