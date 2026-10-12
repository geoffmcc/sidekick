# Validation results

## Atomic metadata-only handoff saves: 2026-10-12

Windows checkout accessed through WSL, Node v24.18.0, installed dependencies;
temporary SQLite trigger and disposable handoff database.

| Command | Actual result |
| --- | --- |
| `node --test test/handoff-reliability.test.js` | Exit 0; 28 passed, 0 failed/skipped; 7.294 seconds. Includes rollback when legacy link repair fails and a controlled intervening version advance. |
| `node test/run-all.js test/handoff-reliability.test.js test/handoff-versioning.test.js test/memory-intelligence.test.js test/tools.test.js --concurrency=1 --json` | Exit 0; four suites passed, 0 failed/skipped/cancelled; 76.903 seconds. |
| `node --check src/db/handoff-store.js` and `node --check test/handoff-reliability.test.js` | PASS. |
| `git diff --check` | PASS. |

The new repair-failure regression failed before the fix because the title had
changed after the API returned an error. The grouped handoff/versioning,
memory-intelligence and tools suites are pending for this branch. Full tiers
and release validation were not run.

## Version-safe handoff memory extraction: 2026-10-12

Windows checkout accessed through WSL, Node v24.18.0, installed dependencies;
temporary SQLite triggers and disposable handoff fixtures.

| Command | Actual result |
| --- | --- |
| `node --test test/handoff-reliability.test.js` | Exit 0; 26 passed, 0 failed/skipped; 7.555 seconds. Includes stale-snapshot rejection, project-scope mismatch rejection, mid-extraction rollback, and successful retries. |
| `node test/run-all.js test/handoff-reliability.test.js test/handoff-versioning.test.js test/memory-intelligence.test.js test/tools.test.js --concurrency=1 --json` | Exit 0; four suites passed, 0 failed/skipped/cancelled; 72.124 seconds. |
| `node test/handoff-versioning.test.js` | Exit 0; all handoff-versioning checks passed, including checkpoint/claim/resume. |
| `node --check src/tools/families/memory-handoff.js` and `node --check test/handoff-reliability.test.js` | PASS. |
| `git diff --check` | PASS. |

The stale-snapshot regression failed before the fix because extraction did not
reject the old version. An earlier grouped attempt failed in `begin_resume`
while files in this same checkout were changing; that run is not treated as
clean validation. A fresh grouped run with unchanged source passed. Full tiers
and release validation were not run.

## Atomic legacy handoff-link repair: 2026-10-12

Windows checkout accessed through WSL, Node v24.18.0, installed dependencies;
temporary SQLite trigger and disposable database fixture.

| Command | Actual result |
| --- | --- |
| `node --test test/handoff-reliability.test.js` | Exit 0; 24 passed, 0 failed/skipped; 7.281 seconds. Includes injected derived-link failure, rollback, and successful retry. |
| `node test/run-all.js test/handoff-reliability.test.js test/handoff-versioning.test.js test/memory-intelligence.test.js test/tools.test.js --concurrency=1 --json` | Exit 0; four suites passed, 0 failed/skipped/cancelled; 75.693 seconds. |
| `node --check src/db/handoff-store.js` and `node --check test/handoff-reliability.test.js` | PASS. |
| `git diff --check` | PASS. |

The first post-fix run exposed that the first projection is built before its
legacy links are materialized, so the retry assertion now performs a second
lookup. The earlier command exited nonzero; it is retained as a failed
intermediate run, not counted as final validation. No full test tiers or release
checks were run for this scoped change.

## Handoff lifecycle audit atomicity: 2026-10-12

Windows checkout accessed through WSL, Node v24.18.0, installed dependencies;
temporary SQLite triggers and disposable handoff fixtures.

| Command | Actual result |
| --- | --- |
| `node --test test/handoff-reliability.test.js` | Exit 0; 23 passed, 0 failed/skipped; 7.201 seconds. Archive, unarchive, and restore audit-failure regressions all pass. |
| `node test/run-all.js test/handoff-reliability.test.js test/memory-maintenance.test.js test/tools.test.js --concurrency=1 --json` | Exit 0; three suites passed, 0 failed/skipped; 16.598 seconds. |
| `node --check src/db/handoff-store.js` | PASS. |

Before the implementation, the three new cases failed after audit triggers
threw: archive/unarchive state changed and restore appended a version. No full
test tiers or release validation were run for this scoped change.

## Handoff purge audit: 2026-10-12

Windows checkout accessed through WSL, Node v24.18.0, installed dependencies;
temporary SQLite trigger and disposable handoff fixtures.

| Command | Actual result |
| --- | --- |
| `node --test test/handoff-reliability.test.js` | Exit 0; 20 passed, 0 failed/skipped; 7.280 seconds. Includes aborting and silently ignored purge-audit failures, retained version/link checks, and successful audited retry. |
| `node test/run-all.js test/handoff-reliability.test.js test/memory-maintenance.test.js test/tools.test.js --concurrency=1 --json` | Exit 0; three suites passed, 0 failed/skipped; 15.134 seconds. |
| `node --check src/db/handoff-store.js` and `node --check test/handoff-reliability.test.js` | PASS. |
| `node scripts/check-docs.js`, `node scripts/check-architecture.js`, `node scripts/check-test-architecture.js`, and `git diff --check` | PASS; architecture 462 files, test architecture 295 suites. |

The new regression failed against the pre-fix implementation: an aborting audit
insert threw after the historical version had already been deleted. The
regression also injects a silently ignored insert and verifies it is detected
and rolled back. Full test tiers and release validation were not run for this
scoped change.

## Resume project-scope milestone: 2026-10-12

Windows checkout accessed through WSL, Node v24.18.0, installed dependencies;
synthetic principals and disposable SQLite/Git fixtures.

| Command | Actual result |
| --- | --- |
| `node --test test/handoff-reliability.test.js` | Exit 0; 19 passed, 0 failed/skipped; 7.641 seconds. The three new scope cases each reproduced a failure before the handler fix and pass after. |
| `node test/run-all.js test/handoff-reliability.test.js test/handoff-concurrency.test.js test/tools.test.js test/project-identity.test.js test/dispatcher.test.cjs --concurrency=1 --json` | Exit 0; five suites passed, 0 failed/skipped; 32.471 seconds. |
| `node --check src/tools/families/resume.js` and `node --check test/handoff-reliability.test.js` | PASS. |
| `node scripts/check-docs.js` | PASS. |
| `node scripts/check-architecture.js` | PASS; 462 files. |
| `node scripts/check-test-architecture.js` | PASS; 295 suites. |
| `git diff --check` | PASS. |

No full required-tier, coverage, mutation, live/model, or release validation was
run for this scoped change. The prior handoff-versioning checkpoint assertion
failure remains open and is recorded above.

## Handoff save atomicity: 2026-10-12

Windows checkout accessed through WSL, Node v24.18.0, installed dependencies;
disposable SQLite/Git fixtures. No live database, service, model, or external
account was used.

| Command | Actual result |
| --- | --- |
| `node --test test/handoff-reliability.test.js` | Exit 0; 16 passed, 0 failed/skipped; 8.856 seconds. Includes injected create/update journal failures, state rollback, and safe retry. |
| `node test/run-all.js test/handoff-reliability.test.js test/handoff-concurrency.test.js test/handoff-versioning.test.js test/agent-handoff-continuity.test.js test/tools.test.js test/dispatcher.test.cjs --concurrency=1 --json` | Exit 1; five suites passed, `handoff-versioning.test.js` failed. It failed at line 255 because `checkpoint.handoff.checkpoint.repository.head` was `undefined` instead of the checkout HEAD. No assertion was changed. |
| `node test/handoff-versioning.test.js` | Exit 1; independently reproduced the same checkpoint `repository.head` assertion after the preceding versioning cases passed. Cause not established; this is recorded as a failure. |

The new regression injects journal failures for create/update and checks the
persisted row, version history, and journal are unchanged, then confirms retry
records exactly one successful event. This establishes logical transaction
rollback under the tested SQLite failures, not power-loss durability.

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

## Handoff trusted-project scope: 2026-10-12

The canonical MCP scope regression failed before the fix with a valid operator
principal: a request bound to `continuity` and omitting `project` included an
owned `other_project` handoff. The fixed test passes. `node test/run-all.js
test/handoff-reliability.test.js test/tools.test.js test/dispatcher.test.cjs
--concurrency=1 --json` exited 0: three suites passed, no skips; the
handoff-reliability suite reports 15 cases passing. A separate attempted run
including `test/security/security-boundaries.test.js` exited 1: seven test
assertions passed, then its cleanup hook failed to unlink its open SQLite DB on
Windows (`EBUSY`). That suite result is a failure; it is unrelated to the scope
assertion and remains unresolved here.

## Resume-pointer atomicity: 2026-10-12

On Windows/Node v24.18.0, the synchronized two-process regression failed before
the fix: both writers reported success but `resume_race_beta` was absent from the
final document. After the fix, `node test/run-all.js test/handoff-reliability.test.js test/tools.test.js test/project-identity.test.js --concurrency=1 --json` exited 0: three suites passed, no failures/skips. The handoff suite reports 14 passing cases, including the race; tools and project identity suites passed. No full platform suite was rerun for this scoped change.
