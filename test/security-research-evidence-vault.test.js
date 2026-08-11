"use strict";
const assert = require("assert");
const { normalizeEvidenceReference, resolveEvidenceReferences } = require("../src/security-research/evidence-vault");

console.log("Running Security Research Evidence Vault Contract Tests...\n");
assert.throws(() => normalizeEvidenceReference("https://example.test/evidence"), /opaque artifact/);
assert.throws(() => resolveEvidenceReferences(["artifact:missing"], { resolve: () => null }), /not found/);
const resolved = resolveEvidenceReferences(["artifact:synthetic-control"], { resolve: id => ({ artifact_id: id, content_hash: "sha256:synthetic", custody_role: "original", redaction_state: "redacted" }) });
assert.deepStrictEqual(resolved[0], { reference: "artifact:synthetic-control", artifact_id: "synthetic-control", content_hash: "sha256:synthetic", custody_role: "original", redaction_state: "redacted" });
console.log("Evidence Vault contract tests passed.");
