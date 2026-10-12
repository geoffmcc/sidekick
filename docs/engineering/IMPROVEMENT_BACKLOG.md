# Improvement backlog

## Current milestone: confirmed findings and disposition

Baseline `d4c908c`; 2026-10-12. All reproductions below use
`node test/run-all.js test/handoff-concurrency.test.js` in disposable Git/SQLite
fixtures. Each named case is in that test file. Final suite: 17 pass; unchanged
baseline: 15 fail, two controls pass. No confirmed P0.

| ID / subsystem / severity | Reproduction and root cause | Remedy, dependencies and compatibility/security risk | Verification |
| --- | --- | --- | --- |
| SK-006 / capture and claims / confirmed P1, stale writer replaces newer state | Concurrent checkpoint, revocation-during-readiness and intervening-lifecycle tests. `captureHandoffCheckpoint` guards packet version only; captures/lifecycle changes do not increment it. `claimHandoff` lacks a current lifecycle guard after repository observation. | Compare row state plus existing journal tip under SQLite writer lock. No migration/dependency. Conflicts require reload/reconciliation. This closes overlapping writes, not arbitrary filesystem races or exclusive ownership. | Fixed; real second-process races fail before and pass after. |
| SK-014 / lifecycle and lease audit / confirmed P1, partial durable mutation reported as failure | Five rejected-journal-insert tests plus process exit before `resume_started`. `transitionHandoff`, `claimHandoff`, `renewHandoffClaim`, `beginHandoffResume`, `releaseHandoff` update row before separately committed event. | Commit row and event together, preserving outer caller transactions. No schema change; failed calls leave prior state. Requires working SQLite journal. | Fixed; rollback, safe retry, abrupt process exit, and outer-transaction controls pass. |
| SK-015 / terminal lifecycle / confirmed P1, closed continuity becomes resumable | Three retained-claim-token tests. `releaseHandoff` checks token/expiry but bypasses the transition matrix. | Enforce release transition legality. Revoked/completed/superseded records remain terminal. Intentional compatibility tightening; no new permission or approval. No external exploitability claim. | Fixed for all three terminal states. |
| SK-016 / receiver preflight / confirmed P1, resume based on invalidated observation | Packet-change and lease-expiry-during-preflight tests. `beginHandoffResume` does not compare packet revision or check expiry again after slow checks. | Guard observed state and current expiry inside commit. Token/schema preserved. Long-running preflight may correctly require renewal/reconciliation. | Fixed; competing packet writer and controlled clock boundary pass. |
| SK-017 / audit persistence / confirmed P2 defensive failure handling | Silently-ignored-journal-write test. `appendHandoffEvent` ignores insert result; an injected SQLite trigger suppresses insertion without an error. | Use ordinary INSERT and require one inserted row; caller transaction rolls back on suppression. Normal event shape unchanged. Fault injection, not an externally reachable SQL exploit. | Fixed; suppressed event prevents checkpoint commit. |
| SK-010 / resume pointer storage / confirmed P2 lost update | Two subprocesses both read the same `json_documents('resume')` value, then set pointers for distinct projects; the final document loses one pointer. Root cause: `resume.js` mutates a stale in-memory whole-document snapshot and upserts it without a transaction. | Read/merge/write the existing document under an immediate SQLite transaction; preserve project entries and schema, no migration/dependency. Writers serialize; cross-process lock contention remains subject to SQLite's configured busy timeout. | Fixed; deterministic barrier reproduction fails before and both pointers persist after. |
| SK-020 / handoff project isolation / confirmed P1 scope leak | Canonical MCP `handoff list` with trusted execution project `continuity`, omitted argument project, and a valid operator principal returned that principal's `other_project` handoff too. Root cause: the handler required a bound or argument project but passed the omitted argument to an unfiltered list query. | Inherit the trusted bound project when omitted and reject explicit mismatches for all handoff actions. No schema/dependency change; requests attempting project override now fail closed. | Fixed on `improvement/handoff-project-scope`; MCP regression fails before and passes after. |
| SK-018 / validation / confirmed P2 baseline failures | Frozen required-tier command with 180-second bound: 163 pass, 18 fail, one cancelled, 70 not run. Cleanup errors, shell/helper startup issues, compute timeout and research assertions precede these changes. | Triage isolated fixtures; close owned resources where demonstrated; verify behavioral failures on supported platforms. Do not weaken assertions or relabel failures. | Open; aggregate and suite identities in CONTINUITY_VALIDATION_EVIDENCE.json. |
| SK-019 / wider store atomicity / design weakness P2 | Source review: packet create/update, extraction, restore/archive and metadata-only touches have different transaction boundaries. No general atomicity guarantee established. | Reproduce each boundary before extending the transaction pattern. Preserve deduplication/history semantics; no blanket refactor. | Open; source concern, not a newly confirmed defect. |

SK-007, SK-008, SK-011 and SK-012 remain open. SK-009 now includes deterministic competing
writers, checkpoint/begin-resume process-exit coverage, and a fresh-process API
contract test that discovers a checkpoint from project identity, continues a
fixed safe repository fixture, and recaptures/verifies the changed state. It
still lacks actual unfinished-task completion by an independent Agent Bridge
agent and the full A-G matrix.
SK-010 is fixed on signed, pushed `improvement/resume-pointer-atomicity`.
SK-020 is fixed on `improvement/handoff-project-scope`; that branch is stacked
on the resume-pointer branch and is awaiting signature/push.
SK-013 has new bounded aggregate evidence; full required-tier success and general
Windows termination behavior remain unverified. Historical records below
describe the preceding v2.2.1 milestone.

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

Priorities describe engineering impact, not CVSS. No P0 is confirmed. Each record distinguishes demonstrated behavior from a concern.

| ID | Classification / priority | Reproduction, root cause and code | Remedy, dependencies and risk | Verification |
| --- | --- | --- | --- | --- |
| SK-001 | Confirmed P1 checkpoint integrity | Reject checkpoint_captured inserts with SQLite trigger; capture throws but memory_handoffs.checkpoint_json remains. db/handoff-store.js captureHandoffCheckpoint updates before separately committed appendHandoffEvent. | One SQLite transaction for row and event. Existing DB only; no migration. Test failed insert leaves no checkpoint and retry succeeds. | Regression reproduced; fix pending validation. |
| SK-002 | Confirmed P1 stale evidence | Refresh evidence, advance clock eight days, preflight stays ready; future observed_at also accepted due to Math.max(0, age). evidenceFreshness, refreshHandoffEvidence, receiver projection. | Re-evaluate time on every read, retain invalid persisted results, reject future dates. Never upgrade cached stale/unknown without refresh. Clock skew becomes visible. | Both regressions reproduced. |
| SK-003 | Confirmed P1 project continuity | Store resume pointer to another project's valid handoff. check returns valid; completed foreign handoff clears pointer. resume.js validateResumeItem and syncCompletedLinkedHandoffs. | Fail validation after project comparison; require matching project before completion sync. No schema change; malformed legacy links now block. | Both regressions reproduced. |
| SK-004 | Confirmed P1 workspace drift | Edit already modified tracked file or already untracked file after checkpoint; porcelain unchanged and readiness ready. handoff-store.js gitCheckpoint/checkpointDrift. | Content-sensitive bounded checkpoint; unknown/incomplete observations block. Preserve old records but require recapture where proof is absent. No raw diff persistence. | Both regressions reproduced. |
| SK-005 | Confirmed P2 Windows test cleanup | Run security-handlebars-template.test.js: 19 assertions pass, after hook EPERM on open DB. | Close owned DB before scoped removal. Do not alter assertions. | Baseline reproduced. |
| SK-006 | Design weakness P1 concurrent captures | expectedVersion guards packet version, not competing checkpoint captures; multiple Git calls may see mixed state. | Design capture revision/CAS and race detection; multi-process tests. Depends on checkpoint contract. Migration risk to evaluate. | Source review only. |
| SK-007 | Design weakness P1 evidence provenance | Timestamp plus passed metadata can count as fresh without independently attributable test receipt. | Define evidence classes and server-verifiable provenance; preserve legacy data as reported. | Not a completed exploit/behavior evaluation. |
| SK-008 | Missing tests P1 authorization matrix | Enumerate canonical aliases/interfaces, owners and project bindings including resume list. | Isolated principals and cross-project tests before authorization changes. | Outstanding. |
| SK-009 | Missing tests P1 full cross-agent campaign | Existing receiver projection test is not Agent A/B actual unfinished-task execution. | Harness scenarios A-G, crashes, competing sessions, security and context budgets. No paid model invocation without approval. | Partial deterministic receiver control only. |
| SK-010 | Confirmed defect P2 resume pointer concurrency | Deterministic barrier test forces two child processes to read the same resume document before setting different project pointers; old load/modify/upsert loses one update. | Use a short `BEGIN IMMEDIATE` transaction to read latest state, merge the targeted project, and persist through existing json_documents store. No schema change; writers serialize subject to SQLite busy timeout. | Fixed and validated on this branch. |
| SK-011 | Missing evaluation P2 remaining subsystems | Memory recall/staleness, scheduler DST/retries, worker disappearance, pack rollback, API diagnosis, backup restoration. | Isolated failure tests by subsystem; reuse current stores. | Inventory exists; deeper audit outstanding. |
| SK-012 | Validation gap P2 supply chain/deployment | Local lock versions examined; current advisory data and actual deployed configuration not accessed. | Approved dependency advisory check and non-production release rehearsal. | Not verified. |

Next milestone: finish focused continuity fixes and validation, then concurrent checkpoint ownership and attributable evidence; do not begin a broad rewrite.


## Milestone disposition

- SK-001: fixed in ba17ee5; failure rolls back both stores and subsequent retry writes one event.
- SK-002: fixed in ba17ee5 for aging, future timestamps and partial cached evidence. Invalid cached results stay invalid. This is not proof of external evidence truth.
- SK-003: fixed in ba17ee5 for mismatched stored project links and completion synchronization. Broader authorization remains SK-008.
- SK-004: fixed in ba17ee5 for tracked staged/unstaged contents. Untracked/submodule/oversized observations block; ignored files are outside the contract. Legacy dirty records require recapture.
- SK-005: fixed in 7d47816 for template and dispatcher tests; both pass without weakened assertions.
- SK-006 through SK-012 remain open.
- SK-013 (validation blocker, P2): broad Windows required-tier run did not yield a final result after its timeout. Reproduce runner termination in an isolated test; validate in Linux CI before making product-runtime claims. No passing full-suite result.

The final test file has 12 cases; 10 fail against untouched baseline, 12 pass after fixes. No P0 or externally exploitable vulnerability has been demonstrated. No public disclosure was made.
