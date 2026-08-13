"use strict";

/**
 * Compute → kernel artifact custody.
 *
 * The platform kernel is meant to be the one custody authority for artifacts.
 * It was not: measured on production before this module existed, all 10
 * `compute_artifacts` rows had arrived through the worker HTTP upload path
 * (`uploadArtifact` → `finalizeArtifact`), which never called
 * `registerArtifact` at all — so 10 of 10 compute artifacts were invisible to
 * the authority. The one mirror that did exist lived in `createVerifiedArtifact`
 * (the inline completion path), wrapped in an empty `catch {}`, and had run
 * **zero** times in production. Fixing the swallowed catch alone would have
 * changed nothing; registering the upload path is what closes the gap.
 *
 * Design rules this module follows:
 *
 *   - REGISTER AT FINALIZE, NOT UPLOAD. An uploaded artifact is `state:
 *     "uploaded"`, `verified: false`, and may never be finalized. The kernel
 *     record is insert-only, so putting one behind unverified bytes would make
 *     the authority permanently assert something that was never checked.
 *   - THE KERNEL ID IS THE COMPUTE ID. Reusing the identifier makes
 *     registration idempotent against a primary-key conflict rather than a
 *     bookkeeping flag, which is what lets the reconciler run repeatedly and
 *     lets a crash between the two writes be recoverable.
 *   - CUSTODY FAILURE NEVER FAILS THE JOB. The bytes exist and the result is
 *     valid; refusing to finalize because the kernel is unhappy would let a
 *     custody problem destroy the work it is meant to be recording. Instead the
 *     failure is recorded on the artifact, published as an event, and logged —
 *     surfaced, not swallowed — and the reconciler can close the gap later.
 *   - AN ARTIFACT WITHOUT AN EXECUTION IS STILL REGISTERED. 7 of the 10
 *     pre-existing rows have no `root_execution_id` because they predate the
 *     job→execution wiring. Requiring the link would silently exclude the
 *     majority of real artifacts; unknown provenance is recorded as unknown.
 */

const { redactSensitive } = require("../redact");

let platformKernel = null;
try { platformKernel = require("../platform/kernel"); } catch {}

/**
 * Compute and the kernel grew separate sensitivity vocabularies — compute
 * defaults an artifact to `private`, the kernel column defaults to `normal`.
 * Passing compute's value straight through would import a third vocabulary into
 * the authority's table, so it is mapped explicitly.
 */
const SENSITIVITY_MAP = Object.freeze({
  public: "normal",
  normal: "normal",
  internal: "sensitive",
  private: "sensitive",
  sensitive: "sensitive",
  secret: "secret",
});

function mapSensitivity(value) {
  return SENSITIVITY_MAP[String(value || "").toLowerCase()] || "sensitive";
}

function isUniqueConflict(error) {
  return /UNIQUE constraint failed/i.test(String(error && error.message || ""));
}

function buildKernelInput(artifact, job = null) {
  return {
    // Deterministic: the kernel record carries the compute artifact's own id.
    artifact_id: artifact.artifactId,
    type: artifact.artifactType ? `compute_${artifact.artifactType}` : "compute_artifact",
    name: artifact.name || artifact.artifactId,
    execution_id: job?.rootExecutionId || null,
    project_id: job?.project || null,
    task_id: job?.taskId || null,
    session_id: job?.sessionId || null,
    producer: artifact.workerId || "compute-worker",
    storage_ref: artifact.storageRef || `compute/${artifact.jobId}/${artifact.artifactId}`,
    content_type: artifact.contentType || null,
    byte_size: Number.isInteger(artifact.sizeBytes) ? artifact.sizeBytes : Number(artifact.sizeBytes || 0),
    content_hash: artifact.contentHash || undefined,
    sensitivity: mapSensitivity(artifact.sensitivity),
    // Worker output is arbitrary bytes that nothing redacted on the way in.
    redaction_state: "none",
    verification: {
      hash_verified: artifact.state === "finalized",
      verified_by: artifact.workerId || null,
      finalized_at: artifact.finalizedAt || null,
    },
    metadata: {
      compute_job_id: artifact.jobId,
      compute_artifact_state: artifact.state,
      execution_link: job?.rootExecutionId ? "job" : "unknown",
    },
    source: "compute",
  };
}

/**
 * Registers one finalized compute artifact with the kernel. Never throws:
 * every outcome is a reported status, because every caller is on a path where
 * throwing would cost the operation its result.
 */
function registerComputeArtifact(artifact, job = null) {
  if (!platformKernel) return { status: "skipped", reason: "platform kernel unavailable" };
  if (!artifact || !artifact.artifactId) return { status: "skipped", reason: "artifact missing id" };
  if (artifact.state !== "finalized") return { status: "skipped", reason: `artifact state is ${artifact.state}` };
  try {
    const registered = platformKernel.registerArtifact(buildKernelInput(artifact, job));
    return { status: "registered", kernel_artifact_id: registered.artifact_id };
  } catch (error) {
    if (isUniqueConflict(error)) {
      // Already in custody — the id is the compute id, so a conflict is proof
      // of prior registration rather than an error to report.
      return { status: "already", kernel_artifact_id: artifact.artifactId };
    }
    return { status: "failed", error: redactSensitive(String(error && error.message || error)).slice(0, 300) };
  }
}

/**
 * Publishes and logs a custody failure. Deliberately calls `appendEvent`
 * directly rather than compute's `emitComputeEvent`, which returns early when a
 * job has no `rootExecutionId` — exactly the artifacts most likely to lose
 * custody are the ones that would emit no event at all.
 */
function reportCustodyFailure(artifact, job, error) {
  const detail = {
    level: "error",
    event: "compute.artifact_custody_failed",
    job_id: artifact?.jobId || job?.jobId || null,
    artifact_id: artifact?.artifactId || null,
    error,
  };
  console.error(JSON.stringify(detail));
  if (!platformKernel) return;
  try {
    platformKernel.appendEvent({
      event_type: "compute.artifact_custody_failed",
      source: "compute",
      severity: "error",
      subject_type: "compute_artifact",
      subject_id: artifact?.artifactId || null,
      execution_id: job?.rootExecutionId || null,
      project_id: job?.project || null,
      payload: { job_id: detail.job_id, error },
      correlation_id: detail.job_id || undefined,
    });
  } catch { /* the log line above is the floor; never recurse into custody */ }
}

/**
 * Reconciles finalized compute artifacts that have no kernel custody record.
 *
 * DRY RUN BY DEFAULT. Registration is insert-only and publishes an
 * `artifact.registered` event per row, so it is not something to trigger as a
 * side effect of a deploy or a health check — an operator runs it deliberately,
 * reads the plan, and confirms. This follows the project-source backfill
 * precedent (dry run reported, then a confirmed run matching it).
 *
 * The `unlinked` count is reported separately and on purpose: most existing
 * orphans predate the job→execution wiring and have no `root_execution_id`.
 * They are still registered — custody with unknown provenance beats no custody —
 * but an operator should see how many are in that state rather than discover it
 * afterwards.
 */
function reconcileComputeArtifacts({ confirm = false, limit = 500, dbStore = require("../db"), getJob = null } = {}) {
  if (!platformKernel) return { ok: false, error: "platform kernel unavailable" };
  const db = dbStore.getDb();
  const bounded = Math.max(1, Math.min(Number(limit) || 500, 5000));
  const rows = db.prepare(`
    SELECT a.*, j.root_execution_id, j.project, j.task_id, j.session_id
    FROM compute_artifacts a
    LEFT JOIN compute_jobs j ON j.job_id = a.job_id
    WHERE a.state = 'finalized'
      AND a.artifact_id NOT IN (SELECT artifact_id FROM platform_artifacts)
    ORDER BY a.created_at ASC
    LIMIT ?
  `).all(bounded);

  const summary = {
    ok: true,
    mode: confirm ? "confirmed" : "dry_run",
    examined: rows.length,
    linked: 0,
    unlinked: 0,
    registered: 0,
    already: 0,
    failed: 0,
    failures: [],
  };

  for (const row of rows) {
    const artifact = {
      artifactId: row.artifact_id,
      jobId: row.job_id,
      artifactType: row.artifact_type,
      name: row.name,
      storageRef: row.storage_ref,
      contentType: row.content_type,
      contentHash: row.content_hash,
      sizeBytes: row.size_bytes,
      sensitivity: row.sensitivity,
      state: row.state,
      workerId: row.worker_id,
      finalizedAt: row.finalized_at,
    };
    const job = row.root_execution_id || row.project
      ? { rootExecutionId: row.root_execution_id, project: row.project, taskId: row.task_id, sessionId: row.session_id }
      : null;
    if (row.root_execution_id) summary.linked += 1; else summary.unlinked += 1;

    if (!confirm) continue;
    const outcome = registerComputeArtifact(artifact, job);
    if (outcome.status === "registered") summary.registered += 1;
    else if (outcome.status === "already") summary.already += 1;
    else if (outcome.status === "failed") {
      summary.failed += 1;
      summary.failures.push({ artifact_id: row.artifact_id, error: outcome.error });
      reportCustodyFailure(artifact, job, outcome.error);
    }
  }

  if (!confirm) {
    summary.would_register = summary.examined;
    summary.note = "dry run: nothing was written. Re-run with confirm=true to register these artifacts.";
  }
  return summary;
}

module.exports = {
  SENSITIVITY_MAP,
  reconcileComputeArtifacts,
  mapSensitivity,
  buildKernelInput,
  registerComputeArtifact,
  reportCustodyFailure,
};
