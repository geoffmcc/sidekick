# Decision log

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
