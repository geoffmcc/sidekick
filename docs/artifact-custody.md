# Artifact Custody

The platform kernel (`platform_artifacts`) is the **one custody authority** for
artifacts: insert-only identity, digest validation, path safety, and
role/lineage invariants. This document describes how compute worker output gets
into it, which before B6 it did not.

## The gap B6 closed

Measured on production before any code changed:

| Fact | Count |
|---|---|
| `compute_artifacts` rows | 10 |
| …that arrived via the worker HTTP upload path | **10** |
| …that arrived via the inline completion path | **0** |
| Kernel rows holding custody of a compute artifact | **0 of 10** |

The audit described this as "the worker HTTP upload path never registers in the
kernel; the inline mirror swallows errors". The measurement sharpened it: the
mirror in `createVerifiedArtifact` was real and did sit inside an empty
`catch {}`, but it lived on a code path that **had never executed in
production**. Fixing only the swallowed catch would have changed nothing. The
upload path (`uploadArtifact` → `finalizeArtifact`) was the whole gap.

## How custody is taken now

`src/compute/artifact-custody.js` is the single path; both compute paths call it
through `recordCustody` in `job-manager.js`.

**Registration happens at finalize, not upload.** An uploaded artifact is
`state: "uploaded"`, `verified: false`, and may never be finalized. The kernel
record is insert-only, so registering unverified bytes would make the authority
permanently assert something that was never checked. Finalize is where the hash
and size are verified.

**The kernel artifact id is the compute artifact id.** Reusing the identifier
makes registration idempotent against a primary-key conflict rather than a
bookkeeping flag — which is what lets the reconciler run repeatedly, and lets a
crash between the two writes be recovered rather than duplicated.

**A custody failure never fails the job.** The bytes exist and the result is
valid; refusing to finalize because the kernel is unhappy would let a custody
problem destroy the work it exists to record. Instead the failure is:

- recorded on the compute row as `metadata.kernel_custody_error`,
- published as a `compute.artifact_custody_failed` event (severity `error`),
- logged as a structured line.

Surfaced, not swallowed — and the reconciler can close the gap afterwards.

Custody failure reporting calls `appendEvent` directly rather than compute's
`emitComputeEvent`, which returns early when a job has no `root_execution_id`.
The artifacts most likely to lose custody are exactly the ones that would
otherwise emit no event at all.

**An artifact with no execution is still registered.** 7 of the 10 pre-existing
rows have no `root_execution_id` because they predate the job→execution wiring.
Requiring the link would have silently excluded the majority of real artifacts,
so unknown provenance is recorded as unknown (`metadata.execution_link`).

### Sensitivity mapping

Compute and the kernel grew separate vocabularies — compute defaults an artifact
to `private`, the kernel column speaks `normal`/`sensitive`/`secret`. Values are
mapped explicitly rather than passed through, so compute's vocabulary does not
leak into the authority's table:

| Compute | Kernel |
|---|---|
| `public`, `normal` | `normal` |
| `internal`, `private`, `sensitive` | `sensitive` |
| `secret` | `secret` |
| anything unrecognised | `sensitive` (fails safe) |

Worker output is registered `redaction_state: "none"`, because nothing redacted
it on the way in. Claiming otherwise would be a lie that the event delivery path
would then trust.

## Reconciling orphans

```text
compute_jobs action="reconcile_artifact_custody"                  # dry run
compute_jobs action="reconcile_artifact_custody" confirm=true     # execute
```

**Dry run by default.** Registration is insert-only and publishes an
`artifact.registered` event per row, so it is not something to trigger as a side
effect of a deploy or a health check. An operator runs it deliberately, reads
the plan, and confirms — following the project-source backfill precedent.

The plan reports `linked` and `unlinked` separately. That split matters: most
existing orphans have no execution link, and an operator should see that in the
plan rather than discover it afterwards.

A confirmed run is safe to repeat — reconciled artifacts are no longer orphans,
and a re-registration attempt resolves to `already` via the primary-key
conflict.

## Not in B6

**Artifact access authorization.** `GET /api/artifacts` already accepts a
`project_id` filter, but nothing *enforces* scoping and it never invokes
`checkCapability`. This is not an auth bypass — the blanket dashboard auth
middleware gates every route — but it is not authorization either. Enforcing
per-project access depends on the same durable actor identity that blocks
publisher authorization for events (Track C). It is left undone and labelled,
rather than implemented as a capability check with nothing behind it.

Also still open, from the audit's kernel-custody row: no recursive-lineage read
API, no `storage_ref` byte resolver, and no retention sweeper (nothing writes
`deleted_at`).
