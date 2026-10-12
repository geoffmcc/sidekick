# Validation results

## Continuity concurrency milestone: 2026-10-12

Baseline: d4c908cda76b4031bdab05458cb40afb4984954b, clean main.
Windows, Node v24.18.0, npm 11.16.0. Frozen tracked-source exports use a separate
fixture Git commit and clean child environment; installed dependencies resolve
through NODE_PATH. No npm ci/download or operational configuration. Source/test
digests, selected suites, durations and statuses are retained in
`CONTINUITY_VALIDATION_EVIDENCE.json`. Raw logs remain in ignored
`.cache/initiative-*.json` and `.cache/initiative-*.log`.

| Command in isolated snapshot | Actual result |
| --- | --- |
| `node test/run-all.js --tier=unit --tier=contract --tier=integration --tier=security --concurrency=4 --overall-timeout-ms=180000 --json` on unchanged baseline | Exit 1; 163 passed, 18 failed, one cancelled, 70 not run; 180.232 seconds. Runner `failed:19` includes cancellation. |
| `node --test test/handoff-concurrency.test.js` against unchanged baseline, final 17-case test | Exit 1; 15 failed, two passed; 16.112 seconds. Passing controls: checkpoint process rollback and outer transaction composition. |
| `node test/run-all.js <17 selected suites in evidence JSON> --concurrency=1 --json` after fix | Exit 0; all 17 suites passed, none skipped; 42.622 seconds. New suite: 17 tests pass; prior reliability suite: 12; template security: 19. |
| `node scripts/check-architecture.js` | PASS, 462 source files |
| `node scripts/check-test-architecture.js` | PASS, 295 suites |
| `node scripts/check-docs.js` | PASS |

Initial 11-case reproduction failed all 11; the first fixed group passed five
suites. Final expanded results above supersede them. No expectations were weakened.

Baseline failure triage (observed output, not completed root-cause analysis):

- EPERM/EBUSY cleanup: agent-health-startup, approval, compute-registry-tools,
  cross-pack-workflow-fixtures, dashboard-api, security-phase-03-auth-authorization,
  security-research-source, security/security-boundaries, and five tool-family
  suites (database-inspection, filesystem, hashing, monitoring, storage).
- Behavioral/setup: command-execution expected output missing; compute-protocol
  job did not complete; openvino-executor and openvino-startup-readiness reported
  helper spawn EFTYPE; security-research-pack reported comparison/workflow
  assertions and a cleanup failure.
- developer-pack cancelled at the bound; 70 remaining suites did not run.
  Machine-readable evidence preserves their identities.

The broad snapshot predates production edits and remained frozen. These failures
are not attributed to the patch, but prevent a passing-platform claim. Full
unbounded npm test, test:all, coverage, mutation, live/model evaluation,
Linux/Node 22 and release rehearsal are not claimed passing. Process-exit tests
are not power-failure or arbitrary external-effect tests. Historical evidence follows.

## Independent receiver API fixture: 2026-10-12

`node test/run-all.js test/handoff-reliability.test.js --concurrency=1 --json`
on Windows/Node v24.18.0 exited 0: one suite passed, with 13 tests passed,
0 failed and 0 skipped (11.067 seconds). The added case starts a
fresh Node process with only the project identifier, discovers the ready
handoff through the handoff interface, checks the receiver projection, performs
a fixed local tracked-file fixture action, captures a new checkpoint through
the interface, and verifies the checkpoint/readiness against repository state.
No model or live service is involved. This validates API continuity and fixture
reconciliation; it does not establish that an autonomous Agent Bridge agent
can complete an arbitrary unfinished task.

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
