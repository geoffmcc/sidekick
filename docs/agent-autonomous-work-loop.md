# Agent tab work model

Interactive MCP requests remain caller-driven and focused. They do not invoke the Agent work loop automatically.

The Agent tab treats a non-trivial objective as bounded durable work:

```text
objective → plan → investigate → governed tool calls → evidence ledger
          → completion gate → replan when incomplete → verify → answer
```

The normal tool loop and Brain path share the same bounded work-state and completion-gate semantics. A successful tool call is evidence, not proof that the whole objective is complete. If material requirements remain, the normal loop continues and Brain obtains another validated plan, subject to iteration, wall-clock, tool, and evidence limits.

Task submission may include a bounded structured `goal_spec` containing
normalized objective text, success criteria, deliverables, verification
requirements, and stopping conditions. These fields are persisted as task
data, not authority. A task that requires live evidence cannot become verified
from a model answer alone.

Agent progress checkpoints contain only bounded task state and evidence references. Tool authority remains in the canonical dispatcher; plans, evidence, context-provider metadata, and Semantic IR cannot grant authority. Approval parks the exact governed action and its existing continuation binding; it does not authorize later steps.

Context Engine results are working evidence, not instructions. Repository and tool output remain untrusted, provenance is retained, and active context is bounded. Older evidence may be referenced without copying all raw output into every model request. A task reports cancellation, approval wait, insufficient evidence, failure, or a resource limit instead of claiming completion when the gate cannot be satisfied.

Repository intelligence is selected from positive capability relevance. Fallback catalog entries are available for planning but do not automatically execute. Automatic context providers are self-provider descriptors and still execute through the normal governed Agent dispatcher. Semantic repository analysis is static and bounded; it uses stable scoped symbol IDs and leaves cross-file names unresolved unless deterministic import/module binding evidence exists.

The implementation does not promise process-restart continuation for every active Agent generation. Approval continuations use the existing durable checkpoint path; active work also records bounded platform checkpoints and claims. When a safe checkpoint and objective are available, the service automatically relaunches the task from that boundary with persisted identity, authority, and budget; a restart without a recoverable task objective is reported as interrupted rather than fabricated as complete.

## Adaptive durable execution

Tasks created after migration 058 carry a versioned authority envelope. The
envelope narrows project, workspace, repository, effect, capability,
environment, child-task, concurrency, rollback, and expiry scope; it cannot
grant permissions absent from authenticated principal or machine scope.
Effective authority is intersected and re-evaluated at dispatch time.
An envelope's environmental scope is checked against the current governed
Sidekick environment at the same decision boundary; a mismatch denies before
dispatch.

The authenticated Dashboard proxy carries the principal, credential scopes,
and delegation reference into the loopback Agent Bridge. Agent execution
performs the current principal authorization check before its local envelope
decision; the canonical dispatcher repeats authorization, policy, schema, risk,
and approval checks immediately before execution.

Canonical descriptor annotations, risk metadata, validated arguments, target
scope, reversibility, idempotency, and external/production sensitivity produce
the deterministic effect classification. Read-only local inspection may
proceed without approval when allowed. Unknown metadata, external effects,
destructive changes, credentials, identity, policy, and production operations
remain approval-gated or denied. Textual action-word heuristics are diagnostic
only and never authorize retries.

Mutating work records a redacted operation receipt with a versioned argument
digest, target and scope references, dispatch/outcome state, expected
postconditions, verification and rollback references, policy, approval, and
principal provenance. Recovery verifies fresh governed state before deciding
whether an operation is complete, safely absent and retryable, or ambiguous.
Ambiguous effects are parked for escalation and never blindly replayed.

On restart, a fenced task with a dispatched but unfinalized mutating receipt is
first checked through a fresh governed read-only recipe. Satisfied
postconditions complete the operation without repetition. Proven absence can
invoke only a persisted non-sensitive retry recipe when the live descriptor is
still authoritative and idempotent, current authority and identity policy
permit the action without new approval, and the canonical dispatcher accepts
the call. A prepared receipt that never reached dispatch remains safe to
resume. Partial or unproven state receives an escalation path; unknown
mutations are never blindly replayed.

A receipt finalized immediately before a process crash is also durable provider
evidence: recovery records the operation in the continuation ledger and does
not dispatch it again. Restart retries reapply persisted, non-secret
credential-scope and delegation constraints; missing context fails closed and
parks the task for escalation.

For Git workspace mutations, the Agent first obtains current status through the
canonical read-only Git capability. That bounded, redacted observation is
stored as the receipt pre-state before the mutation is dispatched. If the
inspection fails, the receipt remains prepared and no workspace mutation is
attempted. This is pre-state custody and scope evidence; it is not a claim
that every external operation is reversible.

Development workspace mutations also create a durable workspace transaction.
It records governed workspace and target references, affected resources, and
redacted pre/post-state evidence alongside the mutation capability and digest.
Rollback is unavailable unless a versioned governed rollback recipe was
explicitly recorded; every rollback request is revalidated against the live
registry, current task authority, and canonical dispatcher. The Agent never
implicitly resets, cleans, stashes, commits, pushes, or modifies `main`.

If that governed status identifies the current branch as `main` or `master`,
the Agent creates or reuses a task-owned branch named from the durable task ID
through the canonical Git capability before dispatching the requested change.
This happens only when the effective envelope permits reversible workspace
changes and the pre-state is clean. Existing worktree changes are evidence to
preserve and cause the task to stop for workspace resolution; they are never
reset, clean, stashed, overwritten, or silently included as task-owned changes.
The branch operation has its own redacted operation receipt and counts against
the root task tool budget.

### Durable planning, verification, and review

Migration 058 stores authority envelopes, usage ledgers, operation receipts,
verification recipes/outcomes, repair attempts, work packages, and learning
candidates. Migration 059 adds versioned hierarchical plans and bounded
escalation packages. Migration 060 adds workspace transaction custody records.
Migration 061 adds bounded retry-recipe references; sensitive or redacted
arguments are refused rather than persisted. Migration 062 adds bounded
principal-context references for restart-time authorization revalidation;
credentials themselves are never persisted. Migration 063 adds durable
escalation decision provenance and approval references. Authenticated task projections
are principal-scoped through the protected Agent Bridge.
Migration 064 adds an explicit bounded `candidate_version` to learning
proposals so replay, review, supersession, and future candidate revisions retain
durable version identity.
Plans are validated for bounded fan-out, depth, and cyclic dependencies; steps
reference the live Agent-source catalog and governed capabilities rather than
executable commands; executable-looking fields are rejected recursively across
milestones, work packages, and verification gates. A recipe is accepted only for a live authoritative
read-only capability and runs through the canonical dispatcher. Its outcome
records freshness, independence, and observation state; structured expectations
and bounded retry policy are honored without turning output text into authority.
Git workspace mutations receive a bounded independent worktree-status recipe
automatically; other mutations require an explicitly governed read-only recipe
when their postcondition cannot be determined from the operation receipt. A
mutating receipt with no such recipe is an explicit unable-to-verify gate; it
cannot be promoted to verified merely because dispatch returned successfully.

When a project-scoped task reaches a terminal state, the durable Agent path
derives bounded candidates for budget estimates, failure classifications, and
verification patterns from the redacted trace. Learning candidates are
redacted, project-scoped proposals. They remain in
`proposal`, `trial`, `rejected`, or `superseded` state until review; promotion
to `active` requires an authenticated human with the existing `approvals.grant`
permission, rejects requester self-approval, and never changes authority or
policy. Historical replay is a separate bounded API operation: it evaluates
the source task's durable redacted trace plus a bounded comparison with recent
same-project terminal traces, records evidence and policy-impact fields, never
executes proposal content, and cannot activate a candidate. The Agent API and Dashboard proxy expose task plans, recipes and
outcomes, escalation packages, work-package leases, and the candidate review
surface. These records are projections of durable storage and are rebuilt on
refresh or restart.

The supported profiles remain finite: `quick`, `standard`, `deep`,
`persistent`, and `research`. Each profile bounds wall time, model/tool calls,
plan revisions, failures, retries, repairs, verification, child tasks, work
packages, idle time, and waiting time. Restart, continuation, and child-task
paths share the root accounting envelope. A child profile may only be equal to
or narrower than its parent. Concurrency is limited to independently scoped
work packages; mutation packages targeting the same governed resource are
serialized by durable leases, and approvals and authority are never inherited
by children.

Cancellation is lineage-aware: cancelling a task records cancellation for all
nonterminal durable descendants and aborts their active controllers, while the
canonical execution ledger remains the authority for in-flight dispatch.

Profiles also select bounded loop behavior: quick uses a short focused loop;
standard permits ordinary repair; deep and research allow more evidence and
bounded alternatives; persistent permits the largest finite repair/checkpoint
loop. The environment ceiling is validated and capped, so a profile cannot
create an unbounded task.

The Brain path enforces these differences outside model output: quick permits
one bounded work/revision round, standard four, deep eight, research six, and
persistent eight under the global finite resource envelope. The live Agent
catalog is supplied to planning, including enabled module/pack and governed
generated capabilities; the plan validator and dispatcher still revalidate it
at execution time. Adjacent dependency-free steps may overlap only when their
live schema and structured effect metadata prove authoritative read-only work;
the durable envelope concurrency limit bounds the batch and evidence is joined
in plan order. Mutations and ambiguous or metadata-missing steps remain
serialized and fail closed.

Continuation fan-out is reserved atomically in the root usage ledger with a
per-parent counter. A child receives a narrowed depth/count envelope and never
inherits approval. `act-on` also stores its validated finding, artifact,
evidence, requirement, receipt, or recipe reference as structured child-task
lineage metadata; copied result prose is never executable authority. Receipt,
verification, retry, and escalation JSON is
redacted and bounded for size, field count, and nesting before persistence;
oversized or deeply nested payloads are rejected rather than truncated into a
different security meaning.

The structured continuation kinds are `investigate`, `implement`, `verify`,
`repair`, `compare`, `deliverable`, `continue`, `apply`, `monitor`, and
`recheck`. Each creates a fresh governed task with new authority and approval
evaluation. `apply` does not treat a copied or model-claimed approval as valid;
`monitor` and `recheck` remain subject to the existing governed scheduling or
watch capabilities selected by the task.

The durable usage ledger records root-relative `wall_ms` and the active
`concurrent_operations` gauge. Work-package lease claim, completion, and
expired-lease recovery update the task and root ledgers atomically, so a child
cannot reset the root wall clock or make concurrent work invisible after a
restart.

The SSE stream is best-effort delivery only. On reconnect, it consults the
durable task projection and reconstructs a terminal done/error frame when the
transient event was emitted before the browser attached; refresh and the
control-room projection remain authoritative.

`SIDEKICK_MAX_ITERATIONS` is an optional integer ceiling. Invalid, zero, or
negative values fail closed to the secure default of 60 and the value is capped
at 120; profile limits remain below that ceiling where applicable.

Git status, diff, log, and show are read-only classifications. Commit, merge,
checkout, and stash are workspace mutations and remain subject to explicit
authority and approval policy; push and pull are external critical effects.
Task-owned branch preparation uses the same live Git descriptor and policy.

When a task persists verification recipes, successful completion is additionally
gated on a fresh successful outcome for every recipe. Missing, stale, failed,
or contradictory recipe evidence produces an honest unable-to-verify result;
model confidence cannot satisfy the gate. Before terminal projection, the Agent
performs one bounded fresh recheck cycle for missing recipe gates through the
canonical dispatcher and records the repair attempt; unresolved gates remain
unable to verify and are not silently converted to success.

Hierarchical milestones are also completion gates. A milestone must name one
or more governed verification gates, and every named gate must have fresh,
independent successful evidence before the milestone is considered verified.
Plans with unknown gate references are rejected; a missing milestone gate
keeps the task unable to verify. Escalation packages are not approval tokens:
their decision endpoint requires the existing human `approvals.grant`
authorization, rejects requester self-approval, records the operator decision,
and never authorizes a replacement operation or transfers approval to a child.

Verification recipes are structured, bounded, and dispatched through the same
canonical authority. Evidence records freshness, independence, and whether an
observation succeeded, failed, contradicted, or was unavailable. A verified
status means the recorded criteria were satisfied according to available
evidence and policy; it is not an absolute truth claim.
