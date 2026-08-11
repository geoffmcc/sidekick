"use strict";

// Evidence Vault is a custody-reference boundary. It never accepts bytes,
// URLs, credentials, or target material; generic platform artifacts remain
// the authoritative immutable custody records.
function normalizeEvidenceReference(value) {
  if (typeof value !== "string" || !/^artifact:[A-Za-z0-9_.:-]{1,180}$/.test(value)) throw new Error("evidence references must be opaque artifact:<id> values");
  return value;
}

function resolveEvidenceReferences(references, { resolve } = {}) {
  if (!Array.isArray(references) || references.length === 0 || references.length > 100) throw new Error("evidence references must contain 1-100 values");
  if (typeof resolve !== "function") throw new Error("an artifact resolver is required");
  return references.map(reference => {
    const normalized = normalizeEvidenceReference(reference);
    const artifactId = normalized.slice("artifact:".length);
    const artifact = resolve(artifactId);
    if (!artifact) throw new Error(`evidence artifact not found: ${artifactId}`);
    return { reference: normalized, artifact_id: artifact.artifact_id, content_hash: artifact.content_hash || null, custody_role: artifact.custody_role || "original", redaction_state: artifact.redaction_state || "unknown" };
  });
}

module.exports = Object.freeze({ normalizeEvidenceReference, resolveEvidenceReferences });
