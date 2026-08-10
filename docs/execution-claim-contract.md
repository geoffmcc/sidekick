# Execution Claim Contract

Status: implemented (Phase 4 / Track B of the platform convergence roadmap,
first slice)
Tracking: `docs/platform-roadmap.md` phase 4/B
Depends on: `src/platform/kernel.js`, `src/platform/kernel-schema.js`,
migration `028_platform_execution_claims.sql`

## Problem

Eight subsystems dispatch deferred or scheduled work (Brain, approvals,
runbooks, missions, cron, delay, watch, Compute), and before this contract
only three of them — Brain/approvals (`task_checkpoints`) and Compute
(`compute_jobs`) — could survive a runner crash or prevent two runners from
executing the same work twice. The delay scheduler demonstrated both failure
modes concretely: a delay that was `running` when its service died was
stranded forever (its platform execution wedged in `running`, its
`platformGuard` dedupe key blocking future work), and the agent timer and an
MCP-side `delay run` could double-execute the same delay through non-atomic
`delays.json` read-modify-write across two processes.

## Design

### Storage: one claim row per execution

Migration `028` adds `platform_execution_claims` (declared identically in
`kernel-schema.js`; the parity test enforces byte-equal DDL):

- `execution_id` (PK, FK → `platform_executions`) — claims attach to the
  execution ledger every scheduler already projects into, not to the unused
  `platform_workflows` tables.
- `claimed_by`, `claim_epoch`, `lease_expires_at`, `heartbeat_at` — the
  claimant of record and its lease. `claim_epoch` increments on every
  successful (re)claim and fences all writes, per the approval-continuation
  precedent ("one claimant of record, write-fenced by claim_epoch").
- `cancel_requested` — cooperative cancellation flag.
- `checkpoint_json` — caller-defined progress marker. Not encrypted; adapters
  must not store secret material in checkpoints.

### Kernel API (`src/platform/kernel.js`)

| Function | Behavior |
| --- | --- |
| `claimExecution({execution_id, claimed_by, lease_ms?})` | `BEGIN IMMEDIATE`; wins iff the execution is non-terminal and no live lease exists (fresh insert at epoch 1, or fenced update bumping the epoch). Losers get `{ok:false, code:"claim_held"}` — idempotent claim across processes. |
| `renewExecutionLease({execution_id, claimed_by, claim_epoch, lease_ms?})` | Fenced lease extension + heartbeat; `lease_superseded` when the claim was reclaimed. |
| `checkpointExecution({execution_id, claimed_by, claim_epoch, checkpoint})` | Fenced checkpoint write; a superseded claimant cannot corrupt the checkpoint. |
| `releaseExecutionClaim({execution_id, claimed_by, claim_epoch})` | Fenced release; the execution becomes claimable again at the next epoch. |
| `getExecutionClaim(executionId)` | Read (parsed checkpoint, boolean `cancel_requested`); no fencing needed. |
| `requestExecutionCancel(executionId, details?)` | Upserts `cancel_requested = 1` and emits `execution.cancel_requested`. Cooperative only: claimants observe the flag; nothing is force-killed, matching the "best-effort timeout" honesty rule. |
| `recoverOrphanedExecutions(details?)` | Clears expired leases; executions in `queued`/`running`/`waiting` transition to `orphaned` (existing state-machine edges) and an `execution.claims_recovered` summary event is emitted. |

The kernel dispatches nothing. The contract guarantees exactly-one claimant,
write fencing after reclaim, cooperative cancel visibility, and recoverability
of expired leases — the adapters own dispatch and business state.

### Relationship to existing claim layers

Brain/approvals (`task_checkpoints`, ADR §7/§8) and Compute (`compute_jobs`)
are conforming peer implementations and stay on their own storage; the
convergence audit explicitly keeps compatibility layers separate rather than
forcing one unified queue. The Brain single-runner property is untouched.

## First adapter: delay

- Both dispatch paths (`executeDelay` in `src/agent.js` and
  `sidekick_delay action:"run"` in `src/tools-legacy.js`) take a fenced claim
  before mutating `delays.json`; the loser backs off without touching the
  file. Any other claim failure (terminal or missing execution) also refuses
  dispatch — the ledger disagreeing with `delays.json` is never a license to
  run unfenced. Delays without a `platform_execution_id` (legacy rows) keep
  the old behavior.
- While a dispatch is in flight the claim lease is renewed every 60 s
  (`startScheduledLeaseRenewal`), so a slow tool call is not orphaned out from
  under a live runner. Completion writes are release-first and fenced: if
  `releaseExecutionClaim` reports the claim was superseded, the runner's stale
  `delays.json` snapshot is discarded instead of clobbering the current
  claimant's state.
- A pending `cancel_requested` is honored before dispatch: the delay becomes
  `cancelled`, the execution transitions to `cancelled` with
  `result_status: "cancelled"` — an outcome, not a failure.
- On agent startup, `recoverStrandedDelays()` (exported from
  `src/tools-legacy.js`) runs the kernel recovery scan and re-queues any delay
  whose status is `running` but whose execution was orphaned — re-queued to
  `pending` exactly once, fenced by the `orphaned → queued` transition.
- `delays.json` remains the definition store; execution-state authority
  (who is running it, cancellation, recovery) lives in the claim table.

## Second adapter: watch

- Watch checks are serialized per watch by claiming the watch's long-lived
  *definition* execution (`watch.platform_execution_id`) for the duration of
  the check (`claimWatchForCheck`) — the agent interval and an MCP-side
  `watch check` cannot both dispatch the action for the same tick. The claim
  loser skips the tick; any other claim failure also refuses rather than
  running unfenced.
- The lease renews every 60 s during the check (slow action tools are not
  orphaned under a live runner), and a crash mid-check leaves an expired
  lease that the recovery scan flips to `orphaned`; the next check re-queues
  the definition (`orphaned → queued`) before claiming.
- A `cancel_requested` on the definition execution pauses the watch
  (`pauseWatchForCancel`: status `paused`, execution → `blocked`, matching
  the pause action's semantics). Because the flag is not clearable, a
  cancelled watch re-pauses on every resume attempt — cancel is a permanent
  stop; normal stop/resume stays with the watch pause/remove actions.
- All post-claim work runs under try/finally in both paths: a mid-check
  failure clears the renewal timer (which would otherwise keep the lease
  fresh forever) and releases the claim, so a throw costs one tick, not the
  watch.
- Per-tick writes (`lastCheck`, `triggerCount`) are monotonic counters, not
  lifecycle state, so watch completion writes are not release-fenced the way
  delay's are; the claim exists to serialize dispatch, not to arbitrate file
  state. Corollary: under supersession (a claimant paused/suspended past its
  lease while another claims), the stale runner's action dispatch may
  double-fire — acceptable for idempotent notification actions. Completion
  and pause writes re-load `watches.json` before writing so a snapshot from
  tick entry cannot clobber concurrent changes to other watches.
- Related fix: the dashboard's active-watch count read watches from the
  documents table, but watches persist to `watches.json` — the count was
  always zero. It now reads through `loadWatches()`.

## Tests

`test/execution-claims.test.js` (XC.1–XC.11): claim validation, fresh claim,
one-winner concurrency, expired-lease reclaim with epoch bump, fenced
renew/checkpoint/release, stale-claimant write fencing after reclaim,
cooperative cancel visibility and event, re-claimability after release, the
recovery scan (orphan vs release vs live-lease untouched), and lease_ms
bounds (a negative lease is born expired; a huge one overflows into extended
ISO years whose leading `+` inverts every lexicographic lease comparison).

`test/scheduler-platform.test.js` (SP.5–SP.11): delay run backs off when
claimed, cancel-before-dispatch as an outcome with no child execution,
restart recovery re-queueing a stranded delay exactly once, fail-closed
refusal when the execution is terminal, watch check back-off while another
runner holds the claim (and release after the check), cancel-request pausing
a watch, and a mid-check failure releasing the claim (renewal timer cleared,
next check succeeds).

`test/kernel-migration-parity.test.js`: updated to 18 tables / 39 indexes /
kernel schema version 3.

## Non-goals (this slice)

- No new workflow language, and no use of `platform_workflows` (no production
  consumer exists; revisit when a consumer needs multi-step orchestration).
- No changes to Brain/approvals/Compute claim layers.
- No adaptation of cron (OS-crontab-owned runs can't carry the contract),
  runbooks (autonomous mode needs restructuring before it can be
  cancellable), or missions (stateless router) — follow-up slices.
- No migration of `delays.json`/`watches.json` definitions into the DB.
- No event-delivery guarantees (convergence audit decision #4 stays open).
- No un-cancel API: `cancel_requested` is permanent for an execution. Each
  delay has a one-shot execution, so the blast radius is that one delay;
  revisit when a repeating consumer (cron/watch) adopts the contract.
- `requestExecutionCancel` is deliberately not exposed through any tool or
  endpoint yet; when it is, it needs an actor authorization check.
