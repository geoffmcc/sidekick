# Decision log

## Extracted memory claims require confirmation (2026-10-12)

- Treat handoff fact labels and session `verified_facts` as reported claims.
  Create their semantic memories with `requires_confirmation: true`; the
  existing store assigns `pending`. Labels, confidence scores, observation
  timestamps, and duplicate-extraction counters are not verification.
- Use one read-time guard for pending claims and legacy facts whose source is
  `handoff` or `task_session`. Apply it to selected memories and prose briefs,
  lexical/vector recall, the active context engine, compatibility search, and
  project assembly. Resolve vector IDs against current SQLite rows so stale
  payloads cannot supply content or confirmation state.
- Keep explicit memory review and exact-ID context lookup available with
  status/provenance. The existing confirmation action makes claims eligible
  for automatic context. No schema migration, new database, or dependency.
- This closes automatic semantic-fact promotion, not independent verification.
  Original handoff/session artifacts remain source material. Server-verifiable
  evidence receipts and the broader confirmation authority matrix remain
  SK-007/SK-008; no claim that an explicit confirmation proves a fact true.

## Atomic handoff evidence refresh (2026-10-12)

Evidence freshness is persisted state with a matching tamper-evident journal
entry. Compute repository/artifact observations before locking, then re-read the
handoff under an immediate SQLite transaction and reject a changed version or
content hash. Replace that version's evidence rows and append `evidence_refreshed`
in the same transaction. This avoids long Git operations under the writer lock
and prevents failed journal writes from leaving apparently successful freshness
state. No schema or dependency change.

## Atomic metadata-only handoff saves (2026-10-12)

Keep metadata-only saves at the existing packet version, but execute the row
touch and lazy legacy-link repair in one transaction. Compare the update against
the row version and content hash observed by the caller so an intervening
content writer cannot receive stale metadata. A failed repair rolls back the
metadata change; stale writers reload and retry. No schema or dependency
change. This is scoped to the metadata-only path; remaining store operations
still require boundary-by-boundary review (SK-019).

## Version-safe handoff memory extraction (2026-10-12)

Treat extraction as a derived transaction against a specific handoff revision.
After acquiring SQLite's immediate writer reservation, reload the handoff and
reject a caller snapshot whose version, content hash, or project changed. Insert
all extracted memories and mark that same row processed in the same transaction.
This prevents stale facts from being labeled current and leaves no partial
derived set after an insert failure. No migration or new source of truth is
needed; stale callers reload and retry. The platform event remains emitted
after the database commit by the existing caller path.

## Atomic legacy handoff-link repair (2026-10-12)

`getHandoff()` materializes missing `memory_handoff_links` from stored packets
for compatibility with older records. Keep that behavior and schema, but make
the derived inserts transactional. Removing repair from reads would alter
legacy projections; unguarded inserts could persist only a prefix after a later
insert fails. A regression injects an artifact-link failure after evidence
insertion and confirms rollback followed by successful repair. This does not
establish broader extraction or metadata-only atomicity; SK-019 remains open.

## Continuity concurrency milestone (2026-10-12)

- Preserve clean d4c908c, including all post-v2.2.1 fixes; branch locally as
  `improvement/platform-continuity-concurrency`.
- Reuse the append-only handoff journal as the mutation revision. Packet
  `expected_version` continues to mean packet version. No migration or second
  checkpoint store is needed to reject overlapping captures.
- Compare observed state and commit row/event in one short SQLite transaction.
  Return a conflict for reload/reconciliation; never silently replay a mutation.
  Keep Git reads outside the lock and explicitly retain the filesystem-race limit.
- Enforce the existing transition matrix on claim release. Terminal handoffs
  cannot be reopened using retained claim tokens; this intentional tightening is
  the only change to accepted lifecycle behavior beyond rejecting races/failures.
- Use independently frozen tracked-source copies, clean child environment,
  installed dependencies through NODE_PATH, and disposable Git/SQLite fixtures.
  Do not mutate a running validation snapshot. No dependency downloads.
- Record required-tier failures and cancellation as failures. Keep remediation of
  unrelated Windows test cleanup/behavior failures separate from continuity code.
- Connected metadata checks were read-only; no live session/handoff was written.
  Repository profiling was unavailable for this path. Local records remain the
  campaign checkpoint. The earlier no-live-tool decision below describes only
  the preceding milestone.

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

- Preserve baseline and latest security fixes; no dependency changes.
- Use a dedicated branch in the original checkout; execute tests in a tracked-source export without .env or operational data, using installed dependencies read-only through NODE_PATH.
- Do not invoke connected live Sidekick tools: the request excludes production-resource access and live mutation. Repository guidance for live session writes is subordinate to that constraint. Durable campaign state is local engineering documentation.
- Reuse existing handoff tables and public APIs. Existing v3 architecture makes a new database or event bus unnecessary.
- Report test cleanup failures as failures even if behavioral assertions pass.
- Keep unsupported areas explicit. Inventory coverage is not a complete security audit or proof of production readiness.


## Final decisions

- Hash bounded staged and unstaged Git diffs separately. Preserve exact porcelain whitespace. Do not persist raw diff text.
- Prefer explicit blocking to falsely validating untracked or changed submodule contents. Capture legacy data without silently inventing hashes; require reconciliation for legacy dirty state.
- Use one existing SQLite transaction for checkpoint row and event. Do not claim filesystem atomicity or power-loss guarantees.
- Recheck evidence time on read and require a matching stored check for every packet item. Fresh timestamps cannot upgrade invalid prior verification.
- Keep schema versions/public APIs and dependencies unchanged. No database migration or service restart required by the patch itself. Rolling back code restores the earlier, weaker readiness behavior; old consumers ignore additive fingerprint fields.
- Final code review performed locally; no delegated agents or live Sidekick session writes.
- A leftover fixture directory from the aborted broad run was ignored only in the disposable validation repository's .git/info/exclude. The actual repository ignore rules were unchanged. One intermediate handoff-versioning run failed closed due to that untracked fixture; it passed after isolating the unrelated artifact.
- Original repository commits used its existing Git configuration. Only disposable fixture commits override signing; no credential or signing-key access was requested.

## Resume-pointer atomicity milestone (2026-10-12)

- Split resume JSON document concurrency from the handoff mutation PR; use a
  stacked `improvement/resume-pointer-atomicity` branch because it is a separate
  read/modify/write path and should be reviewed independently.
- Keep `json_documents('resume')` as the source of truth. Take SQLite's immediate
  writer lock before reading the latest document, then merge one project's
  update and upsert within the same transaction. No new table, migration, or
  dependency.
- Apply the same guarded mutation to clearing a project pointer and synchronizing
  completed linked handoffs, preventing those mutations from writing stale whole-
  document snapshots. Writers serialize under the existing SQLite busy timeout.
- Reproduce with two subprocesses paused after the same initial read. Before the
  fix, one project's pointer is lost; after the fix, both entries remain.

## Handoff project-scope milestone (2026-10-12)

- Treat the trusted dispatcher-bound project as an invariant for every handoff
  action. If an optional `project` argument is absent, inherit the bound value;
  reject an explicit value that differs after canonicalization.
- Fix the list path at the handler boundary so list, ID-scoped reads, and
  mutations use one resolved project scope. Preserve the canonical MCP tool and
  schema; no compatibility alias or parallel policy path was added.
- Reproduce through `callMcpTool` with a valid operator principal that owns
  synthetic handoffs in two projects. The prior code listed both when bound to
  one project and given no project argument. No production data or identities
  were accessed.
- Keep this scope fix on its own stacked branch because it is a separate
  security boundary from handoff mutation atomicity and resume-document writes.

## Handoff save atomicity milestone (2026-10-12)

- Keep content save/create atomicity on a separate stacked branch; it is a
  distinct durability issue from project isolation and resume pointer merging.
- Reuse the existing SQLite transaction and handoff event journal. Commit row,
  version snapshot, audit row, journal event, and derived version links together;
  preserve caller-owned outer transactions. No schema, public API, or dependency
  change.
- Inject journal insert failures for both create and update. Verify durable row,
  history, and event state is unchanged, then remove the trigger and verify a
  retry commits once. This checks logical SQLite transaction behavior, not
  power-loss durability or filesystem atomicity.

## Resume project-scope milestone (2026-10-12)

- Treat the dispatcher-bound project as authoritative in resume operations.
  Inherit it when omitted and reject an explicit mismatch; retain existing
  unbound behavior for callers without a trusted project context.
- Filter scoped list output by both the resume document key and stored project
  identity so malformed cross-project links are not surfaced.
- A scoped read may synchronize completion only for the bound project's resume
  pointer. This avoids a nominal read mutating another project's state.
- Reproduce disclosure, foreign set, and foreign completion synchronization
  through canonical MCP dispatch with a synthetic operator principal. No schema,
  API, or dependency change.

## Handoff purge audit milestone (2026-10-12)

- Historical version purge is destructive and must not commit unless its audit
  record commits. Keep the version-row lookup, link/version deletion, and audit
  insertion in one immediate transaction; recheck the current version inside
  the transaction to avoid stale preflight.
- Refuse purge if the audit table is unavailable. No new schema, API, or
  dependency; normal successful purge output and audit shape remain unchanged.
- A temporary SQLite trigger reproduced audit-write failure. Verify the version
  and links remain, then drop the trigger and verify a single audited retry.

## Handoff lifecycle audit atomicity (2026-10-12)

- Keep archive, unarchive, and restore state changes in the same SQLite
  transaction as their required audit record. Restore may nest the existing
  saveHandoff transaction; the outer transaction owns commit/rollback.
- Verify the audit row after insert so both thrown and silently suppressed
  writes cannot appear successful. No schema, API, or dependency change.
- Trigger-injected audit failures must preserve archived state or current/history
  versions; removing the trigger must allow one audited retry.

## Task-session audit atomicity (2026-10-12)

- `saveTaskSession` performs one UPSERT followed by a required audit write. A
  trigger-injected audit failure confirmed that callers received an error while
  a newly created task session remained persisted.
- Keep the UPSERT and audit insert in one immediate SQLite transaction. Reuse
  the existing session and audit stores; no schema, API, or dependency change.
- The regression must demonstrate rollback of the session row and a successful
  retry with exactly one audit entry.

## Session and linked handoff transaction (2026-10-12)

- Failure injection against the canonical session update showed the session row
  advanced even though the linked handoff update and its journal event failed.
- Commit those two SQLite records as one immediate transaction. Keep Git
  checkpoint and evidence observations after commit; their filesystem reads
  must not hold the SQLite writer lock. A failed observation remains visible
  and must be reconciled through the existing checkpoint readiness path.
- No schema, API, or dependency change. The regression checks that both records
  retain their prior version when the handoff write fails.

## Partial session resume continuity (2026-10-12)

- A completed partial session was reopened as active while its linked handoff
  remained terminal, so project discovery could not find resumable state.
- Keep completed handoffs immutable. Create an append-only child handoff with
  `previous_id` and provenance to the completed record, checkpoint the current
  workspace, refresh evidence, transition the new record to active, then reopen
  the task session. Derive the child ID from the completed session snapshot so
  interrupted retries find and finish the same draft. Subsequent completion
  and resume cycles create a new child instead of rewriting history.
- No schema, API, or dependency change. A failed checkpoint leaves the session
  completed and the child visibly draft; retry is safe and does not duplicate
  the child record.
