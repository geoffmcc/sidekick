# ADR: Approval Continuation v1

## Status

**Accepted — 2026-07-19.**

Defines how a Brain task parked at `waiting_for_approval` resumes after a human
approves, so an approval authorizes one exact parked action and the task runner
remains the sole executor of plan steps. Accepted as an architectural contract:
the invariants in §9 are binding, the physical schema is migration-ready but
provisional in the ways §9 records. **No implementation has been done** — the
schema, transactions, and recovery paths below are specified, not built.

Revision 2 removed an incorrect exactly-once claim, closed recovery gaps in the
transaction design (stale-running reclaim, atomic wake-up on denial/expiry/
cancellation), reconciled the approval lifecycle with the claim transaction, and
required encrypted storage for persisted plans, arguments, and results.

Revision 3 resolved state-machine contradictions that revision 2 introduced or
exposed: verification split into claim-time predicates and post-claim checks
with an explicit unwind path (§6.1/T6); trigger-specific wake-up so an
approved-but-unclaimed action can be cancelled (§7.1); orphan recovery that does
not require an approval row (§7.3/T7); a write-fenced single-claimant guarantee
(§8); persisted previews removed; a standalone-approval key encoding; and
tombstone retention.

Revision 4 closed remaining correctness gaps: a durable `current_approval_id`
binding that every transaction verifies, with one live task approval enforced by
unique index (§4.2, §5); exact approval/checkpoint state pairs in T5;
result-ledger conflicts verified by authoritative re-read rather than assumed
benign (§7.1); a specified manual-reconciliation lifecycle (§8.1–8.2, T9–T10); a
fenced lease-renewal transaction (T8); effect-concurrency claims removed; and
encryption extended to goal, reason, and error detail with errors constrained to
closed-vocabulary codes (§4.4).

Revision 5 fixed the runnable-state contradiction and the reconciliation
transaction: T3 split into action and resume claim modes, so a task woken by
denial, expiry, orphan recovery, refusal, or a completed result can actually be
claimed (§5/T3); T10 updates the approval through the intact binding before
clearing it, and `confirm_not_executed` re-authorizes with a fresh expiry via
`retry_authorized` (§8.2); the live-approval index covers
`reconciliation_required` and `retry_authorized`; T7 separates missing from
corrupt approvals and quarantines the latter; checkpoint encrypted columns are
nullable with a CHECK constraint so tombstones are legal; T4 and T6 spelled out
against the revised schema; reconciliation requires an authorized human; and
recovery-event reasons become closed-vocabulary codes.

Revision 7 (accepted) makes four localized corrections: `next_step_id` is
defined as the durable resume cursor, set at park and untouched by wake and
refusal paths, so a woken task can locate its recorded outcome after the binding
is cleared; `retry_authorized` pairs with `runnable` and is subject to
cancellation, supersession, and the expiry sweep, so a human-authorized
redispatch stays revocable and bounded; a recorded result alongside a *live*
approval is treated as an integrity failure routed to recovery rather than a
stale binding to clear; and a stale reclaim durably captures the prior attempt's
operation id, claimant, epoch, and attempt number so T9's event names the
attempt that may have executed. T6 also records `terminalized_by`/`_at`.

Revision 6 corrected two state-machine issues affecting normal dispatch: the
action claim now distinguishes an **initial** claim from a **stale/crashed
reclaim** and a **`retry_authorized` redispatch** using the approval's
pre-claim status, so a high-risk step is no longer sent to reconciliation
before it has ever run (§5/T3); T4 splits into **T4A** (record a newly executed
action) and **T4R** (consume an existing ledger outcome, with no INSERT and no
approval UPDATE), so a resume no longer collides with a recorded refusal;
`approver_identity` is written only by T2, with `terminalized_by` recording
denial/expiry/cancellation actors; `retry_authorized` and
`reconciliation_required` are applied consistently across both live-status
indexes, T7's quarantine predicate, and §6 Stage 1; and T9 writes
`reason_code` rather than the legacy plaintext column.

Defines how a Brain task parked at `waiting_for_approval` resumes after a human
approves, so that the approval authorizes one exact parked action and the task
runner remains the sole executor of plan steps. Requires durable storage that
does not exist today: the plan is never persisted, and approvals are not a
table. This ADR specifies that storage concretely but creates no migration and
changes no runtime behavior.

## Context

A Brain task that needs approval parks and never resumes. The approved tool
executes standalone, in a different execution tree, and its result is discarded.

The mechanism is a single dropped field. At `src/tools/dispatcher.js:160` the
execution context — which carries `taskId` (`src/tools/context.js:36`) and
`stepNumber` (`:47`) — is handed to `queueApproval`, and `queueApproval`
(`src/tools-legacy.js:487`) never copies either onto the approval record.
Everything downstream follows:

- `runBrainTask` returns out of its step loop at `src/brain/brain.js:180-189`.
  The validated plan, accumulated evidence, and step counters are stack locals
  and are garbage-collected. Nothing durable records what the task was doing.
- `executeApprovedTool` (`src/tools/dispatcher.js:223-265`) therefore has no
  task, step, or plan to return to. It dispatches the tool with a context whose
  `parentId`/`rootExecutionId` point at the *approval's own* synthetic execution
  (`recordPlatformApprovalQueued`, `src/tools-legacy.js:1199`), not the task's.
- The result is written to the approval record as `result_preview`
  (`:704-742`) and nowhere else. The parked task is never notified.
- `finishAgentExecution` maps `waiting_for_approval` to **failed** in the
  platform kernel (`src/agent.js:671`), even though the kernel has a proper
  `awaiting_approval` state (`src/platform/kernel.js:10`) with legal exits.

Three properties of the current storage make a durable binding impossible
without changing it:

1. **Approvals are not a table.** They are one JSON array in `json_documents`
   (`src/tools-legacy.js:289-295`, `src/db.js:47-52`). There is no per-approval
   row, so no primary key, foreign key, unique constraint, or index.
2. **Pending approvals can be silently evicted.** New items are `unshift`ed and
   the array is truncated — `saveApprovals(approvals.slice(0, 500))`
   (`src/tools-legacy.js:511`). The 501st approval disappears with no record.
   A binding that can vanish is not a binding.
3. **Whole-blob read-modify-write races.** Only `claimApprovalExecution`
   (`:572`) is transactional. `queueApproval`, `resolveApproval`,
   `renewApprovalLease`, and `finalizeApprovalExecution` all read the entire
   array, mutate, and rewrite it — last write wins over every other approval.

The plan is likewise absent from disk. `validated` is a local
(`src/brain/brain.js:150`); the only plan data that escapes is an SSE event
(`:151`, transient) and a `step_count` in a platform event (`:142`). There is
no `plan_json`, `plan_hash`, or `plan_version` column anywhere in `src/` or
`migrations/`. The transcript records the reverse link — step id → approval id,
in the parked step entry (`:184`) — but it is written once at the very end of
`runAgent` (`src/agent.js:1046`), so a task parked mid-flight has no transcript
at all until it terminates.

Two precedents already in the tree are worth reusing rather than reinventing:

- **Canonical-JSON + SHA-256 argument digest** — `canonicalizeApprovalValue` /
  `canonicalApprovalJson` / `approvalArgsHash` (`src/tools-legacy.js:319-337`).
  Already used for payload integrity (`:479`); it is exactly the primitive an
  execution key needs.
- **`BEGIN IMMEDIATE` + conditional UPDATE claim** — `claimNextJob`
  (`src/compute/job-manager.js:492-551`): expected state in the `WHERE` clause,
  `changes !== 1` as the lost-race signal, authoritative re-read inside the
  transaction. This is the codebase's proven single-claimant pattern.

## Decision

### 1. The task runner is the only executor of plan steps

An approval authorizes an action; it never performs one. `executeApprovedTool`
stops being an execution path for task-originated approvals and becomes a
state transition: it marks the approval approved and the task runnable, and
returns. The task runner reclaims the task and executes the step through the
normal path, so approved steps and ordinary steps share one code path, one
evidence-accumulation rule, and one result-persistence rule.

Approvals that did not originate from a task (a direct dashboard or MCP call)
keep today's standalone execution. The two are distinguished by whether
`task_id` is present on the approval.

### 2. Target lifecycle

```
task:
  running ─→ waiting_for_approval ─(T2 approve)──→ runnable ─(T3 claim)─→ running
                    │                                  ↑                    │
                    │                                  │                    ├─(T4)→ running → … → completed
                    │                                  │                    ├─(T6 refuse)──────→ runnable
                    ├─(T5 deny/expire/cancel/supersede)┤                    ├─(T9 ambiguous)──→ reconciling
                    ├─(T7 orphan)──────────────────────┘                    └─(task cancel)───→ cancelled
                    │
                    └─(deadline)──────────────────────────────────────────→ timed_out

  reconciling ─(T10 confirm_executed | abandon_step)──→ runnable
              ─(T10 confirm_not_executed)─────────────→ runnable (step still undone)
              ─(T10 fail_task | deadline)─────────────→ failed / timed_out

approval:
  pending ─(T2)─→ approved ─(T3 action)─→ executing ─(T4)──→ completed
     │                │                       │
     │                │                       ├─(T6)──────→ expired | cancelled | superseded
     │                │                       └─(T9)──────→ reconciliation_required
     │                │                                          │
     │                │            ┌─(T10 confirm_not_executed)──┤
     │                │            ↓                             ├─(T10 confirm_executed)→ completed
     │                │      retry_authorized ─(T3 action)→ executing
     │                │                                          └─(T10 abandon | fail)──→ superseded
     │                └─(T5 cancel/supersede)──────────────────→ cancelled | superseded
     ├─(T5)──────────────────────────────────────────────────────→ denied | expired | cancelled | superseded
     └─(T7 corrupt branch)───────────────────────────────────────→ quarantined
```

Claim mode follows from the checkpoint's binding, not the approval's status: a
`runnable` checkpoint **with** a live binding takes an action claim; one whose
binding was cleared — by T5, T6, T7, or a terminal T10 — takes a resume claim
and touches no approval.

`denied`, `expired`, and `cancelled` are **not** task failures. They are
structured step outcomes returned to the planner, which may explain the outcome
or choose a materially different route (§7).

### 3. The binding

An approval must name exactly one intended action. The binding is eight fields:

| Field | Purpose |
|---|---|
| `task_id` | which task is parked |
| `step_id` | which plan step (`plan-validator.js:202`, model-authored, unique per plan) |
| `plan_version` | digest of the validated plan; detects a replanned task |
| `tool_name` | what was authorized |
| `args_digest` | canonical SHA-256 of the arguments authorized |
| `expires_at` | when the authorization lapses |
| `requester_identity` | who/what asked |
| `idempotency_key` | the derived action identity that constraints key on |

`idempotency_key` is **derived, not random**. Because it is a durable identity
that constraints depend on, its encoding is versioned and fully specified — an
ambiguous concatenation is a correctness bug, not a formatting preference.

```
FS   = "\x1f"                       -- ASCII unit separator; forbidden in all inputs
akv1_payload = "akv1" FS task_id FS step_id FS plan_version FS tool_name FS args_digest
idempotency_key = "akv1:" || lower_hex(sha256(utf8(akv1_payload)))
```

Rules that make it well-defined:

- **Version prefix.** The literal `akv1` appears both inside the hashed payload
  and as the stored prefix. A future encoding change becomes `akv2`, produces
  different keys for the same action, and is detectable by inspection.
- **Unambiguous separator.** `\x1f` cannot occur in any input: `task_id` is a
  hex slice (`src/agent.js:1076`), `step_id` matches `/^[a-zA-Z0-9_-]{1,64}$/`
  (`plan-validator.js:202`), `tool_name` matches `/^[a-z][a-z0-9_]*$/` (`:193`),
  and `plan_version` and `args_digest` are each a lowercase-alphanumeric version
  prefix, a colon, and lowercase hex. Every alphabet excludes `\x1f`, so no
  length-prefixing is required; an implementation MUST reject an input
  containing `\x1f` rather than escape it.
- **Fixed field order and count.** Six fields, always present, never reordered.
  A null or empty component is a programming error, not a permitted value.

`plan_version` is likewise a versioned digest of the validated plan:

```
plan_version = "pv1:" || lower_hex(sha256(utf8("pv1" FS canonicalPlanJson(validated))))
```

where `canonicalPlanJson` is the existing recursive key-sorting canonicaliser
(`canonicalizeApprovalValue` / `canonicalApprovalJson`,
`src/tools-legacy.js:319-332`) applied to the post-validation, post-strip plan.
It is a content identity, not the schema `version: 1` field the validator checks
at `plan-validator.js:184`.

`args_digest` uses the same canonicaliser and a `ad1:` prefix, so all three
digests carry their encoding version.

**Standalone approvals need a different key.** A direct dashboard or MCP
approval has no task, step, or plan, so `task_id`, `step_id`, and
`plan_version` are NULL — and `akv1` forbids null components. Since
`idempotency_key` is `NOT NULL`, these approvals need their own versioned
format rather than a nullable exception:

```
skv1_payload    = "skv1" FS approval_id FS tool_name FS args_digest
idempotency_key = "skv1:" || lower_hex(sha256(utf8(skv1_payload)))
```

Keying on `approval_id` makes it unique by construction, which is deliberate:
**standalone approvals get no action-level deduplication**, exactly as today.
Two identical direct requests remain two independent authorizations, because
there is no task whose liveness depends on collapsing them. The prefix makes
the two populations trivially distinguishable, and the unique index in §4.1(a)
covers both without special cases.

An implementation MUST reject a task-originated approval whose binding fields
are incomplete rather than silently falling back to `skv1` — a missing
`step_id` on a task approval is a bug, not a standalone request.

**The canonicaliser becomes a versioned wire format.** Once these digests are
load-bearing, any change to `canonicalizeApprovalValue`'s normalisation silently
invalidates every stored digest. It must not be modified in place; a change
requires a new version prefix and a documented migration of stored digests.

Deriving the key means a duplicate approval submission for the same unchanged
action computes the same key and collides on a unique index, rather than
creating a second authorization for the same act. Today's key is a formatted
label (`approval:${approvalId}:${operationId}`, `src/tools-legacy.js:655`) that
nothing ever reads back.

### 4. Proposed physical schema

Provisional (§9 separates this from the invariants). Migration `025_` — the
loader requires contiguous numbering (`src/db.js:2320`). Any new table also
needs a runtime `ensure` counterpart, since several subsystems create schema
outside migrations for tests (`kernel.js:65`, `job-manager.js:134`).

#### 4.1 `approvals` — promote the JSON document to a table

```sql
CREATE TABLE IF NOT EXISTS approvals (
  approval_id           TEXT PRIMARY KEY,
  status                TEXT NOT NULL,
  tool_name             TEXT NOT NULL,
  risk                  TEXT NOT NULL DEFAULT 'unknown',
  source                TEXT NOT NULL,
  mode                  TEXT,
  reason_encrypted      TEXT,          -- free-form; may quote arguments (§4.4)

  -- binding
  task_id               TEXT,
  step_id               TEXT,
  plan_version          TEXT,
  args_digest           TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,

  -- payload: ciphertext only (§4.4). No plaintext arguments in any column,
  -- including redacted previews — those are generated on demand from the
  -- decrypted payload for an authorized viewer, never persisted.
  args_encrypted        TEXT,

  -- identity. Three distinct acts by three potentially different principals,
  -- each with its own columns. None is ever overwritten by another:
  --   approver_identity / decided_at   — the ORIGINAL authorization (T2 only)
  --   terminalized_by  / terminalized_at — who denied, cancelled, superseded, or
  --                                        which process expired it (T5/T6/T7)
  --   reconciled_by    / reconciled_at   — who resolved an ambiguity (T10)
  requester_identity    TEXT,
  approver_identity     TEXT,
  terminalized_by       TEXT,
  terminalized_at       TEXT,
  reconciled_by         TEXT,
  reconciled_at         TEXT,
  reconciliation_decision TEXT,   -- closed vocabulary, §8.2

  -- timing
  requested_at          TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  decided_at            TEXT,
  completed_at          TEXT,
  updated_at            TEXT NOT NULL,

  -- execution state. `operation_id` IS written for task-originated approvals
  -- (§5/T3) as the correlation id of the claim. Only the LEASE fields —
  -- executor_id and lease_expires_at — stay NULL for them, because the
  -- authoritative lease is the checkpoint's. Both remain in use for standalone
  -- (non-task) approvals, which keep today's execution path.
  operation_id          TEXT,
  executor_id           TEXT,
  lease_expires_at      TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  reconciliation_status TEXT NOT NULL DEFAULT 'not_required',

  -- outcome. Digest only; the result content lives encrypted in
  -- task_step_results for task approvals (§4.3).
  result_digest         TEXT,
  error_code            TEXT,          -- closed vocabulary, never free-form (§4.4)
  error_detail_encrypted TEXT,         -- optional constructed detail, ciphertext

  platform_execution_id TEXT,
  schema_version        INTEGER NOT NULL DEFAULT 1,

  -- Approvals are audit records and MUST outlive the working checkpoint.
  -- RESTRICT, never CASCADE: deleting a checkpoint must not destroy the record
  -- of what a human authorized. See §4.5 for the retention policy that makes
  -- checkpoint cleanup possible without violating this.
  FOREIGN KEY (task_id) REFERENCES task_checkpoints(task_id) ON DELETE RESTRICT
);

-- (a) AUTHORITATIVE. One approval record per action identity, for all time and
-- in every status. This is what makes a duplicate submission collide and what
-- makes a denial final for that exact action: a legitimate retry must differ in
-- arguments or plan, which yields a different key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_idempotency
  ON approvals(idempotency_key);

-- (b) REDUNDANT BY CONSTRUCTION, retained deliberately. Every column here is an
-- input to the key in (a), so this constraint cannot fail unless the key
-- derivation is wrong. That is precisely its value: it states the invariant in
-- readable column terms, it survives a change to the derivation, and it turns a
-- mis-derived key into an integrity error at write time instead of a silent
-- duplicate authorization. Scoped to live statuses so it never blocks the
-- terminal-state history that (a) governs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_live_action
  ON approvals(task_id, step_id, plan_version, tool_name, args_digest)
  WHERE status IN ('pending', 'approved', 'executing',
                   'reconciliation_required', 'retry_authorized');

CREATE INDEX IF NOT EXISTS idx_approvals_status_expiry ON approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_approvals_task          ON approvals(task_id);
```

`tool_name` is included in (b) so its column set corresponds exactly to the
key inputs in §3. Omitting it would leave the two constraints subtly
non-equivalent and defeat the cross-check that is the whole reason to keep (b).

Anti-re-request protection therefore comes from **(a)**, not (b): the same
unchanged action can never be re-requested, in any status, because its key
already exists. A materially different route produces different arguments or a
different plan, hence a different key, and is permitted.

#### 4.2 `task_checkpoints` — durable suspended execution

```sql
CREATE TABLE IF NOT EXISTS task_checkpoints (
  task_id             TEXT PRIMARY KEY,
  root_task_id        TEXT,
  state               TEXT NOT NULL,
  -- Nullable so a tombstone can clear them (§4.5); the CHECK below makes them
  -- mandatory for every non-archived state, so an active checkpoint can never
  -- exist without its goal and plan.
  goal_encrypted      TEXT,            -- free-form user text; may hold secrets (§4.4)
  classification_json TEXT NOT NULL DEFAULT '{}',

  plan_version        TEXT NOT NULL,   -- identity, retained on tombstones
  plan_encrypted      TEXT,            -- ciphertext; step arguments may hold secrets
  plan_digest         TEXT NOT NULL,   -- integrity check on decrypt; retained
  next_step_id        TEXT,

  -- Durable binding to the one live approval, plus enough action metadata to
  -- construct a result row WITHOUT reading the approval (required by T7, which
  -- runs precisely when the approval row is missing or unreadable).
  current_approval_id     TEXT,
  current_step_id         TEXT,
  current_args_digest     TEXT,
  current_idempotency_key TEXT,

  progress_encrypted  TEXT,
  evidence_encrypted  TEXT,            -- tool output; may hold secrets
  evidence_chars      INTEGER NOT NULL DEFAULT 0,
  successful_tool_evidence INTEGER NOT NULL DEFAULT 0,

  claimed_by          TEXT,
  lease_expires_at    TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  claim_epoch         INTEGER NOT NULL DEFAULT 0,  -- fencing token, §8

  -- Identity of the PRIOR attempt, captured by T3 on a stale reclaim before it
  -- overwrites the live claim fields. This is the attempt that may have
  -- executed; T9's recovery event must name it, not the recovery claimant.
  -- Durable rather than in-memory so a second crash does not lose it.
  prior_operation_id  TEXT,
  prior_claimed_by    TEXT,
  prior_claim_epoch   INTEGER,
  prior_attempt_count INTEGER,

  deadline_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  platform_execution_id TEXT,
  root_execution_id     TEXT,
  schema_version        INTEGER NOT NULL DEFAULT 1,

  -- Encrypted content is required while a checkpoint is live and cleared only
  -- when it becomes a tombstone. Expressed as a constraint rather than a
  -- convention, so a bug that blanks a live checkpoint fails at the database.
  CHECK (
    state = 'archived'
    OR (goal_encrypted IS NOT NULL AND plan_encrypted IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_runnable
  ON task_checkpoints(state, lease_expires_at)
  WHERE state IN ('runnable', 'running');

-- Sweeper support: parked and reconciling tasks must be findable without a scan.
CREATE INDEX IF NOT EXISTS idx_task_checkpoints_parked
  ON task_checkpoints(state, updated_at)
  WHERE state IN ('waiting_for_approval', 'reconciling');
```

**One live task-originated approval per task.** The binding is 1:1 by design —
a plan step parks the whole task, so there is never a second concurrent
authorization to track. Enforced in the schema rather than by convention:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_one_live_per_task
  ON approvals(task_id)
  WHERE task_id IS NOT NULL
    AND status IN ('pending', 'approved', 'executing',
                   'reconciliation_required', 'retry_authorized');
```

`reconciliation_required` and `retry_authorized` are **live** statuses and must
be in this set. An approval parked for reconciliation still owns its task's
authorization slot — the task cannot legitimately request a second one while an
ambiguous execution of the first is unresolved. Omitting them would let a
replan queue a competing approval for the same task while a human is still
deciding about the previous one.

Parallel step execution would need this relaxed and `current_approval_id`
generalised to a set. It is deliberately not designed for here: the runner
executes plan steps sequentially (`src/brain/brain.js:165`), and inventing
multi-approval semantics for a capability that does not exist would add failure
modes with no caller.

`plan_encrypted` holds the validated, post-strip plan — the object the validator
returned, never the model's raw output. `evidence_encrypted` is bounded by the
existing `BRAIN_LIMITS.MAX_EVIDENCE_CHARS` budget, so the row cannot grow
without limit. Both are ciphertext for the reasons in §4.4.

A checkpoint is written when a task parks, not on every step. Continuous
checkpointing is a separate concern (§10).

#### 4.3 `task_step_results` — the recorded-outcome ledger

```sql
CREATE TABLE IF NOT EXISTS task_step_results (
  task_id         TEXT NOT NULL,
  step_id         TEXT NOT NULL,
  plan_version    TEXT NOT NULL,
  args_digest     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status          TEXT NOT NULL,
  result_encrypted TEXT,           -- ciphertext; tool results may hold secrets
  result_digest   TEXT,            -- queryable, non-sensitive
  outcome_code    TEXT,            -- closed vocabulary (approval_denied, …)
  error_detail_encrypted TEXT,     -- optional constructed detail, ciphertext
  approval_id     TEXT,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, step_id, plan_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_step_results_idempotency
  ON task_step_results(idempotency_key);
```

The runner consults this before executing. A row means the step has already
been dispatched and its outcome recorded; the stored result is returned instead
of dispatching again. It is the record that makes recovery decidable — but it
does not by itself make execution exactly-once, for the reasons in §8.

#### 4.4 Encryption of persisted execution content

**Requirement: no plaintext tool arguments, plan step arguments, or tool results
in any queryable column.** Redaction is a display control, not a storage
control: `approvalPreviewArgs` (`src/tools-legacy.js:301-317`) redacts by key
name for presentation, and `redactSensitive` matches known credential shapes,
but neither can be relied on to catch an arbitrary secret that a caller passed
as an ordinary-looking argument value. The existing approval payload is already
encrypted at rest for exactly this reason (`encryptApprovalArgs`, `:472-474`),
and this ADR extends that treatment to everything it newly persists.

| Content | Storage | Queryable surface |
|---|---|---|
| Approval arguments | `args_encrypted` | `args_digest` |
| Validated plan | `plan_encrypted` | `plan_version`, `plan_digest` |
| Accumulated evidence | `evidence_encrypted` | `evidence_chars` counter |
| Step results | `result_encrypted` | `result_digest` |
| Task goal | `goal_encrypted` | nothing |
| Approval reason | `reason_encrypted` | `risk`, `mode`, `source` |
| Error / outcome detail | `error_detail_encrypted` | `error_code`, `outcome_code` |

**Free-form text is treated exactly like arguments.** The goal is user-authored
and may name a credential inline; an approval `reason` is constructed from
policy and can quote the arguments it is explaining; and error text is the
most common accidental exfiltration path in the codebase's history — the
`redactSensitive` gap fixed in PR #141 existed because a raw provider message
carrying a token reached the transcript verbatim. Anything free-form is assumed
to be capable of holding a secret.

**Errors are codes, not prose.** `error_code` and `outcome_code` draw from a
closed vocabulary (`approval_denied`, `approval_expired`, `plan_superseded`,
`arguments_altered`, `checkpoint_corrupt`, `approval_missing_or_corrupt`,
`payload_unreadable`, `ambiguous_execution`, `reconciled_executed`,
`reconciliation_abandoned`, `reconciliation_failed`, …) and are safe to index,
aggregate, and display without a key. Where a human needs more than a code, the
detail is deliberately *constructed* from known-safe components — never a
captured exception message — and stored encrypted. An implementation must not
widen these columns into a place where `e.message` can land.

**This extends to the recovery-event table.**
`approval_execution_recovery_events` (migration 021) has a free-form
`reason TEXT` column whose writer currently swallows all errors
(`src/tools-legacy.js:400-420`). Every transaction in this ADR writes to that
table, so leaving `reason` free-form would reopen the plaintext problem through
the audit path — the one place operators are most likely to paste a raw failure
into. Migration `025_` therefore adds `reason_code TEXT` (closed vocabulary) and
`reason_detail_encrypted TEXT`, and the transactions above write those. The
legacy `reason` column is retained for existing rows and must not be written by
new code.

Digests are computed over plaintext before encryption and stored in the clear,
so integrity and identity remain queryable without exposing content — the same
split already used for `args_hash` vs `args_encrypted`.

**Redacted previews are not persisted.** An earlier revision kept
`args_preview` and `result_preview` columns, which contradicted the invariant
they sat beside: `approvalPreviewArgs` redacts by *key name*
(`src/tools-legacy.js:301-317`) and `redactSensitive` matches *known credential
shapes*, so neither can catch a secret passed as an ordinary-looking value under
an ordinary-looking key. A persisted preview is therefore plaintext of unknown
sensitivity, and storing it would make I12 false.

Previews are instead **generated on demand**: an authorized reader decrypts the
payload and the existing redaction runs over the plaintext at render time. The
consequence is real and must be accepted deliberately — the approval-listing API
now requires the decryption key to show a preview at all, where today it renders
`args_preview` straight from storage (`publicApproval`, `:515-521`). An
unauthorized or key-less reader sees the tool name, risk, digests, and timing,
and no argument content whatsoever. That is the correct failure direction.

Consequences an implementation must handle:

- **`SIDEKICK_SECRET_KEY` becomes required to resume a task**, not merely to
  approve one. The existing behaviour when it is absent is to force-fail
  approvals (`:439-444`); the equivalent here is that a checkpoint cannot be
  rehydrated and the task must fail closed with a distinguishable reason rather
  than resume with an empty plan.
- **Key rotation invalidates stored checkpoints.** Parked tasks should be
  drained or explicitly failed before rotation; this is an operational
  procedure the implementation must document.
- An **encrypted artifact** (`platform_artifacts`, with only the reference and
  digest in the row) is an acceptable alternative to an inline encrypted column
  for `plan_encrypted` and `evidence_encrypted`, and may be preferable if plans
  grow. The invariant is that the row itself carries no sensitive plaintext;
  where the ciphertext lives is provisional.

#### 4.5 Retention

Because the foreign key is `RESTRICT`, a checkpoint cannot be deleted while
approvals reference it. That is deliberate — an approval is the durable record
of what a human authorized and must not be collected as a side effect of task
cleanup — but it means cleanup needs an explicit order:

1. Checkpoints in a terminal state are retained for a bounded window
   (proposed: the existing 30-day transcript retention, `src/agent.js:57`) so
   post-hoc diagnosis can join a task to its approvals.
2. After that window, approvals for the task are **archived, not deleted**:
   `task_id` is retained, and the encrypted payload columns are cleared, which
   the existing code already does for non-pending items
   (`payload_discarded_at`, `:381`, `:425-430`).
3. The checkpoint row is **never deleted**. It is reduced to a **tombstone**:
   `state='archived'`, with **every encrypted column cleared** —
   `goal_encrypted`, `plan_encrypted`, `evidence_encrypted`,
   `progress_encrypted` — and counters, timestamps, digests, and
   `task_id` retained. Producing a tombstone is the point at which sensitive
   content leaves the database; the row that remains carries identity and
   metrics only, and needs no key to read.

Tombstones rather than deletion, because the alternatives do not work:

- **Deferrable FK** does not help. Deferral only postpones the check to commit
  time *within a transaction*; it cannot license a `task_id` that dangles
  permanently afterwards. A row referencing a deleted parent would violate the
  constraint at the next integrity check regardless of when it was deferred.
- **`ON DELETE SET NULL`** would satisfy the constraint but destroy the very
  correlation the audit record exists to preserve — which task authorized this?
- **`ON DELETE CASCADE`** destroys the audit record outright (I13).

A tombstone costs one small row per task, and **accumulates without bound** —
it is explicitly not subject to the retention window, because its whole purpose
is to outlive it and remain the referent for approvals that are themselves
retained. The retention window governs when sensitive content is cleared, not
when the row disappears; the row never disappears. Growth is therefore linear in
total tasks ever run, which for this deployment is small, but it is unbounded
and should be sized deliberately rather than discovered.

**Acceptable substitute:** omit the foreign key entirely and treat `task_id` as
an indexed correlation column with the retention order enforced in application
code. This trades declarative integrity for freedom to delete checkpoints, and
is a reasonable choice if tombstone growth proves unwelcome. What is not
acceptable is any option that destroys or blanks the approval's task
correlation.

### 5. Transaction boundaries

Ten atomic units, T1–T10. The codebase's dominant idiom for a multi-statement
atomic claim is raw `BEGIN IMMEDIATE` (`job-manager.js:497`, `db.js:2352`), not
`db.transaction` — which is used exactly once, at `tools-legacy.js:572`.

**The checkpoint is the authority on which approval is live.** Every
transaction that mutates a task-originated approval joins through
`task_checkpoints.current_approval_id` rather than trusting an `approval_id`
and a `task_id` supplied independently by the caller. Two separately-supplied
identifiers can disagree — a stale dashboard, a replayed request, or a bug
could approve an approval that is no longer the one this task is parked on, and
every row-count check would still pass. Routing through the binding makes that
unrepresentable:

```sql
AND approval_id = (SELECT current_approval_id FROM task_checkpoints WHERE task_id = ?)
```

This predicate appears in T2, T4, T5, T6 and T10. Where it is written below as
`AND <bound>`, that is the clause meant.

**T1 — Park.** One transaction:
1. upsert `task_checkpoints` with the plan, progress, `state='waiting_for_approval'`,
   the binding fields `current_approval_id`, `current_step_id`,
   `current_args_digest`, `current_idempotency_key`, **and `next_step_id` set to
   the parked step's id**
2. insert `approvals` bound to `(task_id, step_id, plan_version, args_digest)`
   with the derived `idempotency_key`

**`next_step_id` is the durable resume cursor**, and is deliberately separate
from the binding. Every wake and refusal path (T5, T6, T7, terminal T10) clears
all four `current_*` fields, so after a denial or an orphan recovery the
checkpoint no longer records *which* step it was on — yet T4R must locate the
recorded outcome by `(task_id, step_id, plan_version)`. `next_step_id` is what
survives to answer that:

- **T1** sets it to the parked step.
- **T5, T6, T7, and terminal T10 do not advance it.** They terminalise an
  outcome *for that step*; the step is still where the plan stands.
- **A resume claim reads it** and queries `task_step_results` with it.
- **Only T4A and T4R advance it**, after the outcome has been consumed and the
  planner has moved on.

Clearing `next_step_id` alongside the binding would leave a woken task unable to
find its own recorded outcome — the cursor and the authorization are different
concerns with different lifetimes.

Both or neither. A checkpoint without its approval is an orphan; an approval
without its checkpoint is the current bug in durable form. The binding is
written here, atomically with both rows, so it can never be inferred later.

The unique index `idx_approvals_one_live_per_task` (§4.2) rejects a second live
approval for the same task, so a bug that tried to park twice fails at the
database rather than silently orphaning the first authorization.

**T2 — Approve.** One transaction, **both statements must affect exactly one
row**:
```sql
UPDATE approvals SET status='approved', approver_identity=?, decided_at=?, updated_at=?
 WHERE approval_id=? AND status='pending' AND expires_at > ? AND <bound>;
-- changes must be exactly 1, else ROLLBACK

UPDATE task_checkpoints SET state='runnable', updated_at=?
 WHERE task_id=? AND state='waiting_for_approval';
-- changes must be exactly 1, else ROLLBACK
```
`changes !== 1` on the **first** statement means the approval was concurrently
denied, expired, already approved — or is not the approval this task is
currently bound to.

`changes !== 1` on the **second** is the more dangerous case and must roll the
whole transaction back: it means the checkpoint was not in
`waiting_for_approval` — it may have been cancelled, already woken by an expiry
sweep, superseded by a replan, or be missing entirely. Committing the first
statement alone would produce an approved approval attached to a task that
never becomes runnable: an authorization that can never be consumed and never
expires, because expiry only applies to `pending`. This is I2, and it is
enforced by checking both row counts rather than by assuming the checkpoint is
in the state the caller last saw.

The caller is told which of the two failed, since the operator-facing meaning
differs: "already decided" versus "the task is no longer waiting for this".

**T3 — Claim.** Two modes, and conflating them was a fundamental error in
revision 4: it required a live `approved`/`executing` approval on **every**
claim. But T5, T6, T7 and T10 all terminalise the approval and clear the
binding *before* setting the checkpoint `runnable`. A task woken by denial,
expiry, orphan recovery, post-claim refusal, or a completed result therefore has
no live approval to transition, could never be claimed, and would sit
`runnable` forever — every non-approval path was a dead end.

The two modes are distinguished by durable state, not by the caller's intent:

| Mode | Precondition | Approval effect |
|---|---|---|
| **Action claim** | `current_approval_id IS NOT NULL` **and** no `task_step_results` row at `next_step_id` | transitions the bound approval to `executing` |
| **Resume claim** | `current_approval_id IS NULL`, **or** an outcome exists and the bound approval is already terminal and agrees with it | **touches no approval at all** |

Both begin `BEGIN IMMEDIATE` and share the same checkpoint claim, which covers
a cleanly parked task and one abandoned by a crashed claimant:

```sql
UPDATE task_checkpoints
   SET state='running', claimed_by=?, lease_expires_at=?,
       attempt_count=attempt_count+1,
       claim_epoch=claim_epoch+1,          -- fencing token, §8
       updated_at=?
 WHERE task_id=?
   AND (
         state='runnable'
      OR (state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
       );
-- changes !== 1  →  another worker won, or the task is not claimable
```

The runner reads back `claim_epoch` inside the transaction and carries it for
the life of the claim. Every later write (T4, T6, T8, T9) is conditioned on that
epoch still being current, so a superseded claimant cannot write.

The second disjunct is the crash-recovery path. A claimant that died after
claiming leaves the checkpoint `running` with a lease nobody renews; once it
expires the row is claimable again. Without it the task would be stranded in
`running`, since nothing else transitions out of that state.

**On a stale reclaim, capture the prior attempt's identity before overwriting
it.** The reclaim replaces `claimed_by`, `claim_epoch`, and the approval's
`operation_id` — which are precisely the identifiers of the attempt that may
have executed. Losing them would leave T9's recovery event naming only the
runner that *discovered* the ambiguity, not the one that might have caused it,
which is exactly backwards for the operator who has to investigate:

```sql
-- in the same statement, only when reclaiming a `running` row
   SET prior_operation_id  = (SELECT operation_id FROM approvals
                               WHERE approval_id = current_approval_id),
       prior_claimed_by    = claimed_by,
       prior_claim_epoch   = claim_epoch,
       prior_attempt_count = attempt_count,
       …
```

These are written durably rather than carried in memory, so a recovery runner
that itself crashes does not lose the identity of the original attempt. On an
initial claim (`state='runnable'`) they are set to NULL — there is no prior
attempt.

**Action claim only** — determine the mode by reading the checkpoint's binding
inside the same transaction, then capture the approval's **pre-claim status**
before transitioning it:

```sql
-- (a) authoritative pre-claim read, inside the transaction
SELECT status AS pre_claim_status, attempt_count
  FROM approvals WHERE approval_id=? AND <bound>;

-- (b) transition, pinned to the status just observed
UPDATE approvals
   SET status='executing', operation_id=?, attempt_count=attempt_count+1, updated_at=?
 WHERE approval_id=? AND status=<pre_claim_status> AND <bound>
   AND status IN ('approved','executing','retry_authorized');
-- changes must be exactly 1, else ROLLBACK
```

`pre_claim_status` is returned to the runner alongside `claim_epoch` and is the
**authoritative discriminator** for what happens next. `approvals.attempt_count`
increments per action claim of this specific approval, and is the durable
record behind it.

#### The three action cases

Revision 5 collapsed a newly approved step and a crashed reclaim into one
condition — "bound approval, no result row" — and sent both through the risk
gate. Taken literally, a `high`-risk step would enter reconciliation on its
**first legitimate execution, having never been dispatched**. The ambiguity that
justifies the gate does not exist before anything has run.

| `pre_claim_status` | Case | Treatment |
|---|---|---|
| `approved` | **initial action claim** — T2 approved it and nothing has claimed it since | verify (§6 Stage 2) and **dispatch normally**. No risk gate: nothing has run, so there is no ambiguity |
| `executing` | **stale/crashed action reclaim** — a previous claim already transitioned it and did not finish | **apply the risk gate** (§8). The prior claimant may or may not have dispatched |
| `retry_authorized` | **human-authorized redispatch** — §8.2 `confirm_not_executed` | **dispatch normally**, exactly once. A human has asserted the effect did not land |

The discriminator is deliberately **not** the checkpoint's `attempt_count`,
which counts resume claims and claims for other steps of the same task and so
cannot distinguish these cases. It is the approval's own pre-claim status,
which changes only on an action claim of that specific action.

`executing` remains idempotent as a *destination* — a reclaim writes it again —
but observing it as the *origin* is precisely the signal that a previous
claimant already held this action.

A `retry_authorized` claim transitions to `executing`, so a crash during the
authorized retry presents as `executing` on the next reclaim and correctly falls
back to the risk gate. One human authorization permits one redispatch, not an
unlimited licence.

`approvals.attempt_count` also bounds pathological looping: an action reclaimed
beyond a configured limit is failed rather than reclaimed again, independently
of the checkpoint's own counter.

**Resume claim** performs no approval statement whatsoever. The task is claimed
purely so the planner can consume an outcome that is already durable — a
refusal recorded by T5/T6/T7, or a completed result recorded by T4. Requiring an
approval here would be requiring the thing those paths deliberately removed.

**A recorded outcome alongside a *live* approval is an integrity failure, not a
resume.** Revision 6 treated it as a stale binding to be cleared, which would
clear the binding and leave an `approved`, `executing`, or `retry_authorized`
approval live — orphaning a valid authorization with nothing pointing at it, and
leaving it occupying the task's live-approval slot.

That combination should be unreachable: every transaction that records a result
also terminalises the approval atomically (T4A statements 1–2; T10's result and
approval updates in one transaction). Observing it means one of those
invariants has already been violated, and the correct response is to stop rather
than to paper over it.

The rule for a resume claim with a non-null binding:

| Bound approval status | Interpretation |
|---|---|
| terminal (`completed`, `denied`, `expired`, `cancelled`, `superseded`, `quarantined`) **and** consistent with the ledger row | **accept** — a wake path committed the approval half and did not reach the binding clear. Resume and clear it. |
| live (`pending`, `approved`, `executing`, `reconciliation_required`, `retry_authorized`) | **integrity failure** — ROLLBACK, emit a `manual_review` recovery event, and route to §7.3 |
| terminal but disagreeing with the ledger row on approval id or action binding | **integrity failure** — same treatment |

Consistency means the ledger row's `approval_id` matches the binding and its
`args_digest` and `idempotency_key` match the checkpoint's `current_*` values.

The ordinary resume — binding already NULL — is unaffected and remains the
common case.

**For task-originated approvals the checkpoint's lease is authoritative and the
approval's own lease columns stay NULL.** There is exactly one lease per parked
action, held by the checkpoint. The approval lease columns remain in the schema
only for standalone approvals, which keep today's path. Two leases over one
action would be a correctness hazard, not redundancy.

`attempt_count` increments on every claim of either mode, so a task that
repeatedly crashes mid-step is detectable and can be failed after a bounded
number of attempts rather than looping.

Claiming is **not** dispatching. Having claimed, an action-mode runner performs
the §6 Stage-2 verification; a step whose outcome is already recorded returns
that stored result; a step with no recorded outcome fell in the ambiguous window
and is governed by the risk gate in §8, which may refuse and park the task for
reconciliation rather than redispatch.

Authoritative state is re-read inside the transaction, never trusted from the
caller's snapshot — the explicit lesson of `job-manager.js:503-506`.

**T4 — Advance.** Two variants, matching T3's two claim modes. Revision 5 had
one, which unconditionally inserted `status='completed'` — so a resume claim
waking on a `refused` denial, expiry, cancellation, or orphan outcome would
insert a conflicting row, fail the full-field comparison, and be treated as an
integrity failure. The correct behaviour on a resume is to *consume* the
existing outcome, not to write a new one.

**T4A — Action record.** Used after an action claim that dispatched. Fully
conditioned on the live claim:

```sql
-- 1. record the outcome
INSERT INTO task_step_results
  (task_id, step_id, plan_version, args_digest, idempotency_key,
   status, result_encrypted, result_digest, outcome_code, approval_id, recorded_at)
VALUES (?,?,?,?,?, 'completed', ?, ?, NULL, ?, ?)
ON CONFLICT(task_id, step_id, plan_version) DO NOTHING;
-- zero rows → authoritative re-read and full field comparison per §7.1.
--   Identical row  → benign duplicate, proceed.
--   Differing row  → integrity failure: ROLLBACK + manual_review event.

-- 2. terminalise the bound approval
UPDATE approvals
   SET status='completed', result_digest=?, completed_at=?, updated_at=?
 WHERE approval_id=? AND status='executing' AND <bound>;
-- changes must be exactly 1, else ROLLBACK

-- 3. advance the checkpoint and CLEAR THE WHOLE BINDING, fenced by the claim
UPDATE task_checkpoints
   SET next_step_id=?, evidence_encrypted=?, evidence_chars=?,
       successful_tool_evidence=?, state='running', updated_at=?,
       current_approval_id=NULL, current_step_id=NULL,
       current_args_digest=NULL, current_idempotency_key=NULL
 WHERE task_id=? AND claim_epoch=? AND claimed_by=? AND state='running';
-- changes must be exactly 1, else ROLLBACK
```

**T4R — Resume advance.** Used after a resume claim. It performs **no result
INSERT and no approval UPDATE** — the outcome is already durable and the
approval, if any, is already terminal:

```sql
-- 1. consume and verify the existing ledger row
SELECT status, outcome_code, result_encrypted, result_digest, idempotency_key,
       args_digest, approval_id
  FROM task_step_results
 WHERE task_id=? AND step_id=? AND plan_version=?;
-- absent → this is not a resumable state: ROLLBACK and route to T7 (§7.3),
--          which is the path for a checkpoint whose action cannot be resolved.
-- present but idempotency_key / args_digest disagree with the checkpoint's
--          binding (where one is still set) → integrity failure: ROLLBACK +
--          manual_review event. Never advance on a result belonging to a
--          different action.

-- 2. advance the checkpoint, feeding the outcome to the planner, and clear any
--    stale binding, fenced by the claim
UPDATE task_checkpoints
   SET next_step_id=?, evidence_encrypted=?, evidence_chars=?,
       successful_tool_evidence=?, state='running', updated_at=?,
       current_approval_id=NULL, current_step_id=NULL,
       current_args_digest=NULL, current_idempotency_key=NULL
 WHERE task_id=? AND claim_epoch=? AND claimed_by=? AND state='running';
-- changes must be exactly 1, else ROLLBACK
```

A `refused` row advances the planner with the structured outcome (§7); a
`completed` row advances it with the stored result. Either way the step is
finished and the plan continues — which is the whole point of waking the task.

The binding is cleared unconditionally in T4R even though it is usually already
NULL: the one case where it is not is a resume claim triggered by an existing
result alongside a stale binding (§5/T3), and that stale binding must not
survive the advance.

**All four `current_*` fields are cleared together** in both variants. Clearing
only `current_approval_id` while leaving `current_step_id`,
`current_args_digest`, and `current_idempotency_key` populated would leave the
checkpoint claiming to be parked on a finished step — and T7 constructs its
result row from exactly those fields, so a stale subset would let orphan
recovery fabricate a refusal for a step that succeeded. The binding is one unit:
written together in T1, cleared together wherever a step reaches a terminal
outcome — T4A, T4R, T5, T6, T7, and the terminal branches of T10.

The `claim_epoch`/`claimed_by`/`state` predicate is the fence in both variants:
a runner whose lease expired and whose task was reclaimed matches zero rows,
rolls back, and **must discard its result** rather than overwrite the current
claimant's work. This is where a stalled worker learns it lost the race, if T8
renewal has not already told it.

**T5 — Wake.** The atomic path for a terminal decision taken while the task is
parked or runnable but unclaimed — denial, expiry, cancellation, supersession;
see §7.1.

**T6 — Post-claim refusal.** The unwind path for a verification failure
discovered *after* a claim, when the approval is `executing` and the checkpoint
is `running`; see §6.1.

**T7 — Orphan recovery.** The path for a checkpoint whose approval is missing
or unreadable, which T5 cannot repair; see §7.3.

**T8 — Renew lease.** The whole recovery design rests on leases expiring only
when a claimant has genuinely stopped, so renewal must be specified rather than
assumed. It is fenced by the same epoch as every other write:

```sql
UPDATE task_checkpoints
   SET lease_expires_at=?, updated_at=?
 WHERE task_id=? AND claim_epoch=? AND claimed_by=? AND state='running';
-- changes !== 1  →  this claim is no longer current
```

A renewal that matches zero rows means the runner was superseded — reclaimed
after a stall, or the task was cancelled — and it **must abandon the step
immediately** rather than continue toward a T4 that will also fail. Renewal is
therefore the earliest point a stalled worker can discover it has lost the
claim, which is why the interval matters: it bounds how long a superseded
runner can keep working before it finds out.

The interval must be comfortably shorter than the lease (the existing approval
lease renews at 30s against a 300s lease, `dispatcher.js:233`,
`tools-legacy.js:347`). Renewal failure is not an error to retry.

**T9 — Enter reconciliation.** The atomic transition when the risk gate refuses
to redispatch an ambiguous step; see §8.1.

**T10 — Resolve reconciliation.** The atomic application of a human's
reconciliation decision; see §8.2.

### 6. Reclaim, rehydrate, re-verify

**Ordering matters and was previously left ambiguous.** Verification happens in
two places, and conflating them is what made an earlier revision
self-contradictory — T3 transitions the approval to `executing`, so a
post-claim check for `status = 'approved'` could never pass.

**Stage 1 — inside T3, as claim predicates.** Cheap, indexed conditions that
belong in the `WHERE` clause, so a task that fails them is never claimed at all:

- `approval.status IN ('approved','executing','retry_authorized')` — already in
  T3, and matching its action-claim predicate exactly. `retry_authorized` is
  live and dispatchable (§8.2); omitting it here would refuse the one redispatch
  a human explicitly authorized.
- `approval.task_id = checkpoint.task_id`
- `checkpoint.state` is claimable (`runnable`, or `running` with an expired lease)

**Stage 2 — after the claim, before dispatch.** Everything requiring decryption
or plan traversal, which cannot be expressed in SQL. The approval is `executing`
and the checkpoint is `running` while these run, so a failure must *unwind* the
claim (§6.1) rather than simply decline it:

| Check | Refusal outcome |
|---|---|
| `approval.expires_at > now` | `approval_expired` |
| `approval.status` is still `executing` and was not cancelled mid-claim | `approval_cancelled` |
| `approval.plan_version = checkpoint.plan_version` | `plan_superseded` |
| `checkpoint.plan_digest` verifies against the decrypted plan | `checkpoint_corrupt` |
| `approval.step_id` exists in the decrypted plan | `step_not_in_plan` |
| `approval.args_digest = digest(step.arguments)` recomputed from the decrypted plan | `arguments_altered` |
| task not cancelled | `task_cancelled` |

**The result-ledger check is not one of these.** It is a short-circuit, not a
refusal, and the earlier revision stated it backwards. Correctly:

- **A `task_step_results` row exists** for this `(task_id, step_id,
  plan_version)` → the step's outcome is **already recorded**. Skip dispatch,
  return the stored result, and proceed to the next step. This is the safe,
  common recovery case.
- **No row exists** → the step is either undispatched or fell in the ambiguous
  window (§8). Dispatch is permitted only subject to the risk gate.

It is evaluated first, before the refusal checks: a step already recorded needs
no re-verification, because it will not be dispatched.

The `args_digest` check recomputes the digest from the persisted plan rather
than trusting the stored value, so an approval can only execute the arguments a
human actually saw. This is the same integrity idea already applied to the
encrypted payload at `tools-legacy.js:479`, extended to the plan.

### 6.1 Post-claim refusal (T6)

A Stage-2 failure leaves the approval `executing` and the checkpoint `running`
under this runner's epoch. Both must be unwound atomically, or the task is
stranded mid-claim with an approval that can never be consumed:

```sql
-- 1. terminalise the approval, through the binding
UPDATE approvals
   SET status=?, error_code=?, error_detail_encrypted=?,
       terminalized_by=?, terminalized_at=?, updated_at=?
 WHERE approval_id=? AND status='executing' AND <bound>;
-- changes must be exactly 1, else ROLLBACK
-- terminalized_by is the runner that refused it (a system actor is correct
-- here); approver_identity and decided_at are untouched, per §4.1.

-- 2. record the refusal against the step
INSERT INTO task_step_results
  (task_id, step_id, plan_version, args_digest, idempotency_key,
   status, outcome_code, error_detail_encrypted, approval_id, recorded_at)
VALUES (?,?,?,?,?, 'refused', ?, ?, ?, ?)
ON CONFLICT(task_id, step_id, plan_version) DO NOTHING;
-- zero rows → authoritative re-read and full field comparison per §7.1

-- 3. release the claim, clear the binding, and wake the task
UPDATE task_checkpoints
   SET state='runnable', claimed_by=NULL, lease_expires_at=NULL, updated_at=?,
       current_approval_id=NULL, current_step_id=NULL,
       current_args_digest=NULL, current_idempotency_key=NULL
 WHERE task_id=? AND claim_epoch=? AND claimed_by=? AND state='running';
-- changes must be exactly 1, else ROLLBACK
```

The whole binding is cleared, as in T4 — the step has reached a terminal
outcome, so the checkpoint must stop claiming to be parked on it. The task
therefore wakes via a **resume claim** (T3), which is exactly why that mode
exists.

The resulting status is the refusal outcome from the Stage-2 table
(`expired`, `cancelled`, `superseded`). The checkpoint returns to `runnable`
rather than a terminal state because the *task* is not finished — the planner
resumes, reads the refused step outcome, and decides what to do (§7).

`task_cancelled` is the exception: the task is terminal, so step 3 sets
`state='cancelled'` instead of `runnable`.

`checkpoint_corrupt` is also different in kind — the plan cannot be trusted, so
there is nothing to resume into. It terminalises the task as `failed` with a
distinguishable reason rather than waking it.

### 7. Denial, expiry, and cancellation are step outcomes

Each becomes a structured result recorded against the step and returned to the
planner — the same shape a tool error takes today (`brain.js:175`), so no new
handling path is introduced:

```json
{ "type": "tool", "id": "s2", "tool": "bash",
  "ok": false, "outcome": "approval_denied",
  "approval_id": "approval_…", "detail": "denied by <identity>" }
```

The planner may explain the outcome or select a materially different route. It
may **not** re-request approval for the same action: the derived key already
exists and collides with the authoritative unique index in §4.1(a). A genuinely
different route produces a different `args_digest` or `plan_version` and is
permitted. This makes the anti-loop protection a storage invariant rather than a
prompt instruction.

### 7.1 Wake-up is atomic (T5)

A terminal decision that is not an approval must do two things together:
persist the structured step outcome, and make the checkpoint runnable so the
task actually resumes and observes it. Doing only the first strands the task in
`waiting_for_approval` forever; doing only the second resumes a task that cannot
tell why. Both are one transaction, and **both statements must affect exactly
one row or the transaction rolls back**:

```sql
-- 0. authoritative re-read INSIDE the transaction; the pair is derived from
--    the observed approval status, never from the caller's belief.
SELECT status FROM approvals WHERE approval_id=? AND <bound>;
-- absent → this is not the bound approval, or it is gone: ROLLBACK and
--          hand off to T7 (§7.3). Do NOT proceed.

-- 1. terminalise the approval, pinned to the exact observed prior state.
--    approver_identity and decided_at are NOT touched: if this approval was
--    ever approved (the cancel/supersede-from-`approved` case), that
--    authorization stands as a historical fact. The actor who terminalised it
--    is a different act and gets its own columns.
UPDATE approvals
   SET status=?, terminalized_by=?, terminalized_at=?, error_code=?, updated_at=?
 WHERE approval_id=? AND status=<observed prior state> AND <bound>;
-- changes must be exactly 1, else ROLLBACK

-- 2. record the outcome against the step, idempotently
INSERT INTO task_step_results
  (task_id, step_id, plan_version, args_digest, idempotency_key,
   status, outcome_code, approval_id, recorded_at)
VALUES (?,?,?,?,?, 'refused', ?, ?, ?)
ON CONFLICT(task_id, step_id, plan_version) DO NOTHING;
-- see "conflicts are not automatically benign" below

-- 3. wake the task, pinned to the state PAIRED with the observed approval
--    status, clearing the whole binding (the step is terminally refused)
UPDATE task_checkpoints
   SET state='runnable', updated_at=?,
       current_approval_id=NULL, current_step_id=NULL,
       current_args_digest=NULL, current_idempotency_key=NULL
 WHERE task_id=? AND state=<paired checkpoint state>;
-- changes must be exactly 1, else ROLLBACK
```

The woken task is picked up by a **resume claim** (T3): the binding is gone and
the outcome is already durable, so there is no approval to transition.

**Exact pairs, not independent sets.** An earlier revision listed permitted
approval states and permitted checkpoint states separately, which allows
combinations that cannot legitimately occur — cancelling a `pending` approval
whose checkpoint is somehow already `runnable` would have been accepted, papering
over a real inconsistency. T2 moves both rows together, so the states are
correlated and the transaction pins the matching pair:

| Observed approval status | Required checkpoint state |
|---|---|
| `pending` | `waiting_for_approval` |
| `approved` | `runnable` |
| `retry_authorized` | `runnable` |

`retry_authorized` pairs with `runnable` for exactly the same reason `approved`
does: T10's `confirm_not_executed` leaves the task runnable with a live,
dispatchable authorization it has not yet claimed. It is an
approved-but-unclaimed authorization in every respect that matters to terminal
controls, and is treated as one.

Any other combination is an integrity failure: roll back and route to T7, which
is the path for a checkpoint whose binding no longer makes sense.

| Trigger | Permitted observed states | Resulting status | Step outcome |
|---|---|---|---|
| Human denial | `pending` | `denied` | `approval_denied` |
| Expiry | `pending`, `retry_authorized` | `expired` | `approval_expired` |
| Approval cancellation | `pending`, `approved`, `retry_authorized` | `cancelled` | `approval_cancelled` |
| Plan superseded | `pending`, `approved`, `retry_authorized` | `superseded` | `plan_superseded` |

**A retry authorization is revocable and does expire.** It is a live grant that
happens not to have been claimed yet, so leaving it outside these controls would
make it the one authorization in the system a human could not withdraw and that
never lapsed — permanently valid purely because the runner had not got to it.
Denial is the exception: an action already reconciled has been decided, and
"deny" is not a coherent second verdict on it; cancellation is the correct
instrument.

The trigger constrains which prior states are legal; the pair table then fixes
the checkpoint state that must accompany the one observed.

**Conflicts are not automatically benign.** `ON CONFLICT DO NOTHING` returning
zero rows means *a* row already exists for this `(task_id, step_id,
plan_version)` — not that it is *the same* row. An earlier revision treated any
conflict as a harmless race, which would silently accept a contradictory
outcome, for example a step recorded as `completed` by a live runner while a
sweeper concurrently records it `refused`.

On a zero-row insert the transaction MUST re-read the existing row and verify
it agrees on **all** of:

- `idempotency_key`
- `approval_id`
- the action binding: `args_digest` (with `task_id`/`step_id`/`plan_version`
  already fixed by the conflict target)
- `status`
- `outcome_code`

If every field matches, the write is a true duplicate and the transaction
proceeds — this is the genuine benign race. If **any** field differs, it is an
integrity failure: **roll back**, record an `approval_execution_recovery_events`
entry with `reconciliation_status='manual_review'`, and do not wake the task
into a state contradicted by its own ledger. The same rule applies to the
inserts in T6 and T7.

Cancellation of an *approved* approval is permitted — a human may revoke an
authorization before the runner claims it. Cancelling one already `executing`
is refused here: the step is in flight, the checkpoint is `running` under a
live epoch, and T5's `runnable` transition would corrupt that claim. The
correct control at that point is task cancellation, which the runner observes
in its Stage-2 checks and unwinds through T6.

**Task cancellation** is distinct: it terminalises the task rather than waking
it, so it sets `state='cancelled'` instead of `runnable` and terminalises any
live approval bound to it in the same transaction.

### 7.2 Expiry is correctness-critical, not a background nicety

Expiry today is **lazy and best-effort** — `expireApprovals`
(`src/tools-legacy.js:422-470`) runs only inside `listApprovals`,
`resolveApproval`, and `claimApprovalExecution`. Nothing schedules it. An
approval that nobody lists or resolves never expires.

That is tolerable when an unexpired approval merely sits in a queue. It is
**not** tolerable once a task's liveness depends on it: a parked task whose
approval silently passed its expiry would wait forever, because the only thing
that could wake it is the expiry it never processed. Expiry therefore becomes
part of the correctness argument, and the design requires three things:

1. **A scheduled sweeper**, not a lazy one. It selects
   `status IN ('pending','retry_authorized') AND expires_at < now` — the exact
   query `idx_approvals_status_expiry` exists to serve — and runs T5 for each.
   `retry_authorized` is included because T10 refreshes `expires_at` when it
   grants a retry; that fresh window is meaningless unless something enforces
   it. Its
   interval bounds how long a task can wait past its approval's expiry, so the
   interval is a correctness parameter, not a tuning knob. It must be a
   deployed, monitored job; the fact that `recoverStaleApprovals`
   (`:682-701`) is exported but has **zero production callers** is the failure
   mode to avoid repeating.
2. **Expiry is also evaluated at claim time.** The runner re-checks
   `expires_at` in §6 before executing, so an approval that expired between the
   sweep and the claim is still refused. The sweeper bounds latency; the claim
   check enforces the rule. Neither alone is sufficient.
3. **A liveness check independent of approvals**, resolved through the orphan
   path in §7.3 — not through T5, which cannot repair these cases.

The checkpoint's own `deadline_at` remains the outer bound: a task parked past
its deadline is failed with `timed_out`, whatever its approval says.

### 7.3 Orphan recovery (T7)

T5 cannot repair a checkpoint whose approval is **missing or unreadable**,
because its first statement — the approval `UPDATE` — matches zero rows and
rolls the transaction back. Every trigger in §7.1 presumes an approval row
exists to terminalise. A task in this state would be swept repeatedly, fail
identically every time, and never wake.

This is a distinct path with its own outcome, deliberately **not** disguised as
expiry. Calling a missing approval "expired" would record a false operational
history: an operator reading it would conclude a human ran out of time, when in
fact the authorization record was lost.

Detected by the sweeper as a checkpoint in `waiting_for_approval` or `runnable`
where any of the following holds:

- no `approvals` row matches the checkpoint's bound approval id
- the row exists but its payload fails to decrypt or its `args_digest` does not
  verify (the integrity check at `tools-legacy.js:479`, applied here)
- the row exists in a terminal state with no `task_step_results` row for the
  step — a wake-up that committed the approval half and lost the rest

**T7 constructs its result row entirely from the checkpoint.** This is why the
binding fields in §4.2 exist: `current_step_id`, `current_args_digest`,
`current_idempotency_key`, and `plan_version` are all on the checkpoint, so a
result row can be written when the approval is unreadable or gone. Reading them
from the approval — as every other transaction does — is exactly what is
impossible here, and an earlier revision left T7 with no source for them.

```sql
-- 1. record the orphan outcome against the step, from checkpoint metadata only
INSERT INTO task_step_results
  (task_id, step_id, plan_version, args_digest, idempotency_key,
   status, outcome_code, approval_id, recorded_at)
SELECT task_id, current_step_id, plan_version, current_args_digest,
       current_idempotency_key, 'refused', 'approval_missing_or_corrupt',
       current_approval_id, ?
  FROM task_checkpoints WHERE task_id=?
ON CONFLICT(task_id, step_id, plan_version) DO NOTHING;
-- zero rows → apply the same authoritative re-read and field comparison as
-- §7.1; a differing existing row is an integrity failure, not a benign race

-- 2. CORRUPT-ROW BRANCH ONLY: quarantine the unreadable approval so it stops
--    occupying this task's live-approval slot. Omitted when the row is absent.
UPDATE approvals
   SET status='quarantined', error_code='payload_unreadable',
       terminalized_by=?, terminalized_at=?, updated_at=?
 WHERE approval_id=? AND task_id=?
   AND status IN ('pending','approved','executing',
                  'reconciliation_required','retry_authorized');
-- changes must be exactly 1 in this branch, else ROLLBACK

-- 3. wake the task, clearing the whole binding
UPDATE task_checkpoints
   SET state='runnable', updated_at=?,
       current_approval_id=NULL, current_step_id=NULL,
       current_args_digest=NULL, current_idempotency_key=NULL
 WHERE task_id=? AND state IN ('waiting_for_approval','runnable');
-- changes must be exactly 1, else ROLLBACK

-- 4. audit
INSERT INTO approval_execution_recovery_events
  (id, approval_id, event_type, reconciliation_status, reason_code, created_at)
VALUES (?,?, 'orphaned_checkpoint', 'manual_review', ?, ?);
```

**Two branches, distinguished before anything is written:**

| Condition | Branch | Approval statement |
|---|---|---|
| No `approvals` row for the bound id | **missing** | none — there is nothing to update |
| Row exists but fails to decrypt or its `args_digest` does not verify | **corrupt** | quarantine it (statement 2) |
| Row exists, terminal, but no result row for the step | **half-woken** | none — the approval is already terminal |

The corrupt branch **must** run statement 2. A row that cannot be read is still
a row, and `pending`/`approved`/`executing`/`reconciliation_required` are all in
`idx_approvals_one_live_per_task` — leaving it live would permanently block every
future approval for that task, converting a recoverable corruption into a task
that can never request authorization again. `quarantined` is deliberately outside
the live set so the slot is released, while the row is retained for audit rather
than deleted.

A checkpoint whose *binding fields* are themselves NULL cannot construct a
result row and is unrecoverable: it is failed with `checkpoint_corrupt` and
audited, rather than woken into a plan step whose identity is unknown.

There is **no approval UPDATE in the missing branch**, which is precisely what
makes this path work where T5 cannot. The step outcome is `approval_missing_or_corrupt`, distinct
from `approval_expired`, and the planner treats it as a refusal it may not
retry with the same action.

An orphaned high-risk action is never silently re-requested: the derived key of
the original approval may still exist in the unique index, so a replan must
produce a materially different action, exactly as for a denial. If the approval
row is genuinely gone the key is gone with it and a re-request is possible —
which is why step 3 records the event for manual review rather than treating
recovery as routine.

### 8. Failure cases

**Concurrent workers.** The agent is single-process today (`src/agent.js`, no
`cluster`/`worker_threads`; liveness is an in-memory object at `:1250`), but
the claim in §5/T3 is written so that assumption is not load-bearing. Two
runners racing a runnable checkpoint: one gets `changes === 1`, the other
`changes === 0` and stops. Correctness rests on `BEGIN IMMEDIATE` and the
`WHERE state='runnable'` predicate, not on there being one process.

**Duplicate approval submission.** Two approvals of the same id: T2's
`WHERE status='pending'` makes the second a no-op with `changes === 0`, and the
caller is told it was already decided. Two *queue* attempts for the same action:
the derived `idempotency_key` and the partial unique index reject the second.

**Stale plan version.** A task that replanned has a checkpoint whose
`plan_version` no longer matches the approval. `plan_superseded` — the approval
is marked `superseded` and the step outcome is recorded. The human authorized an
action in a plan that no longer exists; executing it would be executing
something nobody approved.

**Altered arguments.** Caught by recomputing `args_digest` from the persisted
plan (§6). Distinct from `plan_superseded`: the plan may be identical while a
step's arguments differ, and this is the case most worth failing loudly.

**Expired approvals.** `expires_at` is already materialised at creation
(`tools-legacy.js:342-345`, default 3600s), but expiry is **lazy** — it runs
only inside `listApprovals`, `resolveApproval`, and `claimApprovalExecution`,
so an approval nobody looks at never expires. With a real table, expiry becomes
a predicate (`status='pending' AND expires_at < now`) evaluated at claim time
and by a sweeper, and correctness no longer depends on someone having looked.

**Crash points.** Enumerated, with the recovery for each:

| Crash point | State on disk | Recovery |
|---|---|---|
| before T1 commits | nothing | task is simply lost; no approval was shown to a human |
| after T1, before approval | checkpoint `waiting_for_approval` + pending approval | resumes normally when a human decides |
| after T2, before claim | checkpoint `runnable` | any runner claims it; lease was never taken |
| after claim, before dispatch | `running`, lease expired, **no result row** | reclaimed by T3, then **risk-gated** — indistinguishable from the row below |
| after dispatch, before T4 | `running`, lease expired, **no result row** | reclaimed by T3, then **risk-gated** |
| after T4 | result recorded | the stored result is returned; no redispatch |

**The two middle rows are byte-for-byte identical in storage.** Both present as
`running` with an expired lease and no result row; nothing durable records
whether the dispatch call was reached. An earlier revision described the first
as "safe to redispatch at any risk level", which is only true of the *intent*
and not of anything an observer can determine. Since they cannot be told apart,
**both receive the risk gate** — a high-risk tool is never redispatched on the
assumption that it probably had not run yet.

Recording an explicit pre-dispatch intent marker would separate them, at the
cost of an extra durable write per step. It is deliberately not proposed: it
narrows the window without closing it (the crash can land between the marker and
the call), and it would encourage treating the narrowed case as safe when it is
the same ambiguity.

**The ambiguous window is real and cannot be closed in general.** Between the
tool returning and T4 committing, a crash leaves no record that the effect
happened. This is the same problem the existing approval-recovery code already
confronts: `approvalNeedsManualReconciliation` (`tools-legacy.js:371-374`)
forces manual reconciliation for `high`/`critical`/unclassified risk and allows
auto-retry only for `low`/`medium`. This ADR adopts that rule rather than
inventing a second one:

- **low/medium risk** — re-execute on reclaim. At-least-once.
- **high/critical/unknown risk** — do not re-execute. Mark the step
  `reconciliation_required`, park the task, surface it. At-most-once.

An `approval_execution_recovery_events` table already exists for exactly this
audit trail (`migrations/021_approval_execution_recovery.sql`), though its
writer swallows all errors (`tools-legacy.js:419`) and `recoverStaleApprovals`
has no production caller — both worth fixing when this is implemented.

**What is actually guaranteed.** An earlier draft of this ADR claimed
"exactly-once dispatch". That was wrong, and the contradiction is worth stating
plainly because it is easy to reintroduce: the low/medium recovery rule above
*permits redispatch* after the ambiguous window, so dispatch cannot be
exactly-once. The unique index prevents a *duplicate authorization record*; it
does not prevent a second dispatch of the same authorized action after a crash,
because the recovery rule deliberately allows one.

The real guarantee has two parts, and neither is "exactly once":

1. **Single concurrent claimant *of record*.** At most one runner holds the
   claim in the database at any moment, enforced by the conditional transition
   in §5/T3.

   **This is not the same as "no concurrent execution", and an earlier revision
   conflated them.** A lease expires on wall-clock time; it does not stop the
   original worker. A runner that stalls — GC pause, blocked syscall, suspended
   VM — past its lease expiry can be reclaimed by a second runner and then wake
   up and continue dispatching, believing itself still the owner. Nothing in a
   lease alone prevents that.

   Three mitigations, in increasing strength:

   - **Deployment reality.** The agent is single-process today (`src/agent.js`,
     no `cluster`/`worker_threads`), so there is no second runner to reclaim.
     The race is currently unreachable, and the honest scope of the guarantee
     today is *within one process*.
   - **Write fencing** (specified, §5/T3–T4–T6). `claim_epoch` increments on
     every claim, and every subsequent write is conditioned on it. A stale
     worker's T4 matches zero rows, so it **cannot record a result, advance the
     checkpoint, or terminalise the approval**. Its work is discarded rather
     than corrupting the current claim. This is enforceable with the storage
     described and requires no new infrastructure.
   - **Effect fencing** — preventing the stale worker from *dispatching the
     tool at all* — is **not** provided. It would require either a
     runner-side lease check that is itself racy, or cooperation from the tool
     boundary, which does not exist.

   So the precise guarantee is: **one claimant of record, write-fenced against
   stale claimants, with effect-level concurrency prevented today only by the
   single-process deployment.** A future multi-process runner would inherit an
   at-least-once-under-stall risk for low/medium tools, and the high/critical
   gate below is what keeps that from mattering where it would.
2. **Risk-dependent recovery** after a claimant dies in the ambiguous window:
   - **low / medium risk → at-least-once.** The step may be dispatched again.
     Callers must treat these tools as retryable.
   - **high / critical / unknown risk → at-most-once.** The step is never
     redispatched automatically; the task parks with
     `reconciliation_status='manual_review'` and a human decides.

So the system is at-least-once for low-risk work and at-most-once for high-risk
work, with **one claimant of record and write fencing — not an absence of
concurrent effects**. An earlier revision said "never concurrent"; that was
wrong for the same reason the exactly-once claim was, and is corrected here.
Two runners can overlap in effect while only one can overlap in state.

Exactly-once effects are not achievable at this boundary at all: the tool
interface offers no way to ask "did my earlier call land?", and no amount of
bookkeeping on our side can synthesise that answer. The risk gate converts an
unavoidable ambiguity into an explicit, auditable operator decision instead of a
silent double-execution.

`task_step_results` is what makes this decidable rather than guesswork: a
recorded outcome proves the step completed and is returned instead of
redispatching. Its absence is precisely the ambiguous case, and the risk gate
resolves it.

### 8.1 Entering reconciliation (T9)

When the risk gate refuses to redispatch, the task must land somewhere durable
and inert. It cannot stay `running` (nothing holds it), and it must not go back
to `runnable` (the next sweep would re-claim it and refuse again, forever).

A distinct checkpoint state, `reconciling`, is the parking place. The runner
that reclaimed the ambiguous step performs T9 under its own epoch:

```sql
UPDATE task_checkpoints
   SET state='reconciling', claimed_by=NULL, lease_expires_at=NULL, updated_at=?
 WHERE task_id=? AND claim_epoch=? AND state='running';
-- changes must be exactly 1, else ROLLBACK

UPDATE approvals
   SET reconciliation_status='manual_review', status='reconciliation_required',
       error_code='ambiguous_execution', updated_at=?
 WHERE approval_id=? AND status='executing' AND <bound>;
-- changes must be exactly 1, else ROLLBACK

-- operation_id / executor_id name the PRIOR attempt — the one that may have
-- executed — taken from the checkpoint's prior_* columns, NOT from the
-- recovery claimant. recovery_executor_id records who discovered it.
INSERT INTO approval_execution_recovery_events
  (id, approval_id, operation_id, executor_id, recovery_executor_id,
   prior_claim_epoch, prior_attempt_count, event_type,
   reconciliation_status, reason_code, reason_detail_encrypted, created_at)
VALUES (?,?, <prior_operation_id>, <prior_claimed_by>, <recovery claimant>,
        <prior_claim_epoch>, <prior_attempt_count>,
        'ambiguous_execution', 'manual_review', 'ambiguous_execution', ?, ?);
```

`recovery_executor_id`, `prior_claim_epoch`, and `prior_attempt_count` are added
to `approval_execution_recovery_events` by migration `025_`, alongside
`reason_code` and `reason_detail_encrypted` (§4.4). The existing
`operation_id`/`executor_id` columns keep their natural meaning — the execution
being reconciled — and are populated from the prior attempt.

An operator investigating an ambiguous high-risk execution needs to know which
process, under which epoch and attempt, might have run the tool. Naming the
recovery claimant there would point at a runner that provably did not dispatch
anything.

The event carries `reason_code` from the closed vocabulary and, where a human
needs more, `reason_detail_encrypted` — never the legacy free-form `reason`
column, which §4.4 forbids new code from writing.

No `task_step_results` row is written: whether the step succeeded is precisely
what is unknown, and recording either outcome would be a fabrication. The
absence of the row is the record that the question is open.

`reconciling` is terminal for automated processing. The expiry sweeper, the
claim query, and the orphan detector all exclude it. Only a human decision
(T10) or the task deadline moves it.

### 8.2 Resolving reconciliation (T10)

Exactly four decisions are permitted. Each records an outcome and moves the
task; none leaves it in `reconciling`.

| Decision | Meaning | Approval status | Step outcome | Checkpoint |
|---|---|---|---|---|
| `confirm_executed` | the effect landed | `completed` | `completed`, `outcome_code='reconciled_executed'` | `runnable`, binding cleared |
| `confirm_not_executed` | the effect did not land | **`retry_authorized`** with a fresh `expires_at` | none — deliberately absent | `runnable`, **binding retained** |
| `abandon_step` | unknown, not worth resolving | `superseded` | `refused`, `outcome_code='reconciliation_abandoned'` | `runnable`, binding cleared |
| `fail_task` | unsafe to continue | `superseded` | `refused`, `outcome_code='reconciliation_failed'` | `failed`, binding cleared |

**Order matters, and revision 4 had it wrong.** It cleared
`current_approval_id` first and then updated the approval through `<bound>` —
which by then resolved to NULL, so the approval update matched zero rows and
every binding-clearing decision rolled back. The approval must be updated and
verified *through the still-intact binding*, and the binding cleared last:

```sql
-- 1. terminalise or re-authorize the approval, THROUGH the intact binding.
--    approver_identity is NOT touched: the original authorization stands.
UPDATE approvals
   SET status=?,                       -- see table; retry_authorized for confirm_not_executed
       expires_at=?,                   -- refreshed ONLY for retry_authorized
       reconciliation_status='resolved',
       reconciled_by=?, reconciled_at=?, reconciliation_decision=?,
       updated_at=?
 WHERE approval_id=? AND status='reconciliation_required' AND <bound>;
-- changes must be exactly 1, else ROLLBACK

-- 2. record the step outcome (OMITTED for confirm_not_executed)
INSERT INTO task_step_results (...) VALUES (...)
ON CONFLICT(task_id, step_id, plan_version) DO NOTHING;
-- zero rows → authoritative re-read and full field comparison per §7.1

-- 3. move the checkpoint and clear the binding LAST.
--    confirm_not_executed retains all four current_* fields; every other
--    decision clears all four together.
UPDATE task_checkpoints
   SET state=?, updated_at=?
       <, current_approval_id=NULL, current_step_id=NULL,
          current_args_digest=NULL, current_idempotency_key=NULL
        — omitted for confirm_not_executed >
 WHERE task_id=? AND state='reconciling';
-- changes must be exactly 1, else ROLLBACK

-- 4. audit
INSERT INTO approval_execution_recovery_events
  (id, approval_id, event_type, reconciliation_status, reason_code, created_at)
VALUES (?,?, 'reconciliation_resolved', 'resolved', ?, ?);
```

**`confirm_not_executed` must leave a dispatchable authorization.** Revision 4
left the approval terminal while telling the runner it could redispatch — a
contradiction: T3's action claim requires `approved`/`executing`/
`retry_authorized`, so a terminal approval would have made the retained binding
unusable and stranded the task again. The decision therefore moves the approval
to **`retry_authorized`** with a **fresh expiry window**, because the original
window has almost certainly lapsed during human deliberation and an expired
authorization would be refused at §6 Stage 2 the moment it was reclaimed.

`retry_authorized` is a live status (§4.2 index) and is accepted by T3's action
claim, so the task resumes exactly as if it had never been claimed.

**Identity is split, not overwritten.** `approver_identity` records who granted
the original authorization and is never modified; `reconciled_by`,
`reconciled_at`, and `reconciliation_decision` record the separate act of
resolving the ambiguity. These are frequently different people, and collapsing
them would destroy the audit trail precisely where it matters most.

`confirm_not_executed` remains the most dangerous decision: asserting an effect
did not happen when it did produces exactly the double-execution the gate
exists to prevent. It is audited but not verifiable.

**Authorization, not merely attribution.** A reconciliation decision resolves a
high-risk ambiguity and must be made by an **authenticated human holding an
explicit reconciliation permission**. Specifically:

- The planner, the task runner, a tool, or any automated actor **must not**
  resolve an ambiguity — least of all its own. `source='agent'` is never a
  valid `reconciled_by`.
- The requester of the original action should not be its sole reconciler where
  the deployment can distinguish identities, for the same separation-of-duties
  reason the approval existed at all.
- `reconciled_by` must be a real principal, not a surface name. The current
  approval path hardcodes `reviewer` to `"dashboard"`
  (`src/dashboard.js:1679`), which is unusable here: a reconciliation attributed
  to "dashboard" is indistinguishable from an unattributed one.

The precise role model is **provisional** — Sidekick has no permission system
to bind to today, and inventing one here would exceed this ADR's scope. What is
not provisional is that the check must exist, must reject automated actors, and
must record a real identity. An implementation that cannot yet enforce a
permission must fail closed and leave the task in `reconciling` rather than
accept an unauthorized resolution.

If the task's `deadline_at` passes while `reconciling`, it is failed with
`timed_out` and the approval left `reconciliation_required` for audit. A
deadline must not silently resolve an ambiguity.

### 9. Invariants versus provisional choices

**Required invariants.** Any implementation must satisfy these; they are the
contract this ADR establishes.

- **I1.** A **task-originated** approval names exactly one `(task_id, step_id,
  plan_version, tool_name, args_digest)`, that binding is durable and immutable,
  and the checkpoint independently records which approval is live
  (`current_approval_id`) so the relationship is verifiable from both ends.
  Standalone approvals carry no such binding by construction (§3) and are
  identified by `approval_id` alone.
- **I2.** Marking an approval approved and making its task runnable is one
  atomic act. Neither is observable without the other.
- **I3.** Only the task runner executes plan steps. The approval pipeline
  transitions state; it does not dispatch task-originated tools.
- **I4.** At most one claimant *of record* holds a step at any moment, and a
  superseded claimant's writes are rejected by the fencing epoch. Concurrent
  *effects* are **not** excluded: a stalled runner may still be executing after
  its lease is reclaimed. After a claimant dies or stalls in the ambiguous
  window (§8), redispatch is **risk-gated** — permitted for low/medium risk
  (at-least-once) and forbidden for high/critical/unknown risk (at-most-once,
  manual reconciliation per §8.1–8.2). This is deliberately neither an
  exactly-once nor a non-concurrency claim; a step with a recorded outcome in
  `task_step_results` is never redispatched, but a step without one may be.
- **I5.** Before executing an approved step, the runner re-verifies status,
  expiry, plan version, step membership, and argument digest against the
  persisted plan. Any mismatch refuses execution.
- **I6.** Denial, expiry, supersession, and cancellation are structured step
  outcomes visible to the planner, never silent drops and never task crashes.
- **I7.** A pending approval is never silently discarded. (Today's
  `slice(0, 500)` violates this outright.)
- **I8.** At most one claimant *of record* holds a task at a time, enforced by
  a conditional state transition; and every write by a claimant is fenced by
  its `claim_epoch`, so a superseded claimant cannot record a result, advance a
  checkpoint, or terminalise an approval. Effect-level exclusion is **not**
  claimed (§8).
- **I9.** A suspended task's plan and progress are durable enough to rehydrate
  after process restart without consulting any in-memory state.
- **I10.** A terminal decision that is not an approval — denial, expiry,
  cancellation, supersession, orphaning, or a post-claim refusal — atomically
  records the structured step outcome **and** returns the task to a runnable or
  terminal state. Neither happens without the other, so a task can neither be
  stranded waiting nor resumed without knowing why. Each trigger declares the
  checkpoint states it expects (§7.1); a mismatch rolls back rather than
  half-applying.
- **I11.** A task parked on an approval is guaranteed to be woken: by decision,
  by a scheduled expiry sweep, or by its own deadline. Liveness does not depend
  on anyone happening to read the approval queue.
- **I12.** No column stores plaintext or partially-redacted tool arguments,
  plan step arguments, or tool results — including previews. Identity and
  integrity are exposed as digests and counters; content exists only as
  ciphertext, and any human-readable rendering is produced on demand from a
  decrypted payload for an authorized reader.
- **I13.** An approval record is never destroyed as a side effect of task or
  checkpoint cleanup, and its `task_id` correlation is never blanked.
- **I14.** A checkpoint whose approval is missing or unreadable is recoverable
  through a path that does not require an approval row to exist, and its outcome
  is distinguishable from expiry (§7.3).
- **I15.** An ambiguous execution of a high/critical/unknown-risk tool parks in
  a state no automated process will resume (`reconciling`), records no step
  outcome — because the outcome is genuinely unknown — and leaves it only by an
  attributed human decision or the task deadline. A deadline never resolves the
  ambiguity; it fails the task with the question still open (§8.1–8.2).
- **I16.** Every write performed by a claimant is conditioned on its
  `claim_epoch`, including lease renewal, so a superseded claimant discovers it
  has lost the claim at its next write and cannot advance any state.
- **I17.** A task made runnable by any path is claimable. A claim that requires
  a live approval is used only where one exists; a task woken by denial,
  expiry, orphan recovery, post-claim refusal, or a recorded result is claimed
  without reference to an approval (§5/T3). No wake-up may produce a state that
  nothing can claim.
- **I18.** The four `current_*` binding fields are written together and cleared
  together. A checkpoint never carries a partial binding, because orphan
  recovery constructs a result row from those fields and a stale subset would
  let it fabricate an outcome for a step that already finished.
- **I19.** Resolving an ambiguous execution requires an authenticated human
  with explicit reconciliation permission; no automated actor may resolve one,
  and the original approver identity is preserved separately from both the
  reconciling identity and the identity that terminalised an approval.
- **I20.** The risk gate applies only where ambiguity actually exists. A step
  being dispatched for the first time under a fresh authorization is never
  gated; only a reclaim of an action a previous claimant already held is. The
  discriminator is the approval's own pre-claim status, never a counter that
  also advances for unrelated claims (§5/T3).
- **I21.** A resume never writes a step outcome. It consumes the recorded one,
  verifies it belongs to the bound action, and advances; only an action claim
  that actually dispatched may record a result (§5/T4A vs T4R).
- **I22.** `next_step_id` is the durable resume cursor and is independent of the
  binding. It is set at park, left untouched by every wake and refusal path, and
  advanced only after an outcome has been consumed — so a woken task can always
  locate its own recorded result even though the binding has been cleared.
- **I23.** A recorded step outcome and a live approval for that same action
  never coexist. Recording a result and terminalising its approval are atomic
  in every path that does both; observing the combination means an invariant
  has already failed, and it is routed to recovery rather than resolved
  in-line.
- **I24.** A live authorization remains revocable and expiring for as long as it
  is live. `retry_authorized` is subject to cancellation, supersession, and the
  scheduled expiry sweep exactly as `approved` is.
- **I25.** When a stale claim is reclaimed, the prior attempt's operation id,
  claimant, epoch, and attempt number are captured durably before being
  overwritten, so a reconciliation event identifies the attempt that may have
  executed rather than the one that discovered the ambiguity.

**Provisional.** Reasonable implementation may change these without
renegotiating the ADR: table and column names; SQLite types and defaults;
whether checkpoint and step results are two tables or one; the digest algorithm
(SHA-256 chosen to match `approvalArgsHash`); lease durations and their env
overrides; **the sweeper's interval** — though not its existence, which is
required by I11, and the interval remains an upper bound on how long a task can
wait past its approval's expiry; the cipher and key management behind §4.4;
whether the encrypted plan lives in a column or a `platform_artifacts`
reference; whether the foreign key is `RESTRICT` or omitted in favour of an
application-enforced retention order (§4.5); whether the legacy JSON approvals
document is migrated or read through a compatibility shim during transition.

Note the boundary carefully: *that* expiry is processed on a schedule is an
invariant, because task liveness depends on it. *How often* is a tunable.

### 10. Explicitly out of scope

- **Continuous checkpointing.** Checkpoints are written at park points only.
  Resuming a task that crashed mid-plan without an approval is a superset
  problem and would change the write frequency substantially.
- **Multi-process task execution.** The claim is designed not to assume a
  single process, but no worker pool is proposed.
- **Migrating historical approvals.** The transition path for the existing
  JSON document is an implementation decision.
- **Reworking `finishAgentExecution`'s mapping of `waiting_for_approval` to
  `failed`** (`src/agent.js:671`). It should become the kernel's real
  `awaiting_approval` state, but that is a small independent fix and should not
  wait on this ADR.

## Alternatives considered

**A. Keep the JSON approvals document, add the binding fields.** Smallest
diff, and rejected. It cannot express a unique constraint, so neither the
idempotency key nor the anti-re-request rule could be enforced — both would
become application checks racing each other under a whole-blob read-modify-write.
The `slice(0, 500)` eviction would still silently destroy pending approvals, and
I7 would be unsatisfiable. The storage shape is the problem, so leaving it
unchanged leaves the problem.

**B. Deliver the result back to the waiting task in memory.** Have the parked
`runBrainTask` await a promise the approval pipeline resolves. This is the
smallest *runtime* change and is rejected because it survives nothing: a restart
loses every parked task, and it hard-codes the single-process assumption that
I8 exists to avoid. It also keeps execution in the approval pipeline, violating
I3.

**C. Event-sourced approvals with no state table.** Append immutable events and
derive current state. Attractive for auditability, rejected because the claim in
§5/T3 needs a conditional update against current state; deriving state per claim
would require either a lock or a materialised projection — which is the state
table, arrived at indirectly. The existing
`approval_execution_recovery_events` table already covers the audit need
alongside a state table.

**D. Reuse `compute_jobs` as the queue for approved steps.** The lease/claim
machinery is already proven there. Rejected because the lifecycles differ — a
compute job is a unit of work dispatched to a remote worker, while a parked task
is a suspended local execution with accumulated evidence — and conflating them
would couple Brain resumption to compute worker availability. The *pattern* is
reused (§5/T3); the table is not.

**E. Store the plan in the transcript JSON rather than a table.** No new table.
Rejected because the transcript is written once, at the end of `runAgent`
(`src/agent.js:1046`), so a parked task has no transcript to read; it is a file
rather than a queryable store, so the runnable-task query would be a directory
scan; and it has no transactional relationship with the approval, making T1 and
T2 impossible to make atomic.

**F. Make the approval pipeline call back into a task-resume entry point.**
Keeps execution nominally in the runner but drives it from the approval side.
Rejected as a weaker form of the chosen design: it still needs the same durable
binding and checkpoint to work after a restart, and inverting the control
direction means the approval pipeline decides when a task runs, which
reintroduces the coupling I3 removes.

## Consequences

- Approvals become a real table with enforceable constraints. Duplicate
  submissions, repeated requests for an unchanged action, and silent eviction of
  a pending approval become impossible rather than merely unlikely.
- A parked task survives a restart. Today the process holds the only copy of the
  plan.
- Approved steps and ordinary steps share one execution path, so evidence
  accumulation, result persistence, and redaction have one implementation.
- Denial and expiry become information the planner can act on rather than a
  terminal state, which is what makes a "materially different route" possible.
- The approval and task execution trees converge: an approval bound to a task
  can be parented to that task's execution instead of creating a disjoint root
  (`tools-legacy.js:1199`).
- The approval record gains a real approving identity. Today `reviewer` is
  hardcoded to `"dashboard"` at `src/dashboard.js:1679` and `:1690`, so it is
  currently impossible to determine from the record which human approved
  anything.
- A parked task is guaranteed to be woken (I11), which requires a scheduled
  expiry sweeper to exist and be monitored — new operational surface that did
  not previously exist.
- Persisted plans, evidence, and results are encrypted at rest (§4.4), so an
  operator reading the database directly can see task structure, digests, and
  counters but not argument or result content.
- Cost: three new tables, a migration, a transition path for the existing JSON
  document, a durable write on every park, a scheduled sweeper, and a key
  dependency for resumption.

## Limitations and residual risk

- **Neither exactly-once dispatch nor exactly-once effects are provided** (§8).
  The guarantee is single concurrent claimant plus risk-dependent recovery:
  at-least-once for low/medium risk, at-most-once with manual reconciliation for
  high/critical/unknown. Anything that needs stronger semantics must be
  idempotent at the tool boundary, and the risk classification becomes a
  correctness input rather than a policy label — a tool misclassified as `low`
  gets silently retried after a crash.
- **The expiry sweeper is a liveness dependency** (§7.2). If it is not deployed
  or silently dies, parked tasks wait until their deadline instead of their
  approval's expiry. It needs monitoring, not just implementing — the precedent
  of `recoverStaleApprovals` shipping with zero callers is the failure to avoid.
- **Effect-level concurrency is prevented only by the single-process
  deployment** (§8). Writes are fenced by `claim_epoch`, so a stalled runner
  cannot corrupt state, but nothing stops it from dispatching a tool after its
  lease has been reclaimed. Introducing a second runner process would make this
  reachable and requires revisiting the guarantee, not just the deployment.
- **Removing persisted previews changes the approval API's failure mode**
  (§4.4). Rendering arguments now requires the decryption key at read time, so
  a key-less reader sees metadata and digests but no content. This is the right
  direction, but it is a behaviour change for any consumer that today reads
  `args_preview` directly from storage.
- **Checkpoint tombstones accumulate without bound** (§4.5). One small row per
  task ever run, retained indefinitely and deliberately exempt from the
  retention window so approvals never dangle. Growth is linear in total tasks,
  which is small for this deployment but is genuinely unbounded. If that proves
  unwelcome the documented alternative is to drop the foreign key and enforce
  retention order in application code.
- **Reconciliation depends on an attributable human** (§8.2), which the current
  approval surface cannot provide — `reviewer` is hardcoded to `"dashboard"`
  (`src/dashboard.js:1679`). Fixing that is a prerequisite for the safety
  boundary to mean anything, and it is not part of this design.
- **`confirm_not_executed` is a trusted assertion.** A human asserting an
  effect did not land, when it did, produces exactly the double-execution the
  risk gate exists to prevent. It is audited but not verifiable.
- **Encryption makes `SIDEKICK_SECRET_KEY` a resumption dependency** (§4.4).
  Losing or rotating it strands parked tasks, which must then be failed
  explicitly rather than resumed. Parked tasks should be drained before
  rotation.
- **Checkpoints are written at park points only**, so a crash mid-plan without
  an approval still loses the task. This is unchanged from today, but the new
  storage may create an expectation of general resumability that does not hold.
- **The persisted plan durably stores model-authored content.** It is
  post-validation and post-strip, so it carries no authority, and §4.4 keeps it
  encrypted at rest — but it is still untrusted text, and any surface that
  renders it must redact rather than trust it.
- **The partial unique index encodes policy in an index.** If the anti-re-request
  rule needs to soften — for instance to permit one retry after a transient
  denial — that becomes a schema change rather than a config change.
- **Argument digest stability** depends on `canonicalizeApprovalValue`
  (`tools-legacy.js:319-328`) being stable across versions. If its normalisation
  ever changes, previously approved actions will fail re-verification. It should
  be treated as a versioned wire format from the moment it is load-bearing.
- **The transition period is the riskiest part.** While both the legacy JSON
  document and the new table exist, an approval could be visible in one and not
  the other. The implementation should cut over in a single migration rather than
  running dual-write.
