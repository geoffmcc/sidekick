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
- A refreshed online `npm.cmd audit` on 2026-10-24 could not reach
  `registry.npmjs.org`. `npm.cmd audit --offline --json` returned zero findings
  from local cache, which does not establish current advisory status. No
  dependency state was changed; current online audit remains pending network
  availability.
- `npm.cmd ls --all --json` exits 1 with one installed-tree problem:
  `tree-sitter@0.25.1` conflicts with optional peer ranges declared by the
  pinned Java, Perl, Ruby, Rust, and TypeScript grammar packages. The complete
  `npm.cmd test` run nevertheless passed 379/379 suites; this does not prove
  runtime compatibility for every grammar. No dependency versions changed.

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

### Handoff text credential persistence

The previous test contract verified that raw handoff content stayed in the
database even when `redacted_content` was sanitized. A synthetic regression now
checks content and title text across create and version update, including a
legacy fixture with raw credential-shaped text already in the current row and
packet. Saves now persist redacted current text; when the legacy fixture is
explicitly updated, its new history snapshot is also redacted. Untouched
historical production rows were not inspected or migrated.

Validation: `node test/run-all.js test/security-project-access.test.js
test/handoff-versioning.test.js test/handoff-reliability.test.js
test/security-phase-07-secrets-redaction.test.js --concurrency=2
--overall-timeout-ms=300000` passed all four suites (4 passed, 0 failed, 0
skipped). The regression used synthetic credentials and disposable SQLite.

### Persistent memory redaction (2026-10-24)

`node test/run-all.js test/security-memory-authority.test.js
test/memory-sync.test.js test/automatic-memory.test.js
test/handoff-reliability.test.js --concurrency=1
--overall-timeout-ms=300000` passed 4/4 suites. A follow-up run of
`test/security-project-access.test.js` and
`test/security-phase-07-secrets-redaction.test.js` passed 2/2 suites.
`npm run check:docs` and `git diff --check` passed. Synthetic fixtures verify
credential-shaped values are absent from direct memory writes, imports,
metadata, source references, evidence text, lifecycle reasons, and audit/event
rows. These tests do not detect secrets supplied as generic values in ordinary
fields and do not inspect or migrate historical databases. A synthetic legacy
row test also confirms normalized reads redact known patterns without changing
the underlying historical row.

### Legacy context document redaction (2026-10-24)

The `context` JSON document now passes through recursive key-aware redaction on
write and projection. Legacy context tool objects are sanitized before
embedding-store calls, and legacy non-memory vector payloads are redacted before
they are returned by context recall. `node test/run-all.js
test/security-memory-authority.test.js test/context-engine.test.js
test/security-project-access.test.js --concurrency=1
--overall-timeout-ms=300000` passed all 3 suites. The focused security-memory
authority and context-engine suites were rerun after adding the mocked vector
payload regression and passed 2/2. The synthetic legacy-row test
confirms a read is redacted while the underlying JSON remains unchanged; no
live vector store was used.

### Handoff repository path-policy boundary (2026-10-24)

`node test/run-all.js test/security-project-access.test.js --concurrency=1
--overall-timeout-ms=300000` passed all 74 assertions. Synthetic authenticated
MCP handoff creation does not persist an out-of-scope repository path, and
verification plus Dashboard preflight against outside paths are rejected by
policy. The session tool also rejects an out-of-scope workspace before creating a session.
Agent continuity has a negative regression proving denied workspace paths stop
before handoff persistence or Git checkpointing. The Agent Bridge integration
and continuity suites passed 2/2 (including restart identity recovery); direct
database-store callers remain under review and are not covered by these results.

### Handoff claim-token dispatch boundary (2026-10-24)

`node test/run-all.js test/security-project-access.test.js --concurrency=1
--overall-timeout-ms=300000` passed (1 suite, 73 assertions). The new integration
case claims a synthetic, ready handoff through the MCP dispatcher, confirms the
authenticated response contains the one-time token, confirms tool logs do not,
and confirms an identityless retry receives no token and does not replace the
active claim. The fixture uses a disposable Git repository and SQLite database.

### Retrieved context trust-label boundary (2026-10-24)

`test/evidence-projector.test.js` supplies a synthetic retrieved entry whose
provenance claims `SYSTEM-TRUSTED` and verifies the model-facing projection
omits both the claim and any `Trust:` label. Provenance remains available to
evidence/audit paths. This is a prompt-boundary hardening regression, not proof
that arbitrary malicious content cannot influence a model or that authorization
can be inferred from model behavior; execution authority remains a dispatcher
responsibility.

### Scheduled watch authority (2026-10-24, SK-034)

`node test/run-all.js test/security-scheduled-watch-authority.test.js
test/scheduled-authority.test.js test/scheduled-delay-dispatch.test.js
test/security-watch-endpoint-egress.test.js test/scheduler-platform.test.js
test/scheduling-cancel.test.js --concurrency=1
--overall-timeout-ms=900000` passed 6/6 suites. The tests verify signed
definition binding, current principal/credential/permission checks, scope
narrowing, Agent-envelope reevaluation, and pausing before a timer check when
authority cannot be verified. Existing scheduled delay, watch, cancellation,
and endpoint-egress behavior also passed. `npm run check:docs` and
`git diff --check` passed. Existing unsigned production watches were not
inspected; implementation pauses them at their next timer tick.

`npm run check:tests` initially found an unsafe cleanup construct in
`test/security/systemd-core-hardening.test.js`. Cleanup now goes through a
shared helper that restricts removal to the named `mkdtemp` child of the OS temp
directory, rejects a replaced/symlink fixture root, and unlinks symlinks rather
than following them. The architecture check now passes all 420 suites, and the
systemd hardening suite passes on Windows.

### Handoff claim repository path policy (2026-10-24, SK-035)

The handoff call-site audit found `claimHandoff` evaluates readiness and reads
the checkpoint repository internally, while the MCP `claim` action had not
checked that persisted workspace against the caller's filesystem policy. The
MCP action now rejects the request before the store call when the checkpoint
workspace is outside the allowed roots. A regression prepares a disposable
Git repository outside the configured MCP allow-list, captures a ready
handoff checkpoint there, and verifies that the authenticated claim fails
with a path-policy error and leaves the handoff unclaimed, even when the
request supplies a different, allowed workspace path.

`node test/run-all.js test/security-project-access.test.js --concurrency=1
--overall-timeout-ms=300000` passed (1 suite, 0 failures). This validates the
MCP entry path; it does not make the internal database store a standalone
authorization boundary or cover arbitrary code executing inside Core.

### Dependency advisory refresh unavailable (2026-10-24)

`npm.cmd audit --json` was attempted against the current lockfile, but the
configured environment could not reach `https://registry.npmjs.org/-/npm/v1/security/advisories/bulk` and npm returned an audit endpoint error. No dependency files
were changed. The prior same-day audit snapshot remains recorded in the
security review but is not a fresh result; dependency advisory status needs to
be refreshed in an environment with registry access. This check makes no claim
about current lockfile vulnerability status.

## Browser E2E runtime propagation: 2026-10-24

- Fixed required browser-suite execution under the sanitized suite environment:
  the browser resource provisioner now forwards the absolute configured
  `SIDEKICK_BROWSER_BROWSERS_PATH`, or the repository-managed runtime when
  present. The runtime binaries remain separate from the disposable per-suite
  browser profile. Ambient credentials remain scrubbed.
- The missing-runtime path now returns the runner skip code. Since this suite is
  required, missing E2E coverage fails the validation gate instead of appearing
  as a successful run. A deliberately invalid configured path failed the
  required suite as expected.
- Validation: `test/security/test-runner-environment.test.js`,
  `test/browser-egress.test.js`, `test/browser-subsystem.test.js`, and
  `test/run-all.test.js` passed through the authoritative runner. Actual
  Chromium browser E2E reported 27 passed, 0 failed. `npm.cmd run check:tests`,
  `npm.cmd run check:docs`, and `git diff --check` passed. This records the
  targeted result only; the full test tiers were not run.

## Agent follow-up authority preservation: 2026-10-24

- Added a real Agent Bridge API regression using an authenticated principal and
  a parent task constrained to `read_only`. The follow-up route rejects a
  caller-supplied replacement authority envelope and creates a child retaining
  only `read_only`; change, external, and production effects remain disabled.
  Child depth and count are reduced.
- Validation: `node test/run-all.js test/agent-bridge-followup.test.js
  --concurrency=1 --overall-timeout-ms=300000 --json` passed (1 suite, 32 API
  and security assertions, 0 failures, 135.7 seconds). This establishes this
  route's current behavior only; recovery and other child-creation paths retain
  their separate coverage requirements.

## Fractional Agent quota limits: 2026-10-24 (SK-038)

- Regression first failed because `createAuthorityEnvelope` preserved
  `child_task_depth`, `child_task_count`, and `concurrency_limit` as `1.9`.
  Integer reservation and active-work counts could then exceed those quotas by
  one.
- Fixed envelope normalization to floor bounded quotas. Child reservations and
  durable work-package concurrency independently floor the persisted values;
  Agent execution and approval-resume concurrency pass integer limits onward.
- Validation: `test/agent-authority-quotas.test.js`,
  `test/agent-authority-approval.test.js`, `test/agent-durable-operations.test.js`,
  `test/agent-task-store.test.js`, `test/agent-task-model.test.js`,
  `test/approval-continuation.test.cjs`, and `test/brain-concurrency.test.js`
  passed (7 suites, 0 failures). The quota regression also injected fractional
  values directly into disposable SQLite task rows to exercise enforcement
  beyond input normalization. No production data was accessed.

## Agent task-control route ownership: 2026-10-24

- Route review verified that `pause` and `cancel` are covered by the shared
  `enforceTaskRouteAccess` middleware mounted for `/api/agent/tasks/:taskId`
  and `/api/agent/run/:taskId`. The middleware checks ownership and current
  project access before route handling.
- Added an API regression that waits until a task is actively running, attempts
  pause and cancel as a different authenticated principal, and confirms both
  requests return 404 without changing control flags or task state.
- Validation: `node test/run-all.js test/agent-bridge-followup.test.js
  --concurrency=1 --overall-timeout-ms=300000 --json` passed (1 suite, 33
  Agent Bridge API/security assertions, 0 failures, 150.1 seconds). No bypass
  was confirmed; no production state was involved.

## Scheduled command identity and crontab preservation: 2026-10-24 (SK-039)

- Added HMAC-bound cron definitions and current-principal/credential/critical
  permission revalidation for OS-launched and manual runs. Unsigned legacy jobs
  are rejected until explicitly authorized; runner context keeps the creator's
  source policy. Cron creation rejects principals without critical-command
  permission and refuses Agent envelopes requiring future approval.
- Crontab reconciliation now replaces only Sidekick-marked entries, preserves
  unrelated jobs, and gives the runner an allowlist of non-secret runtime paths
  and policy settings. NUL/newline-bearing values are excluded, and raw secret
  values are never forwarded to crontab.
- Validation: `node --test test/scheduled-authority.test.js` passed (10 tests);
  `node test/scheduler-platform.test.js` passed on Windows for the applicable
  identity, migration, scope, and preservation assertions; its shell boundary
  correctly refused execution on Windows. The full scheduler suite then passed
  in WSL on Linux, including successful OS cron runner dispatch and real
  Bubblewrap command execution. The first WSL run installed three synthetic
  test entries; they were removed by exact Sidekick markers, the resulting
  crontab read was empty, and test mode now prevents OS crontab writes.
  `npm.cmd run check:tests`, `npm.cmd run check:docs`, `node --check` on changed
  JavaScript, and `git diff --check` passed. No production crontab or database
  was accessed.

## Inbound identity boundary review: 2026-10-24

- Reviewed MCP bearer authentication/session identity, Compute worker and
  enrollment routes, scoped Compute administration, and execution-node admin
  routes. No identity spoofing or route bypass was confirmed in the reviewed
  source paths.
- Targeted regression command:
  `node test/run-all.js test/security-mcp-session-identity.test.js
  test/mcp-v2-runtime.test.cjs test/compute-jobs-mcp-contract.test.js
  test/execution-node-protocol.test.js --concurrency=1
  --overall-timeout-ms=600000 --json` passed all 4 suites with 0 failures and
  0 skips.
- This evidence covers the reviewed paths and targeted suites; it does not
  establish that every Dashboard, CLI, Agent Bridge, or future route uses the
  same identity boundary.

## Dashboard project and Agent Bridge read boundaries: 2026-10-24

- Targeted command: `node test/run-all.js test/security-project-access.test.js
  test/security-dashboard-direct-routes.test.js test/security-agent-proxy-scopes.test.js
  --concurrency=1 --overall-timeout-ms=600000 --json` passed all 3 suites,
  0 failures, 0 skips. The project-access suite passed 74 assertions, including
  revocation, cross-project memory/handoff evidence, and scope propagation.
- Source review found current memory and handoff reads recheck project
  membership, and the Agent relay binds the authenticated Dashboard identity
  and scope context to its signed upstream request. No bypass was confirmed in
  these paths; this is not exhaustive evidence for every Dashboard or Agent
  route.

## Dashboard session, CSRF, and proxy trust: 2026-10-24

- `node test/run-all.js test/dashboard-api.test.js
  test/security-dashboard-bootstrap.test.js test/security/trusted-proxies.test.js
  --concurrency=1 --overall-timeout-ms=600000 --json` passed all 3 suites,
  0 failures and 0 skips. Dashboard API checks include deceptive host/scheme
  Origins, originless cross-site requests, originless requests with session
  cookies, revocation of issued identity cookies, and Grafana permission checks.
- Source review confirmed proxy trust defaults off and the compatibility `true`
  value is constrained to loopback. Remote trust requires explicit IP/CIDR
  entries, and remote bootstrap requires its out-of-band token.
- No bypass was confirmed in these tested paths. Legacy non-browser Basic-auth
  clients may omit Origin/Fetch Metadata when no dashboard session cookie is
  present; this compatibility boundary remains a review item.

## Generic credential response caching: 2026-10-24 (SK-040)

- Fixed generic credential create and rotate responses to emit
  `Cache-Control: no-store` and `Pragma: no-cache` before returning bearer
  token material.
- `node test/run-all.js test/security-dashboard-service-credentials.test.js
  test/security-dashboard-principal.test.js --concurrency=1
  --overall-timeout-ms=600000 --json` passed 2 suites, 0 failures, 0 skips.
  Credential tests verify no-store headers on issuance/rotation, prior-token
  invalidation, and existing scope/ownership denials.

## Core API response caching: 2026-10-24 (SK-041)

- Added a Core-wide no-store response policy and enforced it after MCP SDK
  response headers are copied. Legacy MCP SSE still uses the upstream
  transport's `no-cache, no-transform` streaming policy.
- `node test/run-all.js test/mcp-v2-runtime.test.cjs
  test/compute-protocol.test.js --concurrency=1 --overall-timeout-ms=900000
  --json` passed both suites, 0 failures and 0 skips. The tests verify live MCP
  initialization/tool responses, Compute enrollment-token issuance, worker
  enrollment credentials, and rotated worker credentials carry
  `Cache-Control: no-store`. A rerun of `test/compute-protocol.test.js` passed
  after adding the worker credential assertions.

## Agent Bridge response caching: 2026-10-24 (SK-042)

- Added no-store headers to Agent Bridge HTTP responses. Its SSE endpoint
  continues to use the upstream-compatible `no-cache` streaming policy.
- `node test/run-all.js test/agent-bridge-followup.test.js --concurrency=1
  --overall-timeout-ms=600000 --json` passed (1 suite, 33 API/security
  assertions, 0 failures, 0 skips; 144.7 seconds), including the live task
  response cache-header assertion and task ownership/recovery boundaries.

## Executable packs and declarative workflow boundaries: 2026-10-24 (SK-043)

- `node test/run-all.js test/modules-third-party-lifecycle.test.js
  test/capability-packs.test.js test/pack-contract.test.js
  test/workflow-definitions.test.js --concurrency=1
  --overall-timeout-ms=900000 --json` passed all 4 suites, 0 failures, 0 skips.
- Coverage includes no third-party entry execution during inspection/install,
  fail-closed entry loading and direct activation, tamper and first-party
  provenance checks, pack workflow declaration validation, per-step dispatcher
  authorization, nested workflow authority attenuation, and resume identity
  rejection.
- Third-party executable modules remain unavailable because there is no
  enforced OS isolation backend. Bundled first-party modules share Core's
  privileges and are not isolated; that trust exception remains explicit.

## Generated workflow cancellation propagation: 2026-10-24 (SK-044)

- `node test/run-all.js test/evolve.test.js --concurrency=1
  --overall-timeout-ms=600000 --json` passed (1 suite, 0 failures, 0 skips).
- Regression evidence verifies the canonical dispatcher passes its abort
  signal to generated execution, nested generated steps receive that signal,
  and cancellation prevents a later step from starting while persisting the
  generated execution as cancelled.
- `git diff --check` passed. Cancellation remains cooperative for an
  individual in-flight tool handler; the existing dispatcher reports when a
  timed-out operation may still be running.

## Generated capability approval attribution: 2026-10-24 (SK-045)

- `node test/run-all.js test/evolve.test.js
  test/security-evolve-boundary.test.js --concurrency=1
  --overall-timeout-ms=600000 --json` passed both suites, 0 failures and
  0 skips. The Evolve regression verifies a caller-supplied fake approver is
  ignored and the authenticated principal is persisted; the boundary suite
  verifies lifecycle operations still require an authenticated identity.
- `npm.cmd run check:docs`, `npm.cmd run check:architecture`,
  `npm.cmd run check:tests`, and `git diff --check` passed.

## Knowledge promotion attribution: 2026-10-24 (SK-046)

- `node test/run-all.js test/knowledge-promotion.test.js --concurrency=1
  --overall-timeout-ms=600000 --json` verifies forged approver labels do not
  authorize promotion, a separate dispatcher approval is required, and the
  persisted `approved_by` value matches the authenticated reviewing principal.
- The unused `approver` input was removed from the knowledge tool schema and
  reference guidance now describes the enforced approval path.

## Workflow resume project-scope continuity: 2026-10-24 (SK-047)

- `node test/run-all.js test/workflow-definitions.test.js --concurrency=1
  --overall-timeout-ms=900000 --json` passed (1 suite, 0 failures, 0 skips).
- Regression `WD.11k` verifies resumed dispatch retains the persisted project
  when the caller omits it and rejects an explicit conflicting project before
  any step dispatch; corrupted persisted project data also fails closed.

## Dashboard frontend error-log write amplification: 2026-10-24 (SK-048)

- `node test/run-all.js test/dashboard-honesty.test.js
  test/security-dashboard-bootstrap.test.js --concurrency=1
  --overall-timeout-ms=900000 --json` passed both suites, 0 failures and
  0 skips. The live Dashboard route accepts the 30-report principal burst and
  rejects the next report with HTTP 429; bootstrap security regressions pass.
- After restoring LF line endings in the touched Markdown files,
  `npm.cmd test` passed all 379 unit, contract, integration, and security
  suites with 0 failures and 0 skips.
- The client-wide limit is enforced alongside the principal limit. Limits are
  process-local and reset at restart; durable log retention remains unbounded.

## Identity audit detail redaction and size boundary: 2026-10-24 (SK-050)

- `node test/run-all.js test/security-identity-audit-atomicity.test.js
  test/identity-foundation.test.js test/security-dashboard-event-audit.test.js
  test/security-compute-admin.test.js --concurrency=1
  --overall-timeout-ms=900000 --json` passed all 4 suites, 0 failures and
  0 skips.
- Synthetic nested `api_key` and authorization fields are absent from stored
  details; an oversized event fails before insertion. Existing identity
  mutation audit-failure tests continue to verify rollback of role,
  delegation, credential, session, and user-state changes.
- `npm.cmd test` passed all 379 unit, contract, integration, and security
  suites with 0 failures and 0 skips after this change.

## Dashboard diagnostic file retention boundary: 2026-10-24 (SK-051)

- `node test/run-all.js test/dashboard-error-boundary.test.js
  test/dashboard-honesty.test.js test/security-dashboard-bootstrap.test.js
  --concurrency=1 --overall-timeout-ms=900000 --json` passed all 3 suites,
  0 failures and 0 skips.
- The test forces multiple rotations with a small cap, verifies both retained
  JSONL files remain within the configured bounds and parse as complete lines,
  verifies oversized entries are dropped, and verifies untrusted component
  labels cannot expand a record beyond its safe bound.
- After SK-051, `npm.cmd test` passed all 379 unit, contract, integration, and
  security suites with 0 failures and 0 skips.
- `npm.cmd run check:docs`, `check:architecture`, and `check:tests`, plus the
  focused static-code-quality suite, passed.

## Dashboard audit detail redaction and size boundary: 2026-10-24 (SK-052)

- `node test/run-all.js test/security-dashboard-audit-identity.test.js
  test/security-dashboard-audit-log.test.js
  test/security-dashboard-event-audit.test.js --concurrency=1
  --overall-timeout-ms=900000 --json` passed all 3 suites, 0 failures and
  0 skips.
- Nested synthetic API-key and authorization values are redacted before
  serialization. Oversized audit lines fail before the file is opened and
  leave existing audit history unchanged. Existing symlink, hardlink,
  permission, fsync, and event-atomicity regressions continue to pass.
- After SK-052, `npm.cmd test` passed all 379 unit, contract, integration, and
  security suites with 0 failures and 0 skips.
- `npm.cmd run check:docs`, `check:architecture`, and `check:tests` passed.

## Quick-action restart request audit gate: 2026-10-24 (SK-053)

- `node test/run-all.js test/security-dashboard-direct-routes.test.js
  test/dashboard-api.test.js --concurrency=1 --overall-timeout-ms=900000
  --json` passed both suites, 0 failures and 0 skips.
- An injected audit sink failure returns 503 and prevents both execution
  record creation and the service restart call. The existing route tests still
  verify that permission denial stops before audit or execution.
- After SK-053, `npm.cmd test` passed all 379 unit, contract, integration, and
  security suites with 0 failures and 0 skips.
- `npm.cmd run check:docs`, `check:architecture`, and `check:tests`, plus
  `git diff --check`, passed.

## Optional host-tool package version drift: 2026-10-24 (SK-054)

- `node test/run-all.js test/security-install-scripts.test.js --concurrency=1
  --overall-timeout-ms=600000 --json` verifies setup runs third-party package
  hooks as the `sidekick` user and now requires explicit direct versions for
  yt-dlp, OpenAI Whisper, DuckDB, and Mermaid CLI. The regression rejects the
  former unversioned install forms.
- Selected Python direct releases were cross-checked against upstream PyPI
  project pages on 2026-10-24. Existing installed tools remain untouched by
  the setup script's existing presence checks.
- Python transitive resolution and artifact hash verification remain open.
- After the installer change, `npm.cmd test` passed all 379 unit, contract,
  integration, and security suites in 417.023 seconds, with 0 failures and
  0 skips. The focused installer test also passed independently.
- `npm.cmd run check:docs`, `npm.cmd run check:architecture`,
  `npm.cmd run check:tests`, Git for Windows Bash `-n` syntax validation of
  `scripts/setup-tools.sh`, and `git diff --check` passed.

## Locked Mermaid CLI runtime: 2026-10-24 (SK-055)

- The installer regression verifies the Mermaid CLI manifest version matches
  the lock root; every resolved package uses the HTTPS npm registry and has a
  SHA-512 integrity digest; setup invokes `npm ci` as the `sidekick` user and
  retains detection of legacy global installs.
- `npm.cmd ci --dry-run --ignore-scripts --no-audit --no-fund --prefix
  scripts/tooling/mermaid-cli` accepted the manifest and lock and resolved the
  locked tree; npm selected 190 install actions for this Windows dry-run, from
  200 package records in the lock (including platform-specific optional
  entries). Lifecycle hooks were not executed and no packages were installed.
- The upstream 11.17.0 manifest metadata confirms Node `^18.19 || >=20.0`,
  compatible with the repository's Node >=22 requirement. A clean install,
  Puppeteer browser download, and Mermaid rendering were not validated.
- After the locked installer change, `npm.cmd test` passed all 379 unit,
  contract, integration, and security suites in 413.092 seconds, with
  0 failures and 0 skips. The focused installer suite, docs, architecture,
  test-architecture, Git for Windows Bash syntax check, and `git diff --check`
  also passed.

## Database backup temporary-path hard links: 2026-10-24 (SK-056)

- `node test/run-all.js test/security-db-backup-paths.test.js --concurrency=1
  --overall-timeout-ms=600000 --json` passed all 3 cases. They verify that
  raw backup, compressed backup, and compressed restore do not write through
  pre-planted hard links to a synthetic target file.
- The tests exercise the isolated database storage boundary directly. Full
  `test/db-tools.test.js` also passed, including its direct-handler authorization
  check. `npm.cmd run check:docs`, `check:architecture`, `check:tests`, and
  `git diff --check` passed.
- After normalizing the new test file to the repository's required LF endings,
  `npm.cmd test` passed all 380 unit, contract, integration, and security
  suites in 472.935 seconds, with 0 failures and 0 skips.

## Database backup and restore resource bounds: 2026-10-24 (SK-057)

- `node test/run-all.js test/security-db-backup-paths.test.js test/db-tools.test.js
  test/static-code-quality.test.js --concurrency=1 --overall-timeout-ms=900000
  --json` passed all 3 suites. Six database path regressions cover private
  hard-link handling, streamed backup size enforcement, raw restore limits,
  gzip expansion limits, and preserving an integrity-valid live database
  after rejected restores. Existing database authorization and tool behavior
  and static source quality checks also passed.
- The configured default byte ceiling is 2 GiB; `SIDEKICK_DB_BACKUP_MAX_BYTES`
  can be set by administrators for larger installations. CPU-time bounds for
  compression and decompression are not provided.
- `npm.cmd run check:docs`, `npm.cmd run check:architecture`,
  `npm.cmd run check:tests`, and `git diff --check` passed.
- After the streaming implementation, `npm.cmd test` passed all 380 unit,
  contract, integration, and security suites in 463.763 seconds, with 0
  failures and 0 skips.

## Media download URL credential persistence: 2026-10-24 (SK-058)

- `node test/run-all.js test/download-custody.test.js
  test/tool-log-redaction.test.js test/security-invariants.test.js
  test/static-code-quality.test.js --concurrency=1
  --overall-timeout-ms=900000 --json` passed all 4 suites. A synthetic
  credential under an unrecognized `download_ticket` query name is absent from
  artifact metadata, verification evidence, tool-log arguments, success
  results, and downloader failure diagnostics; origin attribution is retained.
- `npm.cmd run check:docs`, `npm.cmd run check:architecture`,
  `npm.cmd run check:tests`, and `git diff --check` passed.
- After the download URL persistence fix, `npm.cmd test` passed all 380 unit,
  contract, integration, and security suites in 460.000 seconds, with 0
  failures and 0 skips.

## Python tools dependency hash lock: 2026-10-24 (SK-059)

- Generated universal Python 3.10+ requirement locks for the optional Python
  tools and the setuptools build backend with uv `--generate-hashes`.
- Updated `setup-tools.sh` to install build requirements and runtime packages
  as the `sidekick` user with pip hash checking; runtime builds do not resolve
  separate unpinned build dependencies.
- Setup now fails with an explicit diagnostic below Python 3.10, the minimum
  required by the pinned yt-dlp and DuckDB versions.
- Added regression assertions for the exact direct versions, artifact hashes
  on every resolved package, and use of the lock files by the installer.
- Clean-host installation and platform runtime behavior remain unverified.

## Dependency advisory and parser peer checks: 2026-10-24

- `npm audit --json` succeeded once and reported 0 vulnerabilities across 219
  dependencies. An immediate repeat could not reach the advisory endpoint, so
  the successful result is a dated snapshot rather than repeatable live status.
- `npm ls --all` exits with `ELSPROBLEMS` because several grammar packages
  declare optional `tree-sitter` peers below root version 0.25.1.
- Registry metadata review found no newer compatible Java, Ruby, Rust, or
  TypeScript grammar versions. The focused `semantic-repository` suite passed
  across all seven supported languages; no dependency changes were made.

## Dashboard diagnostic log path integrity: 2026-10-24 (SK-060)

- `node test/run-all.js test/security-dashboard-diagnostic-log.test.js
  test/dashboard-error-boundary.test.js test/security-dashboard-audit-log.test.js
  --concurrency=1 --overall-timeout-ms=900000 --json` passed all 3 suites.
- A synthetic hard-link target was unchanged after diagnostic logging rejected
  the unsafe log path. The symlink regression is platform-skipped on Windows;
  it is active on POSIX CI.
- Concurrent diagnostic rotation across multiple Dashboard processes remains
  a documented limitation.

## Git output-file path authorization: 2026-10-24 (SK-061)

- `node --test test/security-git-metadata-isolation.test.js` passed. The
  disposable fixture first confirms that Git itself can write a synthetic
  diff to an out-of-scope file, then verifies that the canonical Sidekick Git
  helper rejects separate, attached, and equals-form output arguments without
  creating that file.
- The focused Git metadata suite also covers gitfile and alternate-object
  policy, inherited Git environment neutralization, fsmonitor, external diff,
  credentials, filters, and hooks.
- `npm.cmd run check:docs`, `check:architecture`, `check:tests`, and
  `git diff --check` passed. The finding is limited to this argument-mediated
  write path; no general filesystem isolation claim is made.

## web_fetch network-scope protocol matching: 2026-10-24 (SK-062)

- `node test/network-scope-fetch.test.js` passed. A local HTTP fixture and
  synthetic `ws`-only scope reproduced the previous mismatch; the fixed
  handler rejects both ws and wss URLs before the fixture receives a request.
  Existing scoped HTTP request, denied metadata target, DNS failure/rebinding,
  unreachable target, and timeout cases also passed.
- `node --test test/outbound-url-security.test.js
  test/security-net-fetch-bounds.test.js` passed (6 tests). In the same
  combined invocation, `test/security-invariants.test.js` had one unrelated
  Windows environment failure: its deployment-secret test could not verify
  temporary-directory ACLs and failed before reaching the expected missing
  API-key assertion. The remaining 40 invariant cases passed.
- `npm.cmd run check:docs`, `check:architecture`, `check:tests`, and
  `git diff --check` passed after the implementation and report updates.
