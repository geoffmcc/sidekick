"use strict";

// Evidence classes are descriptive trust semantics, never authority. They are
// deliberately small so repository text cannot smuggle instructions into the
// Agent's control state.
const EVIDENCE_CLASSES = Object.freeze({
  DISCOVERY_LEAD: "discovery_lead",
  EXACT_SOURCE: "exact_source_evidence",
  RUNTIME: "runtime_evidence",
  MODEL_INFERENCE: "model_inference",
  UNRESOLVED: "unresolved_or_ambiguous",
});

const CLASS_SET = new Set(Object.values(EVIDENCE_CLASSES));
const COMPLETENESS = new Set(["complete", "partial", "unknown", "stale", "conflicted"]);

function bounded(value, max = 240) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeEvidenceClass(value, fallback = EVIDENCE_CLASSES.UNRESOLVED) {
  const candidate = bounded(value, 64);
  return CLASS_SET.has(candidate) ? candidate : fallback;
}

function normalizeEvidenceMetadata(input = {}, defaults = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const completeness = COMPLETENESS.has(source.completeness) ? source.completeness : (defaults.completeness || "unknown");
  const unresolved = source.unresolved === true || completeness !== "complete" || source.stale === true || source.truncated === true || source.degraded === true;
  return {
    evidence_class: normalizeEvidenceClass(source.evidence_class || defaults.evidence_class),
    completeness,
    unresolved,
    stale: source.stale === true || completeness === "stale",
    truncated: source.truncated === true,
    degraded: source.degraded === true,
    conflict: source.conflict === true || completeness === "conflicted",
    reason: bounded(source.reason || defaults.reason, 240) || null,
    provenance: source.provenance && typeof source.provenance === "object" && !Array.isArray(source.provenance) ? source.provenance : {},
  };
}

function canSupportAuthoritativeCompletion(metadata) {
  const normalized = normalizeEvidenceMetadata(metadata);
  return normalized.evidence_class !== EVIDENCE_CLASSES.DISCOVERY_LEAD && normalized.evidence_class !== EVIDENCE_CLASSES.MODEL_INFERENCE && !normalized.unresolved && !normalized.stale && !normalized.truncated && !normalized.degraded && !normalized.conflict;
}

module.exports = { EVIDENCE_CLASSES, normalizeEvidenceClass, normalizeEvidenceMetadata, canSupportAuthoritativeCompletion, bounded };
