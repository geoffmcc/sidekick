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

const syntheticCredential = "synthetic-result-credential-9d73";
const structuredLeak = normalizeResult({
  content: [{ type: "text", text: JSON.stringify({
    ok: true,
    result_status: "succeeded",
    credential: syntheticCredential,
    nested: { access_token: syntheticCredential, message: `token=${syntheticCredential}` },
  }) }],
});
assert.strictEqual(structuredLeak.credential, "[REDACTED]", "structured fields must be sanitized with their displayed text");
assert.strictEqual(structuredLeak.nested.access_token, "[REDACTED]");
assert.ok(!JSON.stringify(structuredLeak).includes(syntheticCredential), "normalized top-level fields must not bypass text redaction");

const statusLeak = normalizeResult({
  content: [{ type: "text", text: JSON.stringify({ ok: true, status: `token=${syntheticCredential}`, code: `token=${syntheticCredential}` }) }],
});
assert.ok(!JSON.stringify(statusLeak).includes(syntheticCredential), "free-form status/code metadata must not bypass redaction");
const nonStructuredStatusLeak = normalizeResult({
  content: [{ type: "text", text: "operation completed" }],
  status: `token=${syntheticCredential}`,
});
assert.ok(!JSON.stringify(nonStructuredStatusLeak).includes(syntheticCredential));

const metadataSuffixBoundary = normalizeResult({
  content: [{ type: "text", text: JSON.stringify({
    ok: true,
    result_status: "succeeded",
    credentialState: "active",
    credentialRotatedAt: "2026-10-23T12:34:56.000Z",
    hasCredential: true,
    secretStatus: syntheticCredential,
    privateKeyId: syntheticCredential,
    hasCredentialDescription: syntheticCredential,
    credentialStateInjected: syntheticCredential,
  }) }],
});
assert.equal(metadataSuffixBoundary.credentialState, "active");
assert.equal(metadataSuffixBoundary.credentialRotatedAt, "2026-10-23T12:34:56.000Z");
assert.equal(metadataSuffixBoundary.hasCredential, true);
assert.equal(metadataSuffixBoundary.secretStatus, "[REDACTED]");
assert.equal(metadataSuffixBoundary.privateKeyId, "[REDACTED]");
assert.equal(metadataSuffixBoundary.hasCredentialDescription, "[REDACTED]");
assert.equal(metadataSuffixBoundary.credentialStateInjected, "[REDACTED]");
assert.ok(!JSON.stringify(metadataSuffixBoundary).includes(syntheticCredential));

const metadataLeak = errorResult("operation failed", "handler_error", {
  details: { api_key: syntheticCredential },
  warnings: [{ message: `Authorization: Bearer ${syntheticCredential}` }],
  recovery: { next_step: `token=${syntheticCredential}` },
});
assert.ok(!JSON.stringify(metadataLeak).includes(syntheticCredential), "error metadata must pass through the same redaction boundary");
const codeLeak = errorResult("operation failed", `token=${syntheticCredential}`);
assert.ok(!JSON.stringify(codeLeak).includes(syntheticCredential), "error codes must be redacted if a caller supplies malformed free-form data");
console.log("Structured result redaction preserves valid JSON");
