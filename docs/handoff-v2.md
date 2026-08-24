# Handoff v2

Handoff v2 keeps the existing prose `content` field and adds an optional, versioned `packet`.
Packet changes are preserved in the same append-only history as content changes, so updating
structured state cannot silently overwrite the previous resume state.

## Packet contract

```json
{
  "objective": "What this work is trying to accomplish",
  "summary": "Short current-state summary",
  "status": "active | blocked | ready | completed | abandoned",
  "completed_steps": ["Verified the current implementation"],
  "decisions": ["Keep the existing handoff API compatible"],
  "blockers": [],
  "next_step": "The next concrete action",
  "acceptance_criteria": ["The resume test passes"],
  "risks": [],
  "provenance": {
    "repository": "https://github.com/example/project",
    "branch": "feature/example",
    "commit_sha": "...",
    "working_directory": "...",
    "environment": "...",
    "verification": ["npm test"]
  },
  "evidence": [{ "type": "test", "label": "focused test", "status": "passed" }],
  "artifacts": [{ "type": "file", "path": "src/example.js" }],
  "relationships": [{ "type": "supersedes", "target": "handoff_previous" }]
}
```

The packet is optional when reading historical records. New handoffs should provide at least an
`objective` or `summary`, a `status`, and a concrete `next_step`.
Blocked packets should explain their blockers; completed packets should include acceptance
criteria.

## Operations

- `create` and `update` accept `packet` alongside the existing prose fields.
- Packet-only updates are versioned and can be guarded with `expected_version`.
- `get` and `versions` return the packet for the selected version.
- `inspect` returns packet validation alongside extracted memories.
- `validate` checks whether a handoff contains enough information to resume safely.
- `verify` performs that structural validation plus bounded local Git provenance checks.

Validation is structural and evidence-aware metadata is preserved as supplied; it does not
pretend that a referenced commit, file, or URL still exists without a separate verification.

`verify` returns `verified`, `stale`, `unverifiable`, or `invalid`. It only verifies a commit
and branch when `provenance.working_directory` is visible to the Sidekick server. Remote-only
repository URLs are reported as `unverifiable`; the operation never treats metadata as proof.

Evidence, artifact, and relationship entries are also stored as append-only first-class links
with their handoff version, while remaining mirrored in the packet for compatibility.

## Validated resume

The project `resume` record can link to a structured handoff with `handoff_id`. When
`resume action="check"` sees a link, it validates the handoff packet before returning it.
Missing or incomplete linked handoffs fail closed with `resume_blocked` and validation issues.
New handoffs are stored only in the versioned structured handoff store; KV keys are not part of
the handoff API.

## Continuation-quality finalization

Ending a session with `handoff_id` finalizes that handoff from the session envelope. The
session may provide `reports`, `artifacts`, evidence, decisions, failed approaches, risks,
and `do_not_repeat` guidance. Subagent reports are retained as handoff artifacts, while the
generated packet carries the goal, summary, state, next step, acceptance state, provenance,
and source task ID. The finalization quality gate fails closed when continuation-critical
fields are missing, so a session cannot be marked complete with an unusable linked handoff.

Finalization reads the linked handoff version and updates it with an optimistic concurrency
guard. If another writer changes the handoff during finalization, the session remains active
and the operation fails without overwriting the newer handoff. The handoff update and session
completion are committed together. Existing packet decisions, risks, acceptance criteria,
evidence, artifacts, and relationships are retained unless the finalization explicitly adds
or replaces them. A successful session-end response includes the resulting `handoff_version`.

## Handoff v3: Verifiable Continuity

Migration 067 extends the v2 record with a lifecycle state, bounded claim lease,
checkpoint JSON and hash, and completion/revocation/supersession metadata. It
also adds `memory_handoff_events`, an append-only hash-linked journal. Existing
records migrate as schema version 2, remain readable, and are not given invented
checkpoints or evidence.

The governed `handoff` tool adds these bounded operations:

- `checkpoint`: capture repository root, branch, HEAD, upstream, and a bounded
  porcelain status manifest. Only the canonical checkpoint and hash are stored;
  command output and secrets are not persisted.
- `readiness`: validate the packet, lifecycle, checkpoint availability, and
  current repository drift. Results are `ready`, `reconciliation_required`,
  `blocked`, or `invalid` with machine-readable reasons.
- `transition`: enforce the lifecycle transition matrix with optimistic
  concurrency.
- `claim` and `release`: atomically manage a bounded lease. The returned claim
  token is stored only as a hash and is required for release.
- `events`: retrieve the bounded continuity journal for audit and recovery.

Checkpoint drift is informational only when clean; branch, HEAD, upstream, or
working-tree changes are material and must be reconciled before automatic
continuation. Handoff text, packet fields, journal payloads, and checkpoint
metadata do not grant authority or approvals. Current policy and capability
checks remain authoritative.

## Receiver continuity

Handoff v3 also exposes receiver-oriented, read-only projections:

- `start_here` returns the objective, current state, next step, completed work,
  blockers, decisions, open questions, risks, acceptance criteria, provenance,
  artifacts, relationships, evidence freshness, quality, readiness, and claim
  state in one bounded response.
- `quality` evaluates whether a packet contains enough structured state for a
  receiver. It checks objective, status, next step, completed work, acceptance
  criteria, provenance, and verification evidence without rewriting the packet.
- `preflight` evaluates readiness, quality, evidence freshness, and provenance
  before a receiver acts. It returns the authority dimensions that must still
  be recalculated by the receiving Agent.
- `simulate_resume` performs the same checks without claiming, mutating, or
  resuming anything. `safe_to_resume` is never an approval decision.
- `compare` retains the historical summary response and accepts `version` and
  `expected_version` to return deterministic content and packet field changes.

Evidence entries may include `observed_at`, `verified_at`, or `created_at`.
Entries without a timestamp are `unknown`; entries outside the bounded freshness
window are `stale`. Stale or unknown evidence never becomes fresh merely because
it appears in a handoff.

Agent tasks may link explicitly to a Handoff with `handoff_id`. Agent execution
checkpoints, approval continuation, operation receipts, and recovery claims remain
the authorities for execution safety. The Handoff adapter records only bounded
continuity metadata and coalesces ordinary loop checkpoints. Plan revisions,
approval waits, pauses, terminal boundaries, and recovery failures are lifecycle
checkpoint boundaries. A linked task resume is blocked when its Handoff preflight
cannot establish safe continuity; the Handoff does not replace Agent recovery
classification or grant execution authority.

The prose content and structured packet are versioned together. The packet is the
machine-readable source for receiver projections; the prose is the human narrative.
They should be updated together so a receiver can understand both the detailed
state and the concise explanation without relying on extracted memories as the
source of truth.
