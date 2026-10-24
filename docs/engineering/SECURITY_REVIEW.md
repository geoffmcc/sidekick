# Security review

## Current milestone (d4c908c baseline)

Confirmed P1 continuity-integrity defects: a stale claim acquisition could undo
revocation, and a still-valid claim token could release a revoked, completed or
superseded record into a resumable lifecycle. A packet change or lease expiry
during preflight could also go unchecked at begin-resume commit. These findings
use disposable local fixtures only; no external exploitability or authorization
bypass across production interfaces is claimed.

Fixes preserve the transition matrix, compare current continuity state at commit,
check expiry again, and commit audit events atomically. The regression suite
tests all three terminal states plus real second-process mutations. Raw claim
tokens are not persisted by the fix. The crash fixture sends its synthetic token
over stdin. Existing dispatcher, project isolation, memory-data security, and
all 19 template-security tests pass in the final focused run. No dependency or
policy changes were made in that milestone. The later 2026-10-24 advisory
review is recorded below.

The bounded unchanged-code broad run also contains failed security suites:
some report Windows cleanup errors, while security-research-pack reports
behavioral assertion failures as well. These are recorded as failures, not
waived or converted to passing results. See VALIDATION_RESULTS.md.

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

Private local review; no live targets, external accounts, network vulnerability probes or real secrets used. This is not a completed penetration test or current advisory audit.

The v2.2.1 Handlebars patch is present, with locked and installed 4.7.10 and string-only bounded template handling. All 19 behavioral assertions passed locally at baseline, but the suite failed in its cleanup hook because its SQLite handle remained open on Windows. Preserve the assertions and close the owned DB before removal.

Project mismatch in stored resume links is a confirmed fail-open validation defect (SK-003). A malformed or stale pointer can report valid despite differing projects, and cross-project completed handoffs can hide pending work. Reproduction uses synthetic data only; external exploitability and broader resume authorization are not established.

Stale/future evidence (SK-002) and undetected workspace changes (SK-004) can mislead a receiving agent. These checks must fail closed and must never imply current approvals. Secret redaction, scope authorization, dispatcher schema/policy and execution receipts remain required.

Remaining review: identity/ownership matrix across MCP, Dashboard, Agent and resume; handoff path authorization and Git helper execution; symlink/SSRF redirects; pack code privilege boundaries; retrieval injection; redaction by sensitive key; claim token exposure; CI/dependency advisories. No dependency changes or new external services are introduced in this milestone.

Confirmed P1 project-scope leak (SK-020): through canonical MCP dispatch, a
valid operator bound to one project could list its own handoff from another
project when omitting the optional `project` argument. The source trusted the
bound project only for the missing-scope check, then queried an unfiltered list
and relied on principal ownership filtering. A focused two-project fixture
reproduced the behavior; the handler now inherits the bound project and rejects
explicit mismatches. No live data was involved. The signed fix is pushed on
`improvement/handoff-project-scope`. The broader
MCP/Agent/Dashboard/resume authorization matrix remains open; do not infer that
all interfaces now have equivalent scoping.

Confirmed P1 resume project-scope gap (SK-022): canonical MCP dispatch supplied
a trusted project, but the resume handler ignored that execution context.
Authenticated `resume list` returned pointers from other projects, `resume set`
accepted an explicit foreign project, and a scoped read could synchronize a
completed foreign pointer. Synthetic two-project/operator fixtures reproduced
all three. The handler now binds/validates scope and filters both list and
read-triggered synchronization. The wider interface authorization matrix
remains open; no broad authorization claim follows from these cases.

Confirmed P2 destructive-audit integrity gap (SK-023): purging historical
handoff content previously committed the version/link deletion before writing
its audit event. A rejected insert left content removed with no audit; a
silently ignored insert could go undetected. The purge now verifies the audit
row and commits it with deletion in one SQLite transaction. Trigger-based
regressions cover both cases; no production data was involved.

Confirmed P2 lifecycle-audit integrity gap (SK-024): archive, unarchive, and
restore could change durable state before their audit writes. SQLite trigger
fixtures reproduced all three; the operations now commit the state change and
verified audit row together. These are local integrity failure cases, not
evidence of an external attacker or production exploit.


## Fix and validation status

SK-001 through SK-004 are fixed for the demonstrated cases. The final 12-case continuity suite passes; all 19 template security assertions and cleanup pass. Dispatcher behavior and cleanup pass after explicitly closing its owned database. Project context, project identity and memory data-isolation regressions pass. This does not close the untested authorization, injection, supply-chain or live-configuration items above.

### Dashboard memory-evidence project scope (2026-10-24)

Confirmed authorization defect: `GET /api/memories/:id/evidence` used the
linked handoff's access check instead of also checking the memory's own project.
A persisted memory in project B that referenced a readable handoff in project A
could therefore disclose its contents to a principal authorized only for A.
A synthetic direct-route regression reproduced the leak (HTTP 200) before the
fix. The route now requires read access to the memory project, requires access
to any linked handoff, and rejects mismatched memory/handoff project scopes.
Same-project linked reads remain allowed. The memory and handoff are test
fixtures; review found no public import path that accepts a caller-supplied
`source_ref` (imports set it to null and trusted extraction creates same-project
links), so exploitability depends on malformed or otherwise inconsistent
persisted state. This is a verified authorization logic flaw under that
precondition, not evidence of an ordinary-user route to create the state.

Focused validation after the fix: `test/security-project-access.test.js` and
`test/security-dashboard-direct-routes.test.js` passed (2 suites, 0 failures).
The broader authorization matrix and live deployment behavior remain open.

Supply-chain advisory status was checked on 2026-10-24: local npm audit found
zero vulnerabilities in the lockfile, and GitHub Dependabot reported no open
alerts (19 historical alerts were marked fixed). This does not replace ongoing
CI checks or cover non-NPM assets.
