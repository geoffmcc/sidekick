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

Remaining review: complete identity/ownership matrix across MCP, Dashboard,
Agent and resume; handoff path authorization and Git helper execution; browser
and downloader redirect/egress behavior; pack code privilege boundaries; and
retrieval injection resistance. Structured memory, legacy context, handoff,
journal, and memory-audit redaction now have focused synthetic coverage for
known credential patterns and sensitive field names; arbitrary secrets in
ordinary values and unmodified historical database contents remain residual
risks. The MCP claim-token boundary now has an integration regression proving
the authenticated caller receives the one-time bearer token while tool logs
and identityless retries do not. CI and dependency state remain subject to
continuous verification.

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

### Dashboard memory-evidence project scope (2026-10-24, SK-025)

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

### Handoff-linked memory scope (2026-10-24, SK-026)

Confirmed scope disclosure in the Dashboard handoff detail route: its memory
query uses the database's compatibility semantics `(project = ? OR project IS
NULL)`, then selects rows whose `source_ref` or `metadata.handoff_id` matches
the handoff. A project-only reader could therefore receive an unscoped memory
when inconsistent persisted state linked it to that project handoff. The
synthetic regression failed before remediation because the global memory was
included. Dashboard and canonical MCP handoff inspection now additionally
require exact equality of memory and handoff project scopes, preserving
same-project linked results and excluding global or foreign-scope rows. The
condition is malformed/inconsistent persisted linkage; no public writer that
accepts a caller-supplied `source_ref` was identified. This is verified under
that precondition, not proof of an ordinary user route to create it.

Focused validation: `test/security-project-access.test.js` and
`test/security-dashboard-direct-routes.test.js` pass (2 suites, 0 failures).

### Handoff packet credential redaction (2026-10-24, SK-027)

Confirmed persistence leak: handoff packet sanitization recursively applied
pattern-only text redaction, so arbitrary values under credential-named fields
such as `api_key`, `token`, and `password` survived in the current packet,
version history, and first-class evidence/artifact links. Synthetic values
reproduced this across those storage representations. Packet persistence now
uses the shared key-aware recursive redactor, replacing values under sensitive
field names while preserving surrounding handoff content. This applies to new
packet writes and versions. Existing deployed database rows were not inspected
or rewritten; any historical sensitive values remain an unverified residual
risk requiring a separately backed-up, operator-approved remediation plan.

Validation: the packet regression and `test/handoff-reliability.test.js` pass;
the regression confirms synthetic values are absent from current rows, version
history, and linked payloads. No production database was accessed.

### Handoff text persistence (2026-10-24, SK-028)

Confirmed secret persistence gap: the current `memory_handoffs.content` and
`title` columns retained credential-shaped text even when the separate
`redacted_content` field had removed it. Version snapshots also copied raw
content. A synthetic test reproduced this for JSON `password` values and
`api_key`/`token` assignments. New saves now persist the redacted content,
title, and source; an explicitly updated legacy row is snapshotted only after
redacting its content, title, source, and packet. The versioning test now
asserts credential values are absent from persistent text columns.

This is write-time enforcement, not a bulk database migration. Existing
untouched rows and their prior history may still contain sensitive text; no
production database was inspected or changed. Review and remediation of
historical deployments requires a separate backup and approved operation.

Validation: `test/security-project-access.test.js`,
`test/handoff-versioning.test.js`, `test/handoff-reliability.test.js`, and
`test/security-phase-07-secrets-redaction.test.js` passed (4 suites, 0 failures).

### Handoff journal field redaction (2026-10-24, SK-029)

Confirmed that checkpoint metadata, lifecycle reasons, actor labels, and source
labels could be persisted in `memory_handoff_events` without passing through
the shared redactor. Since handoff events are returned by the events API, this
was a persistent disclosure path. The common journal writer now recursively
redacts structured payloads and pattern-redacts actor/source strings before
computing the event hash and inserting the row. The integrity chain therefore
covers the exact sanitized representation that is persisted and returned.

Validation: `test/handoff-reliability.test.js` checks synthetic sensitive
values are absent from both stored rows and API results and that the sanitized
journal chain verifies. This does not retroactively sanitize existing event
rows; historical database contents remain an unverified residual risk.

### Memory audit detail redaction (2026-10-24, SK-030)

The shared memory audit writer persisted arbitrary structured details and actor
labels unchanged. Memory management and handoff operations can carry
caller-provided reasons, so credential-shaped values could enter audit rows.
The writer now applies recursive key-aware redaction to details and pattern
redaction to actor labels before persistence. Handoff atomic-audit validation
compares the persisted sanitized representation, so failed or altered audit
writes still roll back their associated mutation.

Validation: `test/handoff-reliability.test.js` checks synthetic credentials are
absent from stored audit rows; its atomic archive, restore, purge, session, and
handoff tests also exercise audit transaction behavior. Historical audit rows
were not migrated or inspected.

### Persistent memory field redaction (2026-10-24, SK-031)

Confirmed that direct structured-memory writes and import/sync admission paths
could persist credential-shaped strings in memory metadata, summaries,
evidence excerpts, source references, and lifecycle reasons. The shared memory
write/admission boundary now pattern-redacts textual fields and recursively
redacts metadata and tags before persistent writes; supersession and delete/
expire reasons are also sanitized. This is pattern/key-aware protection and
cannot detect a secret supplied as an ordinary-looking value under an ordinary
field name. Normalized memory reads also redact known sensitive patterns and
keyed values from legacy rows without rewriting them. Existing database rows
were not inspected or migrated.

Validation: `test/security-memory-authority.test.js` uses synthetic markers to
verify direct writes and imported records do not retain known credential
shapes. The authoritative runner also passed automatic-memory, memory-sync,
handoff reliability, project-access, and phase-7 secret-redaction suites
(6 suites, 0 failures); a legacy-row projection check confirms read-time
redaction while leaving its synthetic raw fixture unchanged in SQLite. No live
database or service was used.

### Legacy context document persistence (2026-10-24, SK-032)

Confirmed that the legacy context tool could persist caller-provided decision,
problem, pattern, and session text without consistent key-aware redaction; some
of these objects are also passed to the embedding store. Context document reads
and writes now use the shared recursive redactor, and decision/problem/pattern/
session objects are sanitized before any embedding call. Legacy non-memory
Qdrant payloads are also redacted before context recall, preventing known
credential patterns and sensitive-key values from being returned through the
vector path. Normalized reads redact known credential patterns in historical
context rows without rewriting those rows. This remains pattern/key-based
detection and cannot identify an ordinary-looking generic secret value.

Validation: the memory-authority regression writes a synthetic credential to a
new context document and a legacy fixture, verifies sanitized reads, and
confirms the legacy raw row remains untouched. A mocked vector search regression
also verifies legacy payload redaction before recall. `test/context-engine.test.js`,
`test/security-memory-authority.test.js`, and `test/security-project-access.test.js`
passed (3 suites, 0 failures); no live vector store was used.

### Handoff repository path-policy enforcement (2026-10-24, SK-033)

Confirmed that handoff provenance verification and repository checkpoint,
readiness, and preflight operations could invoke Git against a caller-supplied
or persisted `working_directory` without first applying the filesystem path
policy. MCP handoff create/update now reject packet repository paths outside
the active MCP path policy, and Git-backed operations recheck the effective
path immediately before use. Dashboard readiness, start-here,
and preflight routes apply the Dashboard path policy before reading checkpoint
or provenance repositories. Out-of-policy paths fail closed with a policy
error; list projections omit repository-backed readiness details and show a
blocked state.

Validation: `test/security-project-access.test.js` passes all 74 assertions.
The regression confirms an out-of-policy handoff path is not persisted, then
dispatches authenticated MCP verification and Dashboard preflight against
synthetic outside paths and confirms both are rejected before repository
evidence is returned.
The canonical session tool also checks an explicit workspace at session begin
and rechecks persisted workspaces before checkpoint, finalization, or partial-
session resume. Direct internal Agent Bridge and database-store call sites
remain under review before this finding can be closed platform-wide.
