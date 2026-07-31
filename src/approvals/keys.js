"use strict";

/**
 * Derived action identity for approval continuation
 * (docs/adr-approval-continuation.md §3).
 *
 * `idempotency_key` is DERIVED, not random. It is a durable identity that
 * database constraints key on, so its encoding is versioned and fully
 * specified — an ambiguous concatenation is a correctness bug, not a formatting
 * preference.
 *
 *   FS = "\x1f"   ASCII unit separator; forbidden in all inputs
 *
 *   akv1_payload    = "akv1" FS task_id FS step_id FS plan_version FS tool_name FS args_digest
 *   idempotency_key = "akv1:" || lower_hex(sha256(utf8(akv1_payload)))
 *
 *   skv1_payload    = "skv1" FS approval_id FS tool_name FS args_digest
 *   idempotency_key = "skv1:" || lower_hex(sha256(utf8(skv1_payload)))
 *
 *   plan_version    = "pv1:" || lower_hex(sha256(utf8("pv1" FS canonicalPlanJson)))
 *   args_digest     = "ad1:" || lower_hex(sha256(utf8("ad1" FS canonicalArgsJson)))
 *
 * Why the separator needs no escaping: every input alphabet excludes \x1f.
 * `task_id` is a hex slice, `step_id` matches /^[a-zA-Z0-9_-]{1,64}$/,
 * `tool_name` matches /^[a-z][a-z0-9_]*$/, and the digests are a
 * lowercase-alphanumeric prefix, a colon, and lowercase hex. An input
 * containing \x1f is therefore a programming error and is REJECTED rather than
 * escaped — escaping would make two distinct actions collide.
 *
 * Standalone (non-task) approvals key on `approval_id`, which is unique by
 * construction. That is deliberate: standalone approvals get no action-level
 * deduplication, exactly as today, because no task's liveness depends on
 * collapsing them.
 */

const crypto = require("crypto");
const { canonicalApprovalJson } = require("./canonical-json");

const FS = "\x1f";

const ARGS_DIGEST_VERSION = "ad1";
const PLAN_VERSION_VERSION = "pv1";
const TASK_KEY_VERSION = "akv1";
const STANDALONE_KEY_VERSION = "skv1";

function sha256Hex(input) {
  return crypto.createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex");
}

/**
 * A null or empty component is a programming error, not a permitted value
 * (§3, "Fixed field order and count"). Reject rather than coerce: coercing an
 * absent step_id to "" would let two different actions derive the same key.
 */
function requireComponent(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Approval key component ${field} must be a non-empty string`);
  }
  if (value.includes(FS)) {
    throw new Error(`Approval key component ${field} must not contain the unit separator`);
  }
  return value;
}

function versionedDigest(version, canonicalJson) {
  return `${version}:${sha256Hex(version + FS + canonicalJson)}`;
}

/**
 * Digest of tool/step arguments. Computed over PLAINTEXT before encryption and
 * stored in the clear, so identity stays queryable without exposing content.
 */
function argsDigest(args) {
  return versionedDigest(ARGS_DIGEST_VERSION, canonicalApprovalJson(args));
}

/**
 * Content identity of a validated plan. This is NOT the schema `version: 1`
 * field the validator checks — it is a digest of the post-validation,
 * post-strip plan object, so a replanned task is detectable.
 */
function planVersion(validatedPlan) {
  return versionedDigest(PLAN_VERSION_VERSION, canonicalApprovalJson(validatedPlan));
}

/**
 * Digest used to verify a decrypted plan still matches what was persisted.
 * Distinct from `planVersion` only in prefix-free form: the checkpoint stores
 * both, and `plan_digest` is the integrity check applied on decrypt (§6 Stage 2,
 * `checkpoint_corrupt`).
 */
function planDigest(validatedPlan) {
  return sha256Hex(canonicalApprovalJson(validatedPlan));
}

function taskIdempotencyKey({ taskId, stepId, planVersion: pv, toolName, argsDigest: ad }) {
  const payload = [
    TASK_KEY_VERSION,
    requireComponent(taskId, "task_id"),
    requireComponent(stepId, "step_id"),
    requireComponent(pv, "plan_version"),
    requireComponent(toolName, "tool_name"),
    requireComponent(ad, "args_digest"),
  ].join(FS);
  return `${TASK_KEY_VERSION}:${sha256Hex(payload)}`;
}

function standaloneIdempotencyKey({ approvalId, toolName, argsDigest: ad }) {
  const payload = [
    STANDALONE_KEY_VERSION,
    requireComponent(approvalId, "approval_id"),
    requireComponent(toolName, "tool_name"),
    requireComponent(ad, "args_digest"),
  ].join(FS);
  return `${STANDALONE_KEY_VERSION}:${sha256Hex(payload)}`;
}

/**
 * An implementation MUST reject a task-originated approval whose binding fields
 * are incomplete rather than silently falling back to skv1 — a missing step_id
 * on a task approval is a bug, not a standalone request (§3).
 */
function isTaskBinding(binding) {
  if (!binding) return false;
  const present = ["taskId", "stepId", "planVersion"].filter(f => typeof binding[f] === "string" && binding[f].length > 0);
  if (present.length === 0) return false;
  if (present.length !== 3) {
    throw new Error("Task-originated approval has an incomplete binding: task_id, step_id and plan_version are all required");
  }
  return true;
}

function isTaskKey(key) {
  return typeof key === "string" && key.startsWith(TASK_KEY_VERSION + ":");
}

module.exports = {
  FS,
  ARGS_DIGEST_VERSION,
  PLAN_VERSION_VERSION,
  TASK_KEY_VERSION,
  STANDALONE_KEY_VERSION,
  argsDigest,
  planVersion,
  planDigest,
  taskIdempotencyKey,
  standaloneIdempotencyKey,
  isTaskBinding,
  isTaskKey,
  requireComponent,
};
