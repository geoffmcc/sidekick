"use strict";

const assert = require("assert");
const { normalizeResult, errorResult, RESULT_STATUSES } = require("../src/tools/result");

assert.deepStrictEqual(RESULT_STATUSES, ["succeeded", "partial", "failed", "unavailable", "denied", "approval_required", "cancelled"]);
const embeddedFailure = normalizeResult({ content: [{ type: "text", text: JSON.stringify({ ok: false, code: "dependency_missing", state: "unavailable", warnings: ["provider offline"] }) }] });
assert.strictEqual(embeddedFailure.isError, true);
assert.strictEqual(embeddedFailure.status, "unavailable");
assert.strictEqual(embeddedFailure.code, "dependency_missing");
assert.deepStrictEqual(embeddedFailure.warnings, ["provider offline"]);
const negativeFinding = normalizeResult({ content: [{ type: "text", text: JSON.stringify({ ok: false, status: "succeeded", finding_ok: false, conclusion: "indeterminate" }) }] });
assert.strictEqual(negativeFinding.isError, undefined);
assert.strictEqual(negativeFinding.ok, true);
assert.strictEqual(negativeFinding.finding_ok, false);
const approval = errorResult("operator decision required", "approval_required", { approvalRequired: true, approvalId: "approval-test", retry_safe: false });
assert.strictEqual(approval.status, "approval_required");
assert.strictEqual(approval.approval_state, "required");
assert.strictEqual(approval.approvalId, "approval-test");

const boundedWarnings = normalizeResult({ content: [{ type: "text", text: JSON.stringify({ warnings: Array.from({ length: 101 }, (_, index) => `warning-${index}`) }) }] });
assert.strictEqual(boundedWarnings.warnings.length, 50, "result warnings must remain bounded");
const boundedErrorMetadata = errorResult("bounded", "handler_error", {
  evidence_refs: Array.from({ length: 101 }, (_, index) => `evidence-${index}`),
  limitations: Array.from({ length: 101 }, (_, index) => `limitation-${index}`),
});
assert.strictEqual(boundedErrorMetadata.evidence_refs.length, 100, "error evidence references must remain bounded");
assert.strictEqual(boundedErrorMetadata.limitations.length, 50, "error limitations must remain bounded");

const result = normalizeResult({
  schema: { pattern: "^secret=[REDACTED]\n" },
  credential_ref: "secret:fixture",
});
const parsed = JSON.parse(result.content[0].text);
assert.strictEqual(parsed.credential_ref, "[REDACTED]");
assert.strictEqual(parsed.schema.pattern, "^secret=[REDACTED]\n");
console.log("Structured result redaction preserves valid JSON");
