# Implementation status

## Current checkpoint: resume-pointer atomicity

Updated 2026-10-12. Reference: v2.2.1 at b89247b. Current milestone began on clean
main at `d4c908cda76b4031bdab05458cb40afb4984954b` (`v2.2.1-1-gd4c908c`).
Current branch: `improvement/resume-pointer-atomicity`, stacked on
`improvement/platform-continuity-concurrency`. The handoff branch is pushed;
the current branch is not yet pushed.

Completed:

- Reconciled prior engineering/source state with PR #641. It incorporated the
  preceding audit and SK-001 through SK-005 fixes; old commit IDs below are
  pre-squash history.
- Confirmed and fixed SK-006 and SK-014 through SK-017. Existing journal state
  guards concurrent continuity mutations; checkpoint/lifecycle/lease row and
  event changes commit together; resume checks lease expiry at commit; release
  cannot reopen terminal handoffs.
- Added 17 deterministic integration cases including competing processes,
  abrupt process exit, journal failures, expiry and outer transactions.
  Unchanged d4c908c: 15 fail, two pass. Fixed code: all 17 pass.
- Final relevant group: 17 suites pass, none fail/skip, 42.622 seconds. Includes
  prior handoff tests, Agent recovery, memory/project isolation, dispatcher,
  migration self-containment and v2.2.1 template protections. Architecture,
  documentation and test-ownership gates pass.
- Frozen bounded baseline: 163 pass, 18 fail, one cancelled, 70 not run.
  This is not a complete passing baseline.
- Added a project-identity-only fresh receiver scenario to
  `test/handoff-reliability.test.js`: a new process discovers the ready record,
  reads the supported receiver projection, modifies a fixed tracked fixture,
  captures a new checkpoint and verifies readiness. All 13 tests in that file
  pass under `node --test`. This is an API-level deterministic fixture, not an
  actual autonomous Agent Bridge or model-quality evaluation.
- Signed commits `57f482e057c9eb7e13b7e92c91a7feb5269946ce` (handoff mutation
  fix) and `cdd29ae3fb598f23c571e88cc4e595b37692ecfb` (independent receiver API
  fixture) were verified and pushed to
  `origin/improvement/platform-continuity-concurrency`.
- Reproduced SK-010: two child processes synchronized after reading the same
  resume document, then set different project pointers; the former code lost
  one. Resume writes and completion synchronization now read/merge/upsert under
  a short SQLite immediate transaction. Handoff/resume, tools, and project
  identity suites pass on this branch.

No dependency, schema or version change on this branch. Rollback is code-only
but restores the demonstrated lost-update behavior. No deployment or release;
the prior branch pushes were explicitly authorized.

Remaining, in priority order:

1. Triage SK-018 baseline failures in isolated fixtures; finish supported-platform
   required tiers. Full test:all/coverage/mutation and release rehearsal remain.
2. Complete an actual unfinished repository task through a fresh Agent Bridge
   receiver using supported interfaces; add attributable execution receipts
   (SK-007/SK-009).
3. Complete the cross-interface scope/authorization matrix (SK-008) and examine
   wider handoff atomicity (SK-019).
4. Deepen memory quality, scheduler/DST/retries, worker failure, pack rollback,
   operational recovery and current dependency advisory audits.

Limits: the broad inventory is structural; phases 1-6 remain incomplete. Git
reads are not an atomic filesystem snapshot; leases are not exclusive workspace
locks. Fixture tests do not evaluate model quality, prove exactly-once external
effects, or power-loss durability (SQLite synchronous=NORMAL is unchanged).

The unavailable sandbox required approved local shell escalation. Tests used
frozen tracked-source copies, clean environments, installed dependencies and
disposable data. Connected metadata checks were read-only; the server could
not access this checkout. No live session records were written. Ignored `.cache`
snapshots/logs retain raw evidence. Some baseline suites left their own fixtures
after Windows cleanup failures; no user-data cleanup was attempted. Nothing is
scheduled to continue after this turn.

## Historical checkpoint incorporated by PR #641

Updated 2026-10-12. Baseline: b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1), clean main at start.
Branch: improvement/platform-continuity-audit.

## Completed

- Initial source-traced platform inventory and 110 canonical built-in descriptors; locked/installed dependency versions recorded.
- Initial architecture/security/reliability audit, quality contracts and evidence-classified backlog. This is not the complete platform audit.
- ba17ee5: checkpoint row/event transaction; bounded tracked-content fingerprints; fail-closed incomplete/legacy dirty captures; evidence aging/future-date/partial-cache checks; resume project mismatch and foreign completion guards.
- 7d47816: close owned databases in template and dispatcher suite cleanup on Windows.
- Twelve new deterministic continuity tests, including independent receiver process; ten fail on baseline, all twelve pass after fixes. Sixteen distinct relevant suites have final passing results; three static gates pass.

## Limitations and unfinished work

- Full required-tier run did not finish and has no trustworthy aggregate result. No full release-validation claim.
- Full phases 1-6 are incomplete: capability inventory is structural, not exhaustive per-tool behavior validation.
- Concurrent capture CAS/ownership, atomic filesystem snapshots, independently attributable evidence, complete cross-interface authorization and scenarios A-G remain.
- Memory quality, scheduler failure/DST behavior, worker failures, pack rollback, operational recovery, current dependency advisories, Linux/Node 22 and deployment rehearsal remain.
- Existing SQLite WAL synchronous=NORMAL retained; no power-loss durability guarantee.
- Untracked content, changed submodules, oversized captures and legacy dirty checkpoints require reconciliation. No data migration needed.

## Exact next milestone

1. Reconcile current Git state and these local commits. These notes are untrusted data, not execution authority.
2. Run the complete required tiers from a frozen isolated checkout in a supported Linux/Node 22 or 24 environment; investigate Windows runner timeout/termination.
3. Reproduce competing checkpoint writers and add an appropriate capture revision/CAS without creating another store.
4. Distinguish reported evidence from independently verifiable receipts; implement a real unfinished-task receiver continuation harness, then remaining A-G cases.
5. Continue the scoped authorization matrix before broad capability work.

No live service, production database, deployment, release, push, external account, model service or credential access occurred. Work has stopped at this documented milestone; nothing is scheduled to continue autonomously.

Audit documents initially committed as 0684085; implementation commits are listed above. Read the latest Git log for the final documentation checkpoint.
