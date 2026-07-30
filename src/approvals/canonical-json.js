"use strict";

/**
 * Canonical JSON for approval payloads — a VERSIONED WIRE FORMAT.
 *
 * Relocated verbatim from `src/tools-legacy.js` (where it backed `args_hash`)
 * so the approval-continuation storage layer can derive digests without
 * requiring `tools-legacy` at module top level.
 *
 * ADR docs/adr-approval-continuation.md §3 makes this load-bearing: once
 * `args_digest`, `plan_version`, and `idempotency_key` are derived from it and
 * stored durably, any change to the normalisation silently invalidates every
 * stored digest and every previously approved action fails re-verification.
 *
 *   DO NOT modify these functions in place.
 *
 * A normalisation change requires a NEW version prefix in `keys.js` (ad2:/pv2:/
 * akv2:) and a documented migration of stored digests. Behaviour preserved from
 * the original: object keys sorted, arrays order-preserving, only enumerable
 * own properties copied (which is what keeps inherited/prototype-polluted keys
 * out of the digest).
 */

const crypto = require("crypto");

/**
 * Depth ceiling.
 *
 * The original recursed without a bound. A CYCLIC object produced a
 * `RangeError: Maximum call stack size exceeded`; a merely deep one did not —
 * measured, the old code hashed 2000 levels without complaint. So this is not
 * purely "inputs that used to crash now throw cleanly": it is a REAL
 * BEHAVIOURAL CHANGE for any payload nested MORE than 64 levels deep, which
 * used to produce a digest and now throws.
 *
 * Accepted deliberately, and the boundary matters:
 *
 *  - Depth 64 and below produce byte-identical digests to the old
 *    implementation, verified against the pre-change function over a corpus
 *    including key-order permutations, unicode, sparse arrays and inherited
 *    properties. The wire format is unchanged for every realistic payload.
 *  - A tool argument or plan step nested ≥64 deep is not a real workload; a
 *    cyclic or adversarially-deep object emitted by a model is, and it is a
 *    cheap stack-exhaustion trigger now that this function is load-bearing.
 *  - Every call site fails closed on a throw, so the failure direction is safe.
 *
 * The residual risk is narrow but real: a previously stored approval whose
 * arguments were nested ≥64 deep would now fail hash re-verification instead of
 * decrypting. Nothing migrates such rows, because none are believed to exist.
 * Raising or removing this bound requires a new version prefix in `keys.js`, as
 * any other normalisation change would.
 */
const MAX_CANONICAL_DEPTH = 64;

function canonicalizeApprovalValue(value, depth = 0) {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error(`Approval payload exceeds the maximum nesting depth of ${MAX_CANONICAL_DEPTH}`);
  }
  if (Array.isArray(value)) return value.map(item => canonicalizeApprovalValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) out[key] = canonicalizeApprovalValue(value[key], depth + 1);
      return out;
    }, {});
  }
  return value;
}

function canonicalApprovalJson(args) {
  return JSON.stringify(canonicalizeApprovalValue(args || {}));
}

/**
 * Legacy unprefixed digest, retained because existing approval rows carry it as
 * `args_hash` and `decryptApprovalArgs` authenticates against it. New code
 * should use the versioned digests in `keys.js`.
 */
function approvalArgsHash(args) {
  return crypto.createHash("sha256").update(canonicalApprovalJson(args)).digest("hex");
}

function cloneApprovalArgs(args) {
  return JSON.parse(canonicalApprovalJson(args));
}

module.exports = {
  canonicalizeApprovalValue,
  canonicalApprovalJson,
  approvalArgsHash,
  cloneApprovalArgs,
};
