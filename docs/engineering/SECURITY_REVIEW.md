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

An earlier supply-chain snapshot on 2026-10-24 reported zero vulnerabilities
from local npm audit and no open GitHub Dependabot alerts (19 historical alerts
were marked fixed). A later audit refresh in this session could not reach the
npm advisory endpoint; treat the earlier result as a point-in-time snapshot,
not current verification. A fresh online audit attempt on 2026-10-24 again
failed because the advisory endpoint was unreachable. The offline audit found
zero vulnerabilities using local cache only; that result is not current
verification. No package or lockfile changes were made. This does not cover
non-NPM assets.

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
session resume. Agent task attachment, restart recovery, and automatic
continuity checkpoints now recheck the Agent filesystem path policy before
reading or persisting repository state. A call-site audit found the MCP
`claim` action was missing a check even though `claimHandoff` internally
evaluates repository-backed readiness. The action now checks the persisted
checkpoint workspace before calling the store, even when the caller also
supplies an allowed workspace path. The remaining production
callers are service-internal and their HTTP/MCP/session/Agent entry paths
perform the corresponding source policy check. Tests may call the database
store directly for isolated fixtures; that API is not exposed to network
clients.

### Retrieved context trust-label hardening (2026-10-24)

Model-facing context projection previously copied an arbitrary
`provenance.trust` value into a `Trust:` label. This was a trust-confusion risk,
not a demonstrated authorization bypass: the dispatcher independently checks
the current principal, permission, policy, and approval before tool execution.
The projection now omits trust metadata and uniformly presents retrieved
summaries and content inside the caller's untrusted-context boundary. Evidence
and audit manifests retain their provenance outside this model-facing label.

Validation: `test/evidence-projector.test.js` supplies synthetic provenance
claiming `SYSTEM-TRUSTED` and verifies that neither the trust label nor its
value reaches the projection. This does not prove models cannot be influenced
by malicious content; prompt-injection resistance remains an open platform
risk and must continue to rely on independently enforced execution authority.

### Scheduled watch authority and recovery (2026-10-24, SK-034)

Timer-driven watch checks previously dispatched their configured action without
the initiating principal context. The canonical dispatcher denied privileged
actions without identity, so this was a fail-closed unattended-functionality
gap rather than a demonstrated privilege escalation. Watch creation now signs
the principal and immutable watch/action definition with the scheduled
authority key. Every timer tick verifies that signature, revalidates current
principal and credential state, checks the current action permission, and
rechecks a signed Agent authority envelope when present. The action receives
only this current, narrowed context. Invalid or changed authority pauses the
watch and records a denial; it does not run an identityless fallback.

Existing watch records without a signed principal are intentionally paused at
their next timer check and must be recreated by an authenticated operator.
Validation: `test/security-scheduled-watch-authority.test.js` covers modified
definitions, disabled principals, revoked credentials, permission revocation,
current credential-scope narrowing, and denied Agent envelopes.
`test/security-watch-endpoint-egress.test.js` proves the scheduler stops before
checking or dispatching when authority is absent and passes current identity
and Agent scope to an authorized action. No production watch store was read or
migrated.

### Browser E2E runtime propagation (2026-10-24, SK-036)

The authoritative suite runner intentionally scrubs ambient environment from
child processes. Its browser resource provisioner previously forwarded only the
disposable browser profile root, not the separately installed Chromium runtime.
As a result, the required real-browser suite could exit successfully without
running its E2E scenarios when its browser binary was not visible. The runner
now forwards only the absolute, configured browser runtime path (or the normal
repository-managed runtime when present), while preserving the separate
per-suite browser profile and credential scrubbing. Missing runtime now emits
the runner skip code, which fails this required suite; an explicitly configured
but unavailable runtime fails directly.

### Agent follow-up authority preservation (2026-10-24, SK-037)

The follow-up route creates a distinct governed child task and carries forward
the parent's authority envelope while decrementing its child depth and count.
The current implementation also intersects that inherited envelope with the
current authenticated principal's effective permissions when the durable child
is created. Review did not find an authority-expansion path in this route. The
follow-up API regression now creates a deliberately read-only parent, rejects a
caller-supplied replacement envelope, and verifies the resulting child remains
read-only with change, external, and production effects disabled. This verifies
the persisted child projection and route input boundary; it does not prove every
Agent dispatch path or recovery path is covered by this single test.

### Fractional Agent quota limits (2026-10-24, SK-038)

Confirmed quota-enforcement defect: authority-envelope child depth, child count,
and work-package concurrency were clamped to numeric ranges but not to integer
counts. An authenticated caller could request a fractional child count such as
`1.9`; atomic reservation compared integer usage against the fraction and
admitted two reservations. The durable work-package lease check similarly
admitted a second active package under a `1.9` concurrency limit. This exceeded
the stated task quotas by one; it did not expand the permitted effect classes
or project/resource scopes. Envelope creation now floors count limits, and the
SQLite reservation/lease boundaries independently floor persisted values.
Agent and approval-resume concurrency consumers use integer limits as well.
Regression coverage proves the pre-fix normalizer retained `1.9`, then verifies
normalization and direct enforcement against deliberately fractional persisted
records. No production task records were read or changed.

### Agent task-control route ownership boundary (2026-10-24)

A route audit initially flagged `pause` and `cancel` because their handlers do not
repeat an inline owner check. The shared `enforceTaskRouteAccess` middleware is
mounted on both `/api/agent/tasks/:taskId` and `/api/agent/run/:taskId` before
route dispatch, checks the durable task owner and current project access, and
returns a uniform not-found response for unauthorized principals. An
integration regression now waits for an authenticated task to be running,
then verifies a second principal cannot pause or cancel it and that its durable
state remains unchanged. This confirms the shared enforcement boundary for
these current routes; new task-id routes must remain under the middleware mounts.
No control-route authorization bypass was confirmed.

### Scheduled command identity, authority, and crontab ownership (2026-10-24, SK-039)

The OS cron launcher dispatched `cron run` with only the literal actor label
`cron-runner`; it carried no authenticated principal. The canonical dispatcher
now requires a principal for this high-risk tool, so unattended runs were
rejected before reaching the handler. At the same time, the cron record held a
raw command without a signed binding to its creator or current critical-command
scope. The existing crontab reconciliation also replaced the account's entire
crontab and used `crontab -r` when no Sidekick jobs remained, which could erase
unrelated operator jobs. Cron's subprocess environment did not inherit the
systemd service's database, secret-file locator, or source-policy settings.

New cron jobs now carry an HMAC-signed creator identity and a binding to the
job ID, platform execution ID, name, schedule, and command digest. Creation and
execution both require current `tools.execute_critical` authority; execution
revalidates the principal and credential, intersects current credential
scopes, and reevaluates any captured Agent envelope. Agent commands requiring
an approval that cannot be obtained during unattended execution are refused.
Legacy unsigned jobs remain dormant until an authenticated principal
explicitly invokes `cron action="authorize"`. The runner verifies the signed
context before canonical dispatch and retains the initiating source policy.
Crontab reconciliation now replaces only lines marked as Sidekick-owned,
preserves unrelated entries, and passes only an allowlisted set of non-secret
runtime paths and policy settings to the runner. Values containing NUL or line
break characters are omitted so they cannot create additional cron records.

Validation: `test/scheduled-authority.test.js` verifies the signature binds
command and schedule; `test/scheduler-platform.test.js` verifies the OS runner
reaches dispatch with signed identity, rejects legacy unsigned records, permits
explicit authorization, rejects reduced critical scope, and preserves
unrelated crontab entries. A Linux WSL run now proves a scheduled command
executes successfully through Bubblewrap. During the first WSL integration run,
test mode wrote three synthetic Sidekick entries to the WSL user's crontab.
Inspection showed only those three entries; they were removed by their exact
Sidekick markers, and a subsequent read confirmed no entries remained. Test
mode now skips OS crontab writes. No production crontab or job was accessed.

### Inbound MCP, Compute, and execution-node identity boundary review (2026-10-24)

Reviewed the inbound bearer-authentication path, MCP session creation and reuse,
identity replacement at the MCP handler boundary, Compute worker/enrollment
routes, scoped Compute administration routes, and execution-node administration
routes. MCP requests use the authenticated session provider's principal rather
than transport-supplied identity, and session reuse is bound to the established
principal. Worker and enrollment routes apply their local token or one-time
enrollment checks; administration routes require their scoped credentials.

No identity-spoofing or route-bypass defect was confirmed in the reviewed paths.
This is a source review with targeted regression evidence, not proof that every
Dashboard, CLI, Agent Bridge, or future route shares the same enforcement. New
routes and changes to authentication middleware must be checked against these
boundaries.

### Dashboard memory, handoff, and Agent Bridge read-boundary review (2026-10-24)

Reviewed the Dashboard project, memory, handoff, memory-evidence, and Agent
Bridge proxy routes. These project-backed reads require an authenticated
principal and reevaluate current project membership; handoff ownership does not
survive project-access revocation. Memory evidence checks both the memory's
project and any linked handoff project. The Agent Bridge relay signs each
proxied request with the Dashboard-authenticated principal and current scope
context, leaving task ownership enforcement to the Agent service.

No cross-project read or identity propagation bypass was confirmed in the
reviewed routes. Targeted integration regressions cover revoked project grants,
linked memory/handoff scope, unauthenticated memory access, Agent proxy scope
propagation, and resource concealment. This review does not cover every
Dashboard endpoint or every Agent Bridge operation.

### Dashboard session, CSRF, and proxy-trust boundary review (2026-10-24)

Reviewed Dashboard session issuance, mutation Origin and Fetch Metadata checks,
trusted reverse-proxy parsing, and bootstrap exposure. Mutations reject an
Origin whose exact host or effective scheme differs from the request; an
originless request with an authenticated session cookie is rejected, and
originless requests marked cross-site are rejected. Successful HTTPS Basic
authentication establishes a revocable server-side identity session and sets a
Secure, HttpOnly, SameSite=Lax cookie. Proxy trust is disabled by default; the
legacy `true` setting trusts loopback only, while remote proxy addresses must be
listed as explicit IPs or CIDRs. Network-facing bootstrap requires an
out-of-band token.

No CSRF or forwarded-header trust bypass was confirmed in the reviewed paths.
Legacy Basic-auth API clients without a session cookie retain compatibility
when they omit browser Origin/Fetch Metadata headers; this behavior remains a
known compatibility boundary and should be reconsidered if browser clients
continue to rely on Basic auth directly.

### Generic credential response caching (2026-10-24, SK-040)

The generic Dashboard credential creation and rotation routes returned newly
minted bearer tokens in JSON without an explicit no-store response policy. The
parallel managed service-credential flow already marked its token response
`Cache-Control: no-store`, but the generic endpoints did not. A browser cache or
intermediary retaining either response could extend exposure beyond the
intended one-time display.

Both generic credential issuance paths now set `Cache-Control: no-store` and
`Pragma: no-cache` before returning token material. Existing ownership,
scope-attenuation, and revocation checks are unchanged. Regressions assert both
headers on successful create and rotation responses, assert rotation invalidates
the previous credential, and retain negative tests for cross-principal and
out-of-scope credential operations.

### Core API response caching (2026-10-24, SK-041)

A source sweep after SK-040 found that the Core HTTP app did not establish a
response cache policy. This included MCP tool results, Compute enrollment
credentials, and worker protocol responses. Added a Core-wide `Cache-Control:
no-store` and `Pragma: no-cache` policy. MCP transport header forwarding now
prevents the SDK response from overriding that policy. The legacy MCP SSE
transport sets `no-cache, no-transform` itself; its streaming response cannot
be changed after headers are sent, so it retains the SDK's no-cache behavior.

Live integration regressions verify no-store on Streamable HTTP MCP
initialization and tool-call responses and on Compute enrollment token
issuance. No functional changes to request authentication, credential scope,
or tool dispatch were made.

### Agent Bridge response caching (2026-10-24, SK-042)

The separate Agent Bridge HTTP process served authenticated task projections,
transcripts, artifacts, and operation results without an explicit cache policy.
Added `Cache-Control: no-store` and `Pragma: no-cache` to its HTTP responses.
The task SSE route intentionally sets `no-cache` for streaming behavior; dashboard
proxy responses preserve the Agent response headers.

The live Agent Bridge regression asserts no-store on a task-creation response
and reruns project membership, task ownership, pause/cancel, delegation,
recovery, lineage, and SSE boundary checks. No authorization behavior changed.

### Executable packs and declarative workflows (2026-10-24, SK-043)

Reviewed pack installation, module entry resolution, activation and restore,
first-party provenance, workflow enablement, and workflow tool dispatch.
Third-party executable module entries fail closed before package code is
required or descriptor builders are called. Integrity hashes and package
provenance do not substitute for isolation. No supported OS isolation backend
is currently present, so third-party executable modules remain unavailable.
Bundled first-party modules are a documented trusted in-process exception and
share Core's privileges; they are not sandboxed.

Pack workflows are declarative definitions, installed disabled and only made
runnable when their pack is explicitly enabled. Each step is routed through the
canonical dispatcher using the current execution identity, permission,
project, policy, and approval context. Workflow tests verify that a misleading
`read_only` label cannot authorize mutation, nested workflows retain parent
authority, and resume options cannot manufacture identity. No executable-pack
isolation bypass or workflow authority bypass was confirmed in the reviewed
paths. This does not establish that untrusted executable packs are contained;
they are blocked from execution until OS-enforced isolation exists.

### Generated workflow cancellation propagation (2026-10-24, SK-044)

Generated capabilities are declarative sequences of tool calls, rather than
generated JavaScript. Each step is dispatched again through the canonical tool
dispatcher, where the current identity, permission, policy, and approval are
checked. Review found that the outer dispatch cancellation signal was not
forwarded to this nested dispatcher. As a result, a generated workflow could
continue starting later steps after the parent request had timed out or been
cancelled.

The generated-tool handler now forwards its signal to each nested dispatch and
checks cancellation both before and after each step. A cancellation after a
step completes leaves that completed step recorded, marks the parent workflow
cancelled, and prevents any subsequent step from starting. This cannot stop an
individual underlying handler that ignores its own cancellation signal; such
operations may still complete, and the dispatcher reports timeout semantics
accordingly. This change does not weaken authorization or add a generated-code
execution path.

`test/evolve.test.js` verifies signal propagation through canonical dispatch,
that a cancelled generated workflow does not start its next step, and that its
terminal state is persisted. The focused suite passed on 2026-10-24. Residual
limitation: cancellation is cooperative at the individual tool boundary, so
non-cooperative in-flight operations still require idempotency and state
verification before a retry.

### Generated capability approval attribution (2026-10-24, SK-045)

The Evolve approval action was authorization-gated, but it accepted an
`approver` string from its arguments and persisted that value as the approver
and lifecycle-history actor. An authenticated caller could therefore record a
misleading identity in the capability itself. The dispatcher audit remained
attributable, but the capability record did not reliably identify the actual
principal.

Approval attribution now comes from the authenticated principal in the
canonical execution context. The approval fails closed if that principal is
missing, and the caller-supplied `approver` field is no longer part of the tool
schema or documentation. Dashboard and MCP approvals use the same principal
source. A regression submits a spoofed approver label and verifies that the
persisted approver matches the authenticated owner principal instead.

This closes caller-controlled attribution for this lifecycle action. It does
not mean all audit storage is independently tamper-resistant against a host or
database administrator; that remains a deployment-level residual risk.

### Knowledge promotion attribution boundary (2026-10-24, SK-046)

Reviewed knowledge promotion after the Evolve attribution finding. The
promotion handler already requires dispatcher-approved execution and records
the authenticated principal from the canonical execution context; its
`approver` argument is not used to grant authority or set the recorded
principal. `test/knowledge-promotion.test.js` verifies a forged caller label
cannot authorize promotion, a separate dispatcher approval is required, and
the persisted `approved_by` value matches the authenticated reviewing
principal. No authorization bypass was confirmed. Removed the unused caller
field from the schema and corrected the tools reference and seeded guidance so
the documented contract matches implementation.

### Workflow resume project-scope continuity (2026-10-24, SK-047)

Workflow resume compared projects only when the caller supplied a current
project. A project-bound run resumed without that field proceeded, while its
nested tool dispatch omitted the recorded project. Current identity and
per-tool authorization still applied, but the run did not consistently retain
its original resource scope. Resume now canonicalizes the current project,
rejects a mismatch, and uses the run's recorded project when the caller omits
one. That stored value is scope metadata only: current identity is preserved,
and every resumed step still goes through the canonical dispatcher for fresh
authorization, policy, and approval checks. Invalid recorded project values
fail closed. Regression coverage verifies omission retains scope and an
explicit conflicting project is denied before dispatch.

### Dashboard frontend error-log write amplification (2026-10-24, SK-048)

The authenticated `/api/internal/error-log` endpoint appends a durable
diagnostic record per request but had only the broad Dashboard request limit.
An authenticated client could repeatedly submit telemetry and grow the error
log without a route-specific bound. Added in-memory limits of 30 reports per
principal and 120 per client IP per minute. These limits apply only to the
frontend telemetry endpoint; normal error handling and authentication remain
unchanged. The limits reset on process restart and do not replace a bounded log
retention policy, which remains an operational hardening item.
