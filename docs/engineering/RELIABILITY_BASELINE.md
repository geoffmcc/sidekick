# Reliability baseline

## Handoff lifecycle audit atomicity: 2026-10-12

Injected audit failures reproduced partial archive, unarchive, and restore
operations. Archive/unarchive changed visibility before their audit write;
restore appended a latest version before its separate restore audit. All three
operations now commit their changes and verified audit row in one immediate
transaction. The 23-case handoff reliability suite and three supported runner
suites pass. This checks logical rollback under SQLite write failures, not
power-loss durability.

## Handoff purge audit: 2026-10-12

Injected aborting and silently ignored audit writes reproduced a destructive
partial result: historical handoff content and links were deleted, then audit
persistence failed or was suppressed. Purge now checks the inserted audit row
and deletes history, links, and audit within one immediate SQLite transaction.
The 20-case handoff reliability suite passes, including rollback and successful
retry. This verifies SQLite logical atomicity under the injected failures, not
power-loss durability.

## Resume project scope: 2026-10-12

Canonical MCP integration fixtures showed a trusted project context was ignored
by resume operations: list returned foreign-project pointers, set accepted a
foreign explicit project, and list synchronized completion for a foreign
project. After the fix, all 19 handoff reliability cases and five supported
runner suites (handoff reliability/concurrency, tools, project identity, and
dispatcher) pass. This is a bounded scope check, not proof of complete
cross-interface isolation. The prior versioning/checkpoint assertion failure
remains unresolved.

## Handoff save atomicity: 2026-10-12

Failure-injection regression covers handoff create and content update when the
tamper-evident journal insert fails. After the fix, both operations leave the
primary row, version history, and journal unchanged; retry after removing the
failure commits once. `node --test test/handoff-reliability.test.js` passed all
16 cases. The six-suite supported-runner group passed five suites and failed
`handoff-versioning.test.js` at a checkpoint `repository.head` assertion; direct
execution reproduced it. No product-level conclusion about that failure has
been established. These are logical SQLite transaction tests, not a claim of
power-loss durability.

## Current measurement (2026-10-12, d4c908c)

A frozen Windows/Node 24.18.0 snapshot completed a bounded required-tier run:
163 suites passed, 18 failed, one was cancelled, and 70 were not run. The runner
reports `failed: 19` because cancellation is included. It returned in 180.232
seconds with exit 1. This supersedes the prior absence of a returned aggregate,
but does not establish a passing or complete baseline. The longer historical
Windows timeout concern is not proven resolved by this one bounded run.

The final new 17-case concurrency/interruption suite produces 15 failures and
two passing controls against unchanged d4c908c. With the fix, all 17 pass, and
all 17 selected relevant suites pass (42.622 seconds total, serial runner).
Architecture, test ownership (295 suites), and documentation checks pass.
These are fixture/test durations, not runtime performance measurements.

Verified properties: no partial row/event commit after injected event failure;
no partial checkpoint/resume commit after abrupt fixture-process exit; stale
observations cannot overwrite intervening checkpoint, lifecycle or packet
changes; expiry is checked at resume commit; terminal records stay terminal.
Process-exit tests do not establish power-loss durability, external side-effect
exactly-once semantics, or complete independent-agent task execution.

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

Measured locally on Windows, Node v24.18.0; no production reliability percentages or latency SLOs are asserted.

Initial static gates passed: architecture (462 files), test architecture (293 suites), documentation drift. Existing handoff-versioning and Agent handoff-continuity tests passed. Template regression behavior passed 19 assertions, with cleanup failure. Required-tier run is recorded separately when complete.

New regression suite test/handoff-reliability.test.js exercises real disposable Git and SQLite state. Before fixes: ten of twelve final regression cases fail; receiver recovery and invalid-evidence controls pass. Cases cover event persistence failure, evidence aging, future timestamps, project mismatch, foreign completion, tracked same-status edits, untracked same-status edits.

It now has 15 cases, including a canonical-dispatch scope regression: a bound
project must constrain list results even when the caller omits the optional
project argument, and explicit attempts to override that scope fail. The test
uses two projects and a persisted operator principal in an isolated fixture.

The suite now has 14 cases. A synchronized pair of separate Node processes
reproduces lost resume pointers in the former whole-document load/modify/upsert
path. With the atomic merge, both distinct project entries persist. The final
scoped run also passed `tools.test.js` and `project-identity.test.js`; see
`VALIDATION_RESULTS.md` for the exact command and environment.

Contracts and target measurements: zero checkpoint rows committed on injected journal failure; stale/future evidence never enables preflight; project mismatch always blocks; same-status content changes never silently pass readiness; new receiver process recovers objective/decisions/next action. These are acceptance targets, not production observations. Repeat with the committed test suite.

SQLite WAL synchronous=NORMAL remains unchanged: logical atomicity and process rollback tests do not demonstrate power-loss durability. No claim of exactly-once external effects. More work is required for OS termination at write boundaries, simultaneous processes, full task continuation, migration rollback and long-context evidence retrieval.


## Final targeted measurements

Final regression suite: 12 passed, 0 failed, 0 skipped; 16.224 seconds as a suite through the supported runner on this machine. Untouched baseline with the final test file: 10 failed, 2 passed, 7.548 seconds total. Those times include disposable Git/database setup and test assertions; they are not product latency benchmarks. Across focused and scope runs, the latest results cover 16 distinct passing suites. Full required tiers remain unverified because the broad run did not complete.

The broad runner exceeded its configured 300-second overall timeout without returning a final report; its session was interrupted. No aggregate counts are available. The validation snapshot also received edits while that run remained pending, so it cannot serve as a clean baseline. Re-run full tests from a frozen checkout in a supported environment. This is a validation limitation, not a production hang claim.
