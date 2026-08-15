"use strict";

// Evaluation replay — OPTIONAL FOUNDATION, deliberately without production
// callers. This is a pure, non-durable, side-effect-safe digest library for
// replay records (no dispatcher reference; actions are hardcoded []). It is
// kept as a building block for future evaluation/regression work, not as a
// wired runtime capability; do not treat its absence from production paths as
// a gap. evaluateReplay fails CLOSED: a record without an expected digest is
// { ok: false, reason: "missing_expectation" } — an evaluation that never
// stated its expectation has not passed anything.

const crypto = require("crypto");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) { return `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`; }
function createReplayRecord(input = {}) {
  if (!Array.isArray(input.references) || input.references.length === 0 || input.references.length > 100) throw new Error("replay references must contain 1-100 values");
  if (input.references.some(ref => typeof ref !== "string" || !/^(?:artifact|event|execution):[A-Za-z0-9_.:-]{1,180}$/.test(ref))) throw new Error("replay references must be opaque artifact, event, or execution references");
  if (!Array.isArray(input.observations)) throw new Error("replay observations must be an array");
  return Object.freeze({ schema: "replay-v1", input_digest: digest({ references: input.references, observations: input.observations }), references: [...input.references], observation_count: input.observations.length, side_effects: false, actions: [] });
}
function evaluateReplay(record, expected = {}) {
  if (!record || record.schema !== "replay-v1" || record.side_effects !== false || !Array.isArray(record.actions) || record.actions.length !== 0) throw new Error("replay record is not side-effect safe");
  const expectedDigest = expected.input_digest || null;
  // Fail closed: no expectation means no pass. The previous ok:true default
  // made an evaluation with a forgotten expectation indistinguishable from a
  // passing one.
  const ok = Boolean(expectedDigest) && expectedDigest === record.input_digest;
  const reason = !expectedDigest ? "missing_expectation" : (ok ? "match" : "digest_mismatch");
  return Object.freeze({ ok, reason, input_digest: record.input_digest, expected_digest: expectedDigest, side_effects: false, actions: [] });
}
module.exports = Object.freeze({ canonical, digest, createReplayRecord, evaluateReplay });
