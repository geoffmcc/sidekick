# Improvement backlog

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
| SK-010 | Design weakness P2 resume pointer concurrency | Whole json_documents resume object load/save may lose updates. | Reproduce two-writer loss, then use canonical transaction/update interface. | Source review only. |
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
