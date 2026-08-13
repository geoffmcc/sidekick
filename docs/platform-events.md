# Platform Events

The **event ledger** (`platform_execution_events`) is Sidekick's append-only
record of what the platform did. The **delivery contract**
(`platform_event_subscriptions`, `platform_event_deliveries`,
`platform_event_offsets`, migration 030) is how a consumer reads it durably —
with attempts, retry, dead-lettering, and a per-subscription offset.

Publishing has been production-complete for a long time. Consumption was not:
until B5, `deliverEvent` had no caller outside the kernel and its own test,
nothing polled `pending`/`retry`, and offsets were written but never read. An
event fanned out into delivery rows that sat there forever. This document
describes the pipeline as it now runs.

## Publish

`kernel.appendEvent(input)` writes the event and fans it out to every active
matching subscription **in one transaction**.

That transaction boundary is the correctness property. Fan-out used to run after
the insert committed, inside `try {} catch {}`: a failure in between produced an
event that is in the ledger, is in no delivery queue, and that no consumer can
ever discover is missing. Now either both land or neither does — an append that
cannot fan out fails, and the caller sees it.

Publishers are still never blocked by a *consumer*: a subscription with no
handler, a paused subscription, or one at its backlog cap costs the publisher
nothing (see the cap below).

## Subscribe

`kernel.registerEventSubscription({ name, event_type, max_attempts })`.
Matching is exact on `event_type`, or `*` for the whole ledger.

Because matching is exact, a typo produces a subscription that silently never
fires — the worst failure mode for an audit trail. `src/platform/event-vocabulary.js`
guards that:

- **Shape is enforced.** `dotted.lower_snake_case` with at least one dot, or
  `*`. Anything else is rejected at registration.
- **Namespace is advisory.** An unrecognised namespace is allowed, but it is
  logged (`platform.event.subscription_unknown_namespace`) and recorded on the
  subscription as `metadata.unknown_namespace`. A new subsystem must not be
  blocked from subscribing before someone edits the vocabulary file.

`test/platform-event-consumption.test.js` keeps the vocabulary honest in the
other direction: every literal `event_type` in `src/` must have its namespace
registered. Several publishers pass the type in as a variable, so the namespace
list — not the type list — is the complete surface.

## Backlog cap

`POST /api/event-subscriptions` used to be an operational hazard: creating a
subscription started accumulating `pending` rows with nothing to drain them, and
nothing bounded the growth.

Fan-out now checks each subscription's undelivered depth (`pending`, `retry`,
`in_flight`) against `SIDEKICK_EVENT_BACKLOG_CAP` (default 10000, floored at 10).
At the cap the subscription is **auto-paused**, with `auto_paused_at` and
`auto_pause_reason` recorded in its metadata.

Pausing was chosen over the alternatives deliberately:

| Option | Why not |
|---|---|
| Drop the delivery | Loses the event with no record. |
| Fail the publish | Lets one dead consumer take down every producer. |
| Grow unbounded | The hazard being fixed. |

Pausing is durable, visible in the subscription list, and stops growth at the
source. The operator drains or requeues the backlog, then resumes with
`setEventSubscriptionState`. **Events published while a subscription is paused
are not delivered to it** — that is what paused means, and it bounds the flood
on resume.

The depth probe is a `LIMIT cap + 1` subquery, so a subscription that is far
behind does not cost a full scan on every publish.

## Drain

`src/platform/event-drainer.js` is the consumer half.

- **Handler registry**, keyed by subscription **name**, not id. Names are stable
  across databases and re-registration; ids are not, so a handler bound to an id
  would silently stop matching after an environment rebuild.
- **`registerHandler(name, handler, { event_type, max_attempts })`** binds the
  handler and ensures the subscription exists. Idempotent, and it **preserves
  stored state**: a subscription an operator paused (or that the cap
  auto-paused) stays paused across restarts.
- **`drainOnce()`** recovers stale claims, lists due deliveries, and runs each
  one's handler through `kernel.deliverEvent`. It never throws for an ordinary
  condition — a handler that throws is a failed delivery (retried, then
  dead-lettered at `max_attempts`), not a stopped drainer.
- **`startDrainer()`** polls on `SIDEKICK_EVENT_DRAIN_INTERVAL_MS` (default
  15000, clamped to 1s–5min), batch size `SIDEKICK_EVENT_DRAIN_BATCH` (default
  50). Started from `src/index.js` in the MCP process; opt out with
  `SIDEKICK_DISABLE_EVENT_DRAINER=1`.

Claiming is an atomic conditional UPDATE in the kernel, so running two drainers
is **safe** (the loser gets `null`) — wasteful, not incorrect.

### Stale claims

Introducing a consumer introduces a way to die holding a claim. A delivery stuck
`in_flight` after a crash would never be retried, so
`kernel.recoverStaleEventDeliveries({ olderThanMs })` (default 5 minutes, run at
the top of every pass) releases it. `attempt_count` was already incremented at
claim time, so a reclaimed delivery that has exhausted its attempts goes
straight to `dead_letter` rather than retrying past `max_attempts`.

### Deliveries with no handler

They are **left pending** and reported as `skipped_no_handler`. Acking them would
mark an event delivered that nothing consumed. They accumulate until the backlog
cap pauses the subscription — bounded and visible, which beats silent.

## Built-in consumers

| Subscription | Event type |
|---|---|
| `platform.execution-failures` | `execution.failed` |
| `platform.execution-timeouts` | `execution.timed_out` |
| `platform.execution-rollback-failures` | `execution.rollback_failed` |
| `platform.module-health-alerts` | `module.health.alert` |

The handler emits one structured, re-redacted line (`platform.event.alert`) to
stderr, which lands in `journalctl -u sidekick-mcp`.

These are scoped to failure events rather than `*` on purpose: a wildcard
subscription would create a delivery row and two extra writes for **every** event
the platform publishes, to tell an operator things they can already read in the
ledger. These four are low-volume, are the ones worth waking up for, and give the
pipeline a real production consumer whose offsets actually advance.

The drainer deliberately does not deliver to external systems. Handlers are
in-process and side-effect-light; a webhook fan-out belongs behind the connector
authority, not inside the drainer.

## Operating

```text
# subscriptions, deliveries, and per-status counts
GET  /api/event-deliveries
POST /api/event-subscriptions
POST /api/event-subscriptions/:subscriptionId/{pause,resume}
POST /api/event-deliveries/:deliveryId/requeue   # dead_letter -> pending
```

A subscription that shows `state: paused` with `metadata.auto_pause_reason` hit
its backlog cap. Drain or requeue, then resume it.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `SIDEKICK_EVENT_BACKLOG_CAP` | `10000` | Undelivered depth at which a subscription auto-pauses (floor 10, ceiling 1000000). |
| `SIDEKICK_EVENT_DRAIN_INTERVAL_MS` | `15000` | Drain poll interval (clamped 1000–300000). |
| `SIDEKICK_EVENT_DRAIN_BATCH` | `50` | Deliveries claimed per pass (clamped 1–500). |
| `SIDEKICK_DISABLE_EVENT_DRAINER` | unset | `1` starts the MCP process with no drainer. |

## Causation

`causation_id` sat in the schema from the start with no publisher ever setting
it, so the ledger recorded *that* things happened but never *what caused* them.
`correlation_id` groups a chain; causation is the parentage inside it.

Two real sources now populate it:

- **Handler-published events.** Anything published while handling a delivery is
  caused by the delivered event. `kernel.deliverEvent` runs handlers inside
  `runWithCausation`, and `appendEvent` picks the value up from that context —
  an `AsyncLocalStorage`, not a module-level variable, because a handler may be
  async and a shared variable would leak one delivery's causation into a
  concurrent one. This case only became real when B5 shipped a consumer.
- **Execution state changes.** A transition is caused by the transition before
  it. `platform_execution_transitions` already stored the event id per
  transition, so the chain needed no new schema — it was simply never read back.

An explicit `causation_id` on the input always wins over the ambient one.

## Payload safety on delivery

Storage and delivery are different trust boundaries, and the numbers make the
case: **44% of the production ledger is stored `redaction_state: "none"`** —
module transitions and pack events deliberately keep arbitrary error text and
label themselves honestly rather than claim a redaction they did not perform.

That was harmless while nothing consumed events. A consumer makes the payload
leave the database and reach handler code (and, for the built-in consumers, a
log line). So `kernel.deliverEvent` redacts any payload not already stored
redacted, and tells the handler it did:

| Field on the delivered event | Meaning |
|---|---|
| `redacted_by_delivery` | `true` when delivery redacted the payload in transit |
| `original_redaction_state` | what the ledger actually stored |
| `redaction_state` | `redacted` once delivery has done its pass |

**The ledger is never rewritten** — the stored row keeps its honest
`redaction_state` and its original text. Redaction happens on the way out.

A subscription that genuinely needs raw text opts in with
`metadata.accepts_unredacted`, which is durable and inspectable by an operator
wondering why a consumer sees what it sees — not a handler-side flag.

## Sensitivity

`sensitivity` is a closed set — `normal`, `sensitive`, `secret` — validated at
publish. A subscription declares a ceiling with `metadata.max_sensitivity`
(default `normal`), and **fan-out** withholds anything above it.

Gating at fan-out rather than at delivery is the stricter choice: an event a
subscription may not see never becomes a row addressed to it, so it cannot leak
later through a handler change, a requeue, or the dashboard's delivery list.

Stated plainly: **every one of the 21,267 events in the production ledger is
`normal`**, so this gate withholds nothing today. It is a policy hook that
becomes load-bearing the moment a publisher raises a level — not a claim that
anything is currently being protected by it. The live protection is the
redaction pass above.

## Provenance, and what is *not* authorization

`source` is shape-validated (lowercase, `-`/`_` separators, ≤32 chars). An
unknown but well-formed source is allowed and logged once per process.

Rejecting unknown sources would be worse than the problem: nearly every
production publisher wraps `appendEvent` in a swallowed `try {} catch {}`, so a
rejection would silently *drop* the event rather than record it with odd
provenance. The set has already drifted on its own — production carries both
`approval` and `approvals`, both `workflow` and `workflow-runner` — which is
what the warning surfaces.

**This is provenance validation, not authorization.** It checks that a source is
well-formed; it cannot check whether the caller is entitled to claim it, because
single-operator mode has no durable actor identity to check against. Real
authorization of publishers depends on the identity boundary tracked in Track C,
and labelling this as authorization would misstate what it does.

## Not in B5

No schema change was required, so there is no new migration. Still open:

- `appendEvent` remains unauthorized in the sense above: any in-process caller
  may publish any event type under any well-formed source.
- Offsets advance on delivery but are not used to replay or backfill a
  subscription created after the fact.
