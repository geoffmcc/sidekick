# Sidekick Security Hardening — Phase 20 Final Evidence

Date: 2026-08-19

## Baseline and scope

- Initial campaign baseline: `cf03f417a2969c552ec7253ab3742b3ca5dfe485`
- Phase 20 branch: `security-phase-20-final-verification-20260819`
- Phase 20 base: `b834551e2ffa0eced3304ff480d2e0cdac7b683e`
- Deployment target: `10.47.20.20`
- Previous deployed commit: `b834551e2ffa0eced3304ff480d2e0cdac7b683e`

Phases 1–19 reviewed execution governance, identity, defaults, subprocesses,
filesystem, secrets, network/web, packs, browser/research/Compute/agent
execution, memory isolation, supply chain, deployment, and CI/CD controls.

## Phase 20 changes

- Added an exported `closeDatabase()` lifecycle helper and used it in native
  SQLite test teardown paths so Windows does not retain temporary databases.
- Made the bash-tool fixture platform-neutral while preserving stdout, stderr,
  exit-code, dangerous-command, and asynchronous execution assertions.
- Replaced POSIX-only `grep`/`/bin/bash` test scans with Node-native scans.
- Made migration, health, security-scan, path-policy, CI-status, tool-family,
  and related SQLite fixture cleanup close database handles first.
- Made the Agent continuation fixture use a platform-neutral absolute path.
- Fixed governed Git argument tokenization so Git ASCII unit separators remain
  inside `--pretty` format arguments; this preserves Developer pack author/date
  history parsing.
- Added final regression coverage for SQLite teardown and Git format arguments.

## Findings and status

The final phase found no new production privilege-boundary bypass. It found
test-environment defects that could hide verification failures:

- PH20-01 — medium — native SQLite handles were not closed by multiple test
  fixtures before recursive cleanup. Fixed in the database lifecycle API and
  affected tests.
- PH20-02 — low — several security tests assumed POSIX shell commands or paths
  while the supported development environment also includes Windows. Fixed by
  using Node-native scans and platform-neutral fixtures.
- PH20-03 — low — Git’s ASCII unit separator was treated as JavaScript
  whitespace by the governed Git argument tokenizer, corrupting structured
  history output. Fixed by splitting only ordinary command whitespace and
  covered by a regression test.

## Verification

Passed focused checks:

- `node test/security-final.test.js`
- `node test/security.test.js`
- `node test/tool-log-redaction.test.js`
- `node test/security-scan.test.js`
- `node test/path-policy.test.cjs`
- `node test/ci-status.test.js`
- `node test/health.test.js`
- `node test/agent-continuation.test.js`
- `node test/platform-event-consumption.test.js`
- `node test/compute-model-dedup.test.js`
- `node test/migration-self-containment.test.js`
- `node test/bash-tool.test.js`
- `git diff --check`

The complete suite was attempted in both environments. The Windows checkout
passed the assertions in the suites reached, but exposed additional
Windows-only shell/native teardown incompatibilities that were corrected. A
native Linux run with `.git` history reached the Developer, approval, and
scheduler suites; all scheduler assertions passed, but the scheduler test
process did not exit, preventing the aggregate runner from completing within
the bounded five-minute run. Therefore the full suite is not claimed green
locally; GitHub CI remains authoritative for the final aggregate result.

## Residual risk and score

Final score: **88/100**.

The deduction reflects inherent and residual risk: Sidekick intentionally
supports governed arbitrary shell execution and infrastructure administration;
third-party modules execute in-process; optional provisioning still downloads
some vendor-latest tools; existing installations require the Phase 18
bootstrap migration to remove old sudo-group membership; and the final local
aggregate suite remains blocked by a scheduler test lifecycle hang.

These are explicit, bounded residuals rather than claims that the platform is
safe merely because scanners pass.

| Category | Score |
| --- | ---: |
| Execution, policy, and approval | 18/20 |
| Authentication and authorization | 17/18 |
| Subprocess and shell security | 10/12 |
| Secrets and redaction | 10/11 |
| Filesystem and persistent data | 9/10 |
| Packs and modules | 7/8 |
| Compute and autonomous execution | 7/8 |
| Network and web security | 7/8 |
| Supply chain and CI | 7/8 |
| Operational security | 6/7 |
| **Total** | **88/100** |

## Next action

Review this final evidence diff, stage the Phase 20 files, and sign the
commit. After the Phase 20 PR is merged, deploy through the governed `ops`
workflow and retain the scheduler test hang as the first post-campaign
follow-up.
