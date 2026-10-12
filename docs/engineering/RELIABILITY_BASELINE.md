# Reliability baseline

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

Measured locally on Windows, Node v24.18.0; no production reliability percentages or latency SLOs are asserted.

Initial static gates passed: architecture (462 files), test architecture (293 suites), documentation drift. Existing handoff-versioning and Agent handoff-continuity tests passed. Template regression behavior passed 19 assertions, with cleanup failure. Required-tier run is recorded separately when complete.

New regression suite test/handoff-reliability.test.js exercises real disposable Git and SQLite state. Before fixes: ten of twelve final regression cases fail; receiver recovery and invalid-evidence controls pass. Cases cover event persistence failure, evidence aging, future timestamps, project mismatch, foreign completion, tracked same-status edits, untracked same-status edits.

Contracts and target measurements: zero checkpoint rows committed on injected journal failure; stale/future evidence never enables preflight; project mismatch always blocks; same-status content changes never silently pass readiness; new receiver process recovers objective/decisions/next action. These are acceptance targets, not production observations. Repeat with the committed test suite.

SQLite WAL synchronous=NORMAL remains unchanged: logical atomicity and process rollback tests do not demonstrate power-loss durability. No claim of exactly-once external effects. More work is required for OS termination at write boundaries, simultaneous processes, full task continuation, migration rollback and long-context evidence retrieval.


## Final targeted measurements

Final regression suite: 12 passed, 0 failed, 0 skipped; 16.224 seconds as a suite through the supported runner on this machine. Untouched baseline with the final test file: 10 failed, 2 passed, 7.548 seconds total. Those times include disposable Git/database setup and test assertions; they are not product latency benchmarks. Across focused and scope runs, the latest results cover 16 distinct passing suites. Full required tiers remain unverified because the broad run did not complete.

The broad runner exceeded its configured 300-second overall timeout without returning a final report; its session was interrupted. No aggregate counts are available. The validation snapshot also received edits while that run remained pending, so it cannot serve as a clean baseline. Re-run full tests from a frozen checkout in a supported environment. This is a validation limitation, not a production hang claim.
