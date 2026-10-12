# Validation results

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

Environment: Windows; Node v24.18.0, npm 11.16.0, better-sqlite3 13.0.3 / SQLite 3.53.4. Tracked-source export, clean test environment, installed dependencies read-only, disposable Git/SQLite. No live configuration or data.

| Command in isolated source | Actual result |
| --- | --- |
| node scripts/check-architecture.js | PASS; 462 files |
| node scripts/check-test-architecture.js | PASS; 293 suites |
| node scripts/check-docs.js | PASS |
| node test/run-all.js test/handoff-versioning.test.js | PASS after creating isolated Git fixture commit |
| node test/run-all.js test/agent-handoff-continuity.test.js | PASS |
| node test/run-all.js test/security-handlebars-template.test.js | FAIL in cleanup; 19 behavioral assertions pass |
| node --test test/handoff-reliability.test.js (baseline code) | FAIL; seven regressions reproduced, one independent-process receiver control passes |

Setup failures: initial isolated commit attempted configured SSH signing, unavailable in sandbox; only disposable fixture commit used commit.gpgsign=false. Initial native temp Git initialization denied; subsequent runs use an owned workspace temp directory. These are setup failures, not successful tests. Full required-tier result and post-fix checks still pending.


## Final validation

Latest passing results by distinct suite (16 suites); these were run in focused groups with --concurrency=1 --json. Earlier failures are retained above and in the notes below. Durations are suite elapsed milliseconds, not product benchmarks.

| Reproduction command | Result | ms |
| --- | --- | --- |
| node test/run-all.js test/agent-durable-operations.test.js | PASSED | 310 |
| node test/run-all.js test/agent-durable-recovery-matrix.test.js | PASSED | 299 |
| node test/run-all.js test/agent-handoff-continuity.test.js | PASSED | 96 |
| node test/run-all.js test/agent-handoff-tool.test.js | PASSED | 1358 |
| node test/run-all.js test/agent-recovery-scan.test.js | PASSED | 115 |
| node test/run-all.js test/brain-concurrency.test.js | PASSED | 140 |
| node test/run-all.js test/dispatcher.test.cjs | PASSED | 855 |
| node test/run-all.js test/handoff-reliability.test.js | PASSED | 16224 |
| node test/run-all.js test/handoff-versioning.test.js | PASSED | 7564 |
| node test/run-all.js test/migration-self-containment.test.js | PASSED | 576 |
| node test/run-all.js test/security-handlebars-template.test.js | PASSED | 766 |
| node test/run-all.js test/tool-registry-contract.test.cjs | PASSED | 588 |
| node test/run-all.js test/memory-intelligence.test.js | PASSED | 6237 |
| node test/run-all.js test/project-context-isolation.test.js | PASSED | 755 |
| node test/run-all.js test/project-identity.test.js | PASSED | 456 |
| node test/run-all.js test/security-phase-16-memory-data.test.js | PASSED | 106 |

The new handoff-reliability suite contains 12 node:test cases (12 pass, 0 fail/skip). Template security contains 19 passing cases. Legacy suites report many internal assertions as one Node test; do not add these counts as though all suites use identical reporting.

Final baseline reproduction against unchanged b89247b source with the final regression test file: 10 fail, 2 pass; includes staged edit, missing cached evidence and legacy dirty checkpoint cases. This supersedes the first 8-case reproduction.

Final static gates: node scripts/check-architecture.js PASS (462 source files); node scripts/check-test-architecture.js PASS (294 suites); node scripts/check-docs.js PASS. Git diff --check PASS.

Broad command attempted: node test/run-all.js --tier=unit --tier=contract --tier=integration --tier=security --concurrency=4 --overall-timeout-ms=300000 --json. INCOMPLETE/CANCELLED; no aggregate report. Its snapshot changed while pending, so it is unsuitable as a clean baseline. Full npm test, test:all, coverage, mutation, live suites and Linux CI are NOT claimed passing.

Intermediate failures: dispatcher cleanup EPERM (fixed by closing its owned DB; final rerun passes); handoff-versioning blocked on unrelated untracked fixture from aborted run (fixture isolated only in disposable checkout; final rerun passes). No assertions were weakened.

No operational .env/database was read, no external model called, no dependencies installed, no production migration run. Reproducibility caveat: installed dependency packages were reused via NODE_PATH, not a new npm ci installation. All direct versions matched the lockfile.
