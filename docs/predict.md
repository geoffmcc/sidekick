# Predict

Predict turns Sidekick's structured operational telemetry into a **small number of
defensible, actionable predictions**. It is deterministic — no LLM is involved —
and every persisted prediction is grounded in inspectable evidence drawn from
correlated records.

Predict is not an autonomous executor. Predictions are advisory records with
evidence, confidence, lifecycle state, feedback, and outcome tracking.

The engine is deliberately conservative. Producing nothing is a valid and common
outcome: a quiet Predict page means the telemetry did not support a claim, not
that the engine is broken.

## Evidence Sources

Predict analyzes bounded local Sidekick data:

- recent tool logs (at most the 500 newest in the analysis window)
- incidents
- generated capability / workflow records
- structured memories and handoffs (only when `relevant_context` is enabled)

Operational telemetry is treated as evidence, not durable knowledge. Promote only
verified conclusions into memory or knowledge.

## What Predict predicts

| Type | Claim | Evidence required |
| --- | --- | --- |
| `next_action` | After tool A, tool B commonly follows | ≥3 chronological A→B transitions across ≥2 sessions |
| `likely_failure` | A tool is currently failing in a specific way | ≥3 failures, ≥5 attempts, ≥34% failure rate, ≥2 failures in 24h, ≥2 sessions |
| `missing_prerequisite` | A requires B first | ≥2 full recoveries (A fails → B succeeds → A succeeds) across ≥2 sessions |
| `incident_recurrence` | An incident signature is likely to recur | ≥2 distinct incidents sharing a signature |
| `workflow_opportunity` | A repeated sequence could be automated | ≥3 successful 3-tool sequences across ≥2 sessions |
| `relevant_context` | An unresolved condition blocks the current scope | Disabled by default — see below |
| `stale_or_contradicted` | *Retained for historical rows only* | Never generated; see [Contradiction](#contradiction) |

These are the exact values of the backend enum. The dashboard labels and type
filter are asserted against it by `test/predict-contract.test.js`.

## What Predict deliberately does not treat as a prediction

- **A stored memory or handoff.** Recency, pinning, high confidence and a matching
  project are *not* relevance. Without a signal relating the record to the analysis
  target, surfacing it is context retrieval, not prediction. `relevant_context` is
  therefore **disabled by default** (set
  `SIDEKICK_PREDICT_ENABLE_RELEVANT_CONTEXT=true` to enable). Even when enabled it
  emits only in-scope memories carrying an unresolved, actionable condition
  (`blocker`, `todo`, `decision_pending`). Generic context retrieval belongs to the
  memory and context tools.
- **`A failed, then B succeeded`.** Adjacency is not causation. A prerequisite
  requires repeated *recovery* evidence.
- **A couple of failures among many successes.** That is noise.
- **A prediction about another prediction.** Contradiction is a lifecycle
  transition on the original record, not a new record.

## Analysis scopes

An analysis scope is **required**. A global, all-project sweep must be chosen
deliberately — it is never inferred from omitted parameters.

| Scope | Selected by | Analyzes |
| --- | --- | --- |
| `project` | `project` | One project |
| `session` | `session_id` | One session |
| `task` | `task_id` | One task |
| `global` | `scope: "global"` | Every project |

```
predict({ action: "analyze", project: "sidekick" })   # project scope
predict({ action: "analyze", scope: "global" })       # deliberate global sweep
predict({ action: "analyze" })                        # refused: scope required
```

Sequence predictions from different projects are never merged into a project-null
record. The dashboard shows the scope of the last analysis.

## Sequence construction

Sequence detectors (`next_action`, `missing_prerequisite`, `workflow_opportunity`)
operate on **segments**, built as follows:

1. Tool logs are read newest-first for recency selection, then **explicitly sorted
   ascending** by `(timestamp, id)`. Direction is never inherited from the query.
2. A record without a durable correlation identifier (`session_id`,
   `correlation_id`, or `task_id`) is **skipped**. Unscoped records are never
   merged into a synthetic global session — that fabricates adjacency between calls
   that never ran together.
3. The boundary key includes the project, so one identifier spanning projects
   cannot stitch cross-project activity.
4. A reused identifier is **split on a time gap** larger than
   `SIDEKICK_PREDICT_SEQUENCE_GAP_MINUTES` (default 30).

`tool_logs` stores `success INTEGER` and has no `ok` column; rows are normalized
before any detector sees them.

## Evidence, confidence, and the admission gate

Confidence is based on evidence quantity and score thresholds. Sparse evidence
remains `low` or `medium`; `high` requires 15+ observations and `very_high` 30+.

Every candidate passes through one central admission gate before it can be
persisted. A candidate is rejected unless all of the following hold:

- a supported prediction type and a valid time horizon
- a scope consistent with the analysis (no out-of-scope project)
- a non-empty subject and explanation, and a canonical identity relation
- evidence count, observation count, and distinct-session count at or above the
  per-type minimum
- probability and confidence at or above the per-type minimum
- a recommended action, for types that claim to be actionable
- no unresolved contradiction that invalidates the conclusion

Rejections are tallied **by reason** in the analysis summary and surfaced in the
dashboard. They are never persisted as database records.

Admitted candidates are **ranked globally** — by confidence, then probability, then
observation count — *before* the per-run creation limit is applied, so detector
execution order never decides which candidates survive.

### Threshold reasoning

Thresholds are set from what telemetry can actually support, not from what makes a
fixture pass. Two failures out of twenty calls is a 9% rate indistinguishable from
transient noise, so `likely_failure` requires a meaningful denominator (≥5
attempts), a real count (≥3 failures), a rate that would change behaviour (≥34%),
evidence the pattern is still live (≥2 failures in the last 24h), and breadth (≥2
sessions, with unscoped failures collapsed into a single bucket so they cannot
inflate it).

Prerequisites require ≥2 complete recoveries in ≥2 distinct sessions, each within
15 minutes and 5 steps, with matching argument fingerprints where both are known.
One recovery is an anecdote.

## Fingerprint and logical identity

A prediction's **logical identity** is:

```
sha256(rule_version | type | canonical_relation | project | session_id | task_id)
```

stored in `predictions.identity_key`. A partial unique index enforces **at most one
active row per identity**:

```sql
CREATE UNIQUE INDEX idx_predictions_active_identity ON predictions(identity_key)
  WHERE identity_key IS NOT NULL AND status = 'active' AND enabled = 1;
```

This protects the invariant against concurrent analyses at the database level, not
only in application code. A losing concurrent insert is converted into a refresh.
Legacy v1 rows have a NULL `identity_key`, and SQLite treats NULLs as distinct, so
the index was added without a destructive backfill.

The older `fingerprint` column is retained so v1 rows stay addressable and the
diagnostic report can detect historical duplicates.

## Lifecycle

Re-analysis of the same logical prediction never appends an equivalent row:

| Existing status | Action |
| --- | --- |
| `active` | **Refresh** in place (score, observations, explanation, expiry) |
| `expired` | **Reactivate** the same row |
| `superseded` | **Reactivate**, unless it was retired as contradicted |
| `superseded` (contradicted by feedback) | **Suppress** — not resurrected by the rules that produced it |
| `dismissed` | **Suppress** — the user already rejected this identity |
| `confirmed` / `did_not_occur` | **Suppress** during the identity cooldown (default 7 days); history is never rewritten |

Tool actions for managing state:

- `analyze`: generate predictions from current evidence within an explicit scope.
- `list`: list predictions with optional status/type/confidence filters.
- `get` / `explain`: inspect a prediction and its evidence.
- `feedback`: record whether a prediction was useful, incorrect, already known,
  acted on, or dismissed.
- `outcome`: record whether the predicted event occurred or the action succeeded.
- `dismiss`: mark a prediction dismissed.
- `purge_preview` / `purge`: retention cleanup (see below).
- `diagnose`: read-only data-quality report.
- `migrate`: import legacy file-backed predictions into SQLite.

### Contradiction

When feedback or a recorded outcome contradicts an active prediction, the
**original record** transitions to `superseded` with a `lifecycle_reason`. Predict
never creates a prediction *about* a prediction, which is what previously produced
recursive `Prediction may be stale: Prediction may be stale: ...` chains.

## Expiration

Expiration follows the time horizon — not a single global constant:

| Horizon | Expires after |
| --- | --- |
| `current_task` | 4 hours |
| `current_session` | 12 hours |
| `days_7` | 7 days |
| `days_30` | 30 days |
| `open_ended` | **never** (`expires_at` is NULL) |

Open-ended predictions are retired by contradiction or retention, not by an
arbitrary clock. Session-scoped predictions become terminal when their scope ends,
where that information is available.

## Retention and safe cleanup

Terminal records are retained until an **explicit** cleanup. Nothing is deleted
automatically, and no destructive migration runs at startup.

```
predict({ action: "purge_preview" })          # read-only
predict({ action: "purge", confirm: true })   # requires literal true
predict({ action: "diagnose" })               # read-only data-quality report
```

- `purge_preview` reports counts by table and status, what would be deleted, and
  what policy preserves. It mutates nothing.
- `purge` refuses without `confirm: true` (a truthy string does not count), deletes
  transactionally, removes child rows explicitly rather than relying on
  `ON DELETE CASCADE` (foreign-key enforcement may be off), and writes **one** audit
  row for the whole operation rather than one per deleted record.
- Retention defaults to a conservative **90 days**
  (`SIDEKICK_PREDICT_RETENTION_DAYS`). `0` is a valid value, meaning "everything
  terminal is eligible".
- `retention_days` is validated, not coerced. Only a finite, non-negative number is
  accepted; `null`, `""`, `[]`, `false`, strings and negatives are rejected in favour
  of the configured default. This matters because `Number(null)` is `0` — a plain
  coercion would turn an omitted field into "purge everything" — and a negative
  value would push the cutoff into the future and match every terminal record. The
  dashboard route returns `400` for a present-but-invalid value rather than
  silently defaulting.
- The dashboard purge is recorded in the dashboard audit log (`predict.purge`) with
  the requesting actor, in addition to the single `prediction_audit` summary row.

The `predict` tool is classified **medium** risk because of this bulk-delete
capability, matching `black_box`.

**Preserved regardless of age:**

- `confirmed` predictions — a verified engine-quality signal
- any prediction carrying feedback — needed to evaluate rule quality
- legacy rows, unless `purge_legacy` is explicitly requested
- **all** `prediction_feedback` rows, always

## Feedback

Feedback adjusts future candidates for the **same rule version, project scope, and
prediction type only**.

- The no-project case matches with `project IS NULL`. (It previously compared
  `project = '%'`, an equality test against a literal percent sign, which matched
  nothing.)
- Each prediction is counted **once per feedback kind**, so repeatedly submitting
  the same verdict on one prediction cannot compound.
- The total adjustment is bounded to **±0.1** and saturates after five distinct
  predictions, so feedback cannot drive every unrelated candidate.
- Submitting a verdict that already exists for a prediction is ignored and reported
  as `duplicate: true`.

## Transactions and error handling

Prediction creation, evidence insertion, and the creation audit row are written in a
**single transaction**. A prediction is never left without its intended evidence.
Lifecycle refresh and reactivation likewise write their update and audit row
atomically, and purge deletes within one transaction.

Query and detector failures are recorded with bounded, redacted diagnostics
(`context_errors`, detector `error`) rather than swallowed by empty `catch` blocks.

## API contract

`GET /api/predict/status` returns the canonical field names below. The dashboard
reads only these; `active_predictions`, `total_predictions`, and `last_analysis` are
retained as documented aliases for existing MCP consumers.

```
active, terminal, total                 # counts
detectors: [{ name, enabled, last_count, last_ok }]
last_analyzed, last_analysis_scope
last_analysis_summary: {
  candidates_considered, candidates_admitted, rejected_by_reason,
  created, refreshed, reactivated, superseded, expired, duration_ms
}
last_purge, retention_days, config
type_breakdown, confidence_breakdown, rules
```

`POST /api/predict/analyze` requires a scope and returns what changed — created,
refreshed, reactivated, suppressed, superseded, expired, and rejections by reason.
It responds `400` when no scope is supplied.

Maintenance routes: `GET /api/predict/maintenance/purge-preview`,
`POST /api/predict/maintenance/purge`, `GET /api/predict/maintenance/diagnose`.

## Schema evolution

Predict's schema is created and evolved idempotently in `ensureSchema()` using
`PRAGMA table_info` guards, not through a startup migration file. SQLite has no
`ADD COLUMN IF NOT EXISTS`, and migrations are applied automatically at boot, so a
repeated `ALTER` would throw on every start. All evolution is additive; nothing is
dropped or rewritten.

## Privacy And Redaction

Prediction summaries and evidence snippets must not expose secrets. Existing
redaction applies to tool outputs before storage, and Predict stores bounded,
redacted summaries rather than raw credentials — including in error diagnostics. Do
not place tokens, passwords, private keys, raw `.env` content, or full incident
bundles into prediction notes.

## Dashboard

Dashboard endpoints expose prediction listing, status, analysis, feedback,
lifecycle, and retention maintenance under authenticated routes. Note that the
dashboard's auth middleware is only installed when `SIDEKICK_DASHBOARD_USER` and
`SIDEKICK_DASHBOARD_PASS` are both set; a deployment with neither those
credentials nor an IP allowlist exposes every route anonymously, including the
purge endpoint. Configure credentials (or bind to loopback) on any reachable host. The Analyze button
requires an explicit scope selection and reports what changed. Use dashboard views
to triage active predictions, but verify current repository/runtime state before
acting.

## Known limitations

Predict is deterministic telemetry inference, and it inherits that ceiling:

- **Correlation, not causation.** `next_action` describes what has followed what.
  It cannot know intent.
- **Boundary quality caps everything.** Tool logs without a session, correlation, or
  task identifier are invisible to every sequence detector. Improving Predict's
  coverage usually means improving telemetry correlation upstream.
- **The 30-minute gap heuristic is arbitrary.** It is a reasonable split for
  interactive sessions but has no ground truth behind it.
- **Bounded window.** Analysis reads at most the 500 most recent tool logs in the
  window, so very high-volume projects see only recent history.
- **No semantic understanding.** Predict cannot tell that two differently-named
  tools do the same thing, or that one error category is a symptom of another.
- **Small samples stay low-confidence by design.** High confidence needs 15+
  observations and very high needs 30+, which most scopes never reach.

## Tests

Focused tests:

```bash
node test/predict.test.js            # detector signal quality and scoping
node test/predict-lifecycle.test.js  # lifecycle, retention, feedback
node test/predict-contract.test.js   # dashboard/API contract alignment
```

The full regression suite also includes Predict coverage through `npm test`.
