# Validation results

## PR #642 CI follow-up: 2026-10-12

- User-supplied CI logs report 61/62 platform suites passing on both Node 22
  and 24; `handoff-versioning.test.js` failed. A local runner reproduction
  failed at `resumed session clears terminal timestamp`: the returned
  `ended_at` retained its completion timestamp. `saveTaskSession` used COALESCE
  and therefore ignored the explicit null supplied by resume.
- The store now distinguishes omission from explicit null. Added assertions
  cover persisted/returned resume state and atomic rollback if the audit fails.
  `node test/run-all.js test/handoff-versioning.test.js
  test/handoff-reliability.test.js test/memory-intelligence.test.js
  --concurrency=1 --json` passed all three suites in 23.121 seconds, with no
  failures, skips, cancellations, or timeouts.
- Regenerated `docs/compatibility-pack-inventory.json`: the missing derived
  references were to `test/handoff-concurrency.test.js`; pack fingerprint and
  count remain unchanged. Two consecutive `npm run pack:inventory` executions
  produced identical bytes. `npm run proving:recipes` left its tracked output
  unchanged. The earlier docs check only validated the pack fingerprint, not
  these test-derived inventory fields; CI's generation comparison caught them.
- Syntax checks passed for the store and regression test; `npm run check:docs`,
  `npm run check:architecture`, `npm run check:tests`, and `git diff --check`
  also passed. Hosted Node 22/24
  reruns remain pending the user's signed commit and push; no full local
  platform-domain pass is claimed.

## Memory claim provenance: 2026-10-12

- Reconciled `improvement/memory-claim-provenance` at `aaefdb8`, matching the
  local remote-tracking ref for the pushed session-resume continuity branch.
  Preserved the three inherited uncommitted files. The prior-session regression
  recorded handoff fact state `active` instead of `pending`; that red run was
  supplied in continuity and was not rerun against reverted source here.
- Extended `test/memory-intelligence.test.js` covers pending handoff facts and
  session `verified_facts`, legacy unconfirmed facts from both sources, a pending
  non-fact, brief selection and prose, context/project exclusion, exact review,
  explicit confirmation readmission, and stale/orphan vector payloads. Vector
  retrieval uses deterministic local doubles; no model/Qdrant service is called.
  An initial added fixture failed exact lookup because similarity deduplication
  superseded one fixture fact. Distinct fixture text fixed that test setup.
- `node test/run-all.js test/memory-intelligence.test.js
  test/memory-lifecycle.test.js test/automatic-memory.test.js
  test/context-engine.test.js test/project-context-isolation.test.js
  test/tool-family-memory-core.test.cjs test/handoff-reliability.test.js
  --concurrency=1 --json` exited 0: seven suites pass, zero failures/skips,
  no cancellations/timeouts, cleanup errors, or reported resource leaks.
  The final grouped run took 20.376 seconds; handoff reliability has 32 cases.
- After tightening vector hydration to exclude disabled rows, the final
  `node test/run-all.js test/memory-intelligence.test.js --concurrency=1 --json`
  rerun exited 0 (one suite, 4.543 seconds), including the disabled confirmed
  memory regression. No failure, skip, cancellation, or timeout.
- `node --check` passed for all seven changed source files and the regression
  test. `npm run check:docs`, `npm run check:architecture` (463 files),
  `npm run check:tests` (295 suites), and `git diff --check` exited 0.
- Local sandbox setup intermittently returned `helper_unknown_error`; approved
  PowerShell escalation allowed source reads and tests. The Sidekick server
  could not access this checkout for repository profiling/documentation audit.
  No full required-tier, live-service, deployment, or independent evidence
  certification was performed. Changes await the user's signed commit and
  subsequent verification/push; no PR.

## Atomic handoff evidence refresh: 2026-10-12

Windows checkout accessed through WSL, Node v24.18.0, installed dependencies;
temporary SQLite trigger and disposable handoff database.

| Command | Actual result |
| --- | --- |
| `node --test test/handoff-reliability.test.js` | Exit 0; 29 passed, 0 failed/skipped; 7.099 seconds. Includes injected `evidence_refreshed` journal failure, rollback, and audited retry. |
| `node test/run-all.js test/handoff-reliability.test.js test/handoff-versioning.test.js test/memory-intelligence.test.js test/tools.test.js --concurrency=1 --json` | Exit 0; four suites passed, 0 failed/skipped/cancelled; 75.227 seconds. |
| `node --check src/db/handoff-store.js` and `node --check test/handoff-reliability.test.js` | PASS. |
| `git diff --check` | PASS. |

The new failure-injection case failed before the fix because evidence rows
persisted after the journal insert was rejected. Full tiers and release
validation were not run.

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

## Task-session audit atomicity: 2026-10-12

- Before the fix, a temporary trigger rejecting `task_session_saved` audit
  inserts caused `saveTaskSession` to throw after the session UPSERT persisted.
- After the fix, `node --check src/db/handoff-store.js`,
  `node --check test/handoff-reliability.test.js`, and
  `node --test test/handoff-reliability.test.js` exited 0. All 30 cases passed,
  including injected audit rollback and retry. No skip or cancellation.
- `node test/run-all.js test/handoff-reliability.test.js test/tools.test.js
  test/identity-resource-authority.test.js --concurrency=1 --json` exited 0:
  three suites passed, no failure, skip, cancellation, or cleanup error. The
  full required tiers were not rerun.

## Session and linked handoff transaction: 2026-10-12

- Before the fix, `node --test --test-name-pattern='session updates and linked
  handoff versions' test/handoff-reliability.test.js` failed as expected: a
  trigger rejected the linked handoff journal entry while the task session had
  already advanced its plan and next step.
- After the fix, that focused case passed. The full handoff suite and the
  `node test/run-all.js test/handoff-reliability.test.js test/tools.test.js
  test/identity-resource-authority.test.js --concurrency=1 --json` run exited 0:
  three suites passed, no failure, skip, cancellation or cleanup error. The
  handoff case also verifies the successful update path increments the handoff
  version and persists the new next step. Syntax, docs, architecture,
  test-architecture and diff checks pass. The full required tiers were not run.

## Partial session resume continuity: 2026-10-12

- Before the fix, the focused resume test failed: the session became active
  while its linked handoff remained completed.
- After the fix,
  `node --test --test-name-pattern='resuming a partial task session'
  test/handoff-reliability.test.js` exited 0. It injects checkpoint-event
  failure, checks the session remains completed and the draft is non-authoritative,
  retries without duplicating the child checkpoint, and tests a second partial
  completion/resume creates another linked checkpoint.
- The grouped
  `node test/run-all.js test/handoff-reliability.test.js test/tools.test.js
  test/identity-resource-authority.test.js --concurrency=1 --json` run exited 0:
  three suites passed with no failures, skips, cancellations, or cleanup errors.
  Syntax, docs, architecture, test-architecture, and diff checks passed. Full
  required tiers were not run.

## Security hardening follow-up: 2026-10-24

- `node test/run-all.js --tier=security --concurrency=4
  --overall-timeout-ms=300000 --json` passed: 165 suites, 0 failures, 0 skips,
  88.692 seconds. This run includes JSON-text credential redaction and the
  systemd file-mode assertions.
- Focused redaction and log suites passed (3 suites); the systemd hardening
  suite passed (2 tests). `node scripts/check-docs.js` and `git diff --check`
  passed.
- The combined required tiers (unit, contract, integration, security) completed
  twice with one failure each and no skipped, cancelled, timed-out, or unrun
  suites. The first failure was `tool-family-data-utilities.test.cjs`, which
  caught a JSON formatting regression; the redactor now preserves indentation
  and the failing suite passes in isolation. The second run failed
  `compute-worker-resilience.test.js` under full-suite load; its isolated rerun
  passed all seven internal assertions. These preliminary runs were not
  passing; see the corrected combined-tier rerun below.
- No deployment, live-service change, production data access, or dependency
  update was performed.

### Corrected combined-tier rerun

After preserving JSON formatting in the redactor and fixing the Compute Worker
initial-heartbeat revocation race, the same combined command passed:

```text
node test/run-all.js --tier=unit --tier=contract --tier=integration --tier=security --concurrency=4 --overall-timeout-ms=600000 --json
```

Result: 377 passed, 0 failed, 0 skipped, 0 cancelled, 0 timed out, and 0 not
run in 387.325 seconds. The Compute Worker resilience suite now also includes a
negative regression proving an initial 401 stops the worker without installing
a recurring heartbeat timer.

### All non-live suites

```text
node test/run-all.js --concurrency=4 --overall-timeout-ms=900000 --json
```

Result: 417 passed, 0 failed, 0 skipped, 0 cancelled, 0 timed out, and 0 not
run in 418.801 seconds. Architecture boundary, test-architecture, and
documentation checks also pass (519 files, 419 suites, and documentation drift
checks respectively).

### Coverage gate

`npm.cmd run test:coverage` passed after adding regression coverage for the
redactor's malformed and oversized JSON fallback paths. Aggregate coverage is
all 417 suites passed (0 failed or skipped) in 440.889 seconds. Aggregate
coverage is 78.84% lines/statements, 70.41% branches, and 81.41% functions.
Critical-file, security-domain, required-file, and baseline checks have no
failures; `src/redact.js` is at 100% lines, branches, statements, and functions.

### Supply-chain controls

- `.github/workflows/ci.yml` runs a digest-pinned Gitleaks full-history scan.
  Its package job installs without lifecycle scripts, checks lockfile
  stability, runs `npm audit --audit-level=moderate`, generates and validates a
  CycloneDX SBOM, and uploads the SBOM artifact.
- A local `npm.cmd sbom --package-lock-only --sbom-format=cyclonedx
  --sbom-type=application` run generated CycloneDX 1.5 with 203 components and
  204 dependency relationships. The file was written under the OS temporary
  directory, not the repository.
- On 2026-10-24, `npm.cmd audit --package-lock-only
  --audit-level=moderate` completed successfully and reported 0 vulnerabilities
  for the current lockfile. The read-only GitHub Dependabot alerts query through
  WSL reported no open alerts; 19 previously reported alerts are marked fixed.
  No dependencies or lockfiles were changed by these checks.

### Dashboard database route authorization

The direct Dashboard schema, statistics, migration-list, and backup handlers
previously read SQLite or created backups outside the canonical dispatcher.
Schema and statistics require `database.inspect`, migration status requires
`tools.execute_high`, and backup requires `tools.execute`; all four now call the
canonical database tools, applying consistent authorization, policy, approval,
and tool auditing. The statistics tool now skips per-table count queries when
`detailed` is false, avoiding unnecessary scans for the Dashboard summary. The
focused `node test/run-all.js test/security-dashboard-direct-routes.test.js
test/security-project-access.test.js test/db-tools.test.js
test/tool-family-database-inspection.test.cjs test/security-invariants.test.js --concurrency=1
--overall-timeout-ms=300000` run passed all five suites, including
denied-before-storage checks, dispatcher use and response compatibility, and
approval-required backup behavior. The broader Dashboard route authorization
review remains in progress.

### Metrics service secret provisioning

The metrics unit previously loaded `/home/sidekick/sidekick/.env`, while the
collector reads `SIDEKICK_INFLUX_TOKEN` through the protected runtime secret
file API. Installer timer-enablement checks also searched that dotenv file,
which could both miss a valid file-backed token and enable the timer for an
environment-only token that production code rejects. The unit now receives the
protected secret directory and system configuration file, applies the Core
service hardening profile, and both installers check the secret through the
runtime file reader as the `sidekick` service identity without printing its
value.

Validation: `node test/run-all.js test/security/systemd-core-hardening.test.js
test/security-install-scripts.test.js --concurrency=1
--overall-timeout-ms=300000` passed both suites; `git diff --check` passed.
The verifier regression uses synthetic secrets to prove valid file-backed tokens
are accepted while placeholders and environment-only values are rejected, with
no secret value printed. An initial PowerShell-hosted Bash syntax attempt was
denied; after elevation was available, WSL `bash -n` passed for
`scripts/bootstrap.sh`, `scripts/setup-tools.sh`, and both execution-node WSL
installer scripts. Linux systemd runtime behavior and an installer run remain
unverified; no production service or timer was changed.

### Execution-node systemd workspace grants

The WSL user unit protects the home tree as read-only. That blocked authorized
workspace write operations even when both the local node config and Core
workspace grant allowed them. The installer now creates a systemd drop-in with
`ReadWritePaths` for only the configured real workspace under `~/Projects`,
and only when `permissions.write` is explicitly true. Removing that local grant
removes the generated write path. The default workspace now resolves under the
installing user's home directory rather than a fixed username.
Uninstall removes only the generated workspace drop-in and leaves unrelated
user-created drop-ins intact. It also canonicalizes the install prefix and
refuses symlinks, paths outside the user's home, and paths that do not end in
the dedicated `sidekick-execution-node` directory before recursive removal.

Validation: execution-node administration and systemd hardening suites passed;
the installer behavior regression verifies narrow path generation, `%` path
escaping, and removal after revocation. `npm run check:docs` and `git diff
--check` passed. The WSL installer and systemd namespace behavior were not run
on this Windows host.

### Dashboard memory-evidence project scope

An adversarial synthetic fixture reproduced an authorization leak in
`GET /api/memories/:id/evidence`: a principal with read access to project A's
handoff could retrieve a linked memory belonging to project B. The regression
failed before the fix with HTTP 200 where 404 was required. The route now checks
the memory's project, the linked handoff's access, and equality of their project
scopes. A positive same-project linked-memory case verifies legitimate access
is preserved, while the cross-project case asserts the private memory text is
not returned.

Validation after the fix: `node test/run-all.js
test/security-project-access.test.js test/security-dashboard-direct-routes.test.js
--concurrency=1 --overall-timeout-ms=300000` passed both suites (2 passed, 0
failed, 0 skipped). The fixture is synthetic. No production database or live
service was accessed.

### Handoff packet credential redaction

Before the fix, nested synthetic values under `api_key`, `token`, and
`password` fields survived packet redaction and appeared in the current row,
version history, and first-class linked payloads. Handoff packet writes now use
`redactSensitiveKeysDeep`, preserving the packet shape while replacing values
under sensitive field names. Regression evidence checks all of these persisted
representations after both create and update.

Validation after the fix: `node test/run-all.js
test/security-project-access.test.js test/handoff-reliability.test.js
test/handoff-versioning.test.js test/security-phase-07-secrets-redaction.test.js
--concurrency=2 --overall-timeout-ms=300000` passed all four suites (4 passed,
0 failed, 0 skipped). The test uses synthetic values and disposable SQLite
state. Existing production rows were not inspected or rewritten.

### Handoff-linked memory scope

A synthetic project-A handoff fixture linked both a legitimate project-A memory
and two unscoped memories, one through `source_ref` and one through
`metadata.handoff_id`. The pre-fix Dashboard route returned the source-linked
unscoped record, failing the negative assertion. Both Dashboard handoff detail
and MCP `handoff inspect` now filter to exact project equality before returning
linked memory rows. Positive project-A linkage remains visible; both unscoped
canaries are excluded.

Validation after the fix: `node test/run-all.js
test/security-project-access.test.js test/security-dashboard-direct-routes.test.js
--concurrency=1 --overall-timeout-ms=300000` passed both suites (2 passed, 0
failed, 0 skipped). The fixture is synthetic; no live service or production
database was accessed.

### Security-focused regression suite refresh (2026-10-24)

Command: `node test/run-all.js <119 root-level security*.test.js suites>
--concurrency=4 --overall-timeout-ms=900000`, followed by
`node test/run-all.js test/security/security-boundaries.test.js
--concurrency=1 --overall-timeout-ms=300000`. Combined result: 120 passed,
0 failed, 0 skipped. The runs include dashboard and project access, Agent proxy
and recovery, MCP identity, secrets, sandbox fail-closed behavior, installation,
network boundaries, supply-chain controls, and the security-invariant suites.
This is non-live regression evidence; it does not validate deployed Linux
systemd behavior, external attack surfaces, or untested paths.
