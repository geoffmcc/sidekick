"use strict";

/**
 * Evidence handling.
 *
 * Raw evidence bytes live ONLY in the external private workspace. The kernel's
 * artifact-custody system stores the reference, the SHA-256 content hash, the
 * size, the sensitivity/redaction state and the original/derivative lineage —
 * never the bytes. A caller receives an opaque `artifact:<id>` reference and
 * metadata, never the raw content, so evidence cannot leak through a tool
 * result or into model context by default.
 *
 * Integrity is a content hash recorded at capture time, not a forensic
 * chain-of-custody claim — the terminology stays accurate.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { kernel, redact, evidenceVault } = require("./platform");
const workspace = require("./workspace");
const { ResearchError } = require("./errors");

const EXT_BY_TYPE = {
  "application/json": "json",
  "text/plain": "txt",
  "text/html": "html",
  "application/octet-stream": "bin",
};

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(JSON.stringify(data), "utf8");
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

function requireProjectArtifact(artifact, projectId) {
  if (!artifact) throw new ResearchError("not_found", "evidence not found");
  if (!projectId || !artifact.project_id || String(artifact.project_id) !== String(projectId)) {
    throw new ResearchError("not_found", "evidence not found");
  }
  return artifact;
}

/**
 * Capture a piece of evidence into the workspace and register its custody
 * record. Returns { evidence_id, reference, content_hash, byte_size,
 * storage_ref }.
 */
function capture(ctx, input) {
  const { root, campaignId, runId, projectId, executionId, maxBytes } = ctx;
  const buffer = toBuffer(input.data);
  if (!buffer.length) throw new ResearchError("evidence_write_failed", "evidence content is empty");
  if (maxBytes && buffer.length > maxBytes) {
    throw new ResearchError("evidence_write_failed", `evidence exceeds max_evidence_bytes (${buffer.length} > ${maxBytes})`);
  }
  const type = String(input.type || "observation");
  const contentType = input.content_type || (type === "observation" ? "application/json" : "text/plain");
  const ext = EXT_BY_TYPE[contentType] || "dat";
  const digest = sha256Hex(buffer);
  const filename = `${workspace.safeSegment(type, "evidence_type")}-${digest.slice(0, 12)}.${ext}`;
  const dir = workspace.evidenceDir(root, campaignId, runId);
  const abs = path.join(dir, filename);

  let written;
  try {
    written = workspace.atomicWrite(root, abs, buffer);
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError("evidence_write_failed", `could not write evidence: ${error.message}`);
  }

  const storageRef = workspace.relToWorkspace(root, written.path);
  let artifact;
  try {
    artifact = kernel().registerArtifact({
      type: "research-evidence",
      name: input.name || filename,
      project_id: projectId || undefined,
      execution_id: executionId || undefined,
      producer: "security-research",
      storage_ref: storageRef,
      content_type: contentType,
      byte_size: buffer.length,
      content_hash: `sha256:${digest}`,
      retention_class: input.retention_class || "standard",
      sensitivity: input.sensitivity || "sensitive",
      redaction_state: input.redaction_state || "none",
      lineage: { role: "original" },
      verification: { algorithm: "sha256", digest, captured_at: new Date().toISOString() },
      metadata: {
        research_run_id: runId,
        campaign_id: campaignId,
        hypothesis_id: input.hypothesis_id || null,
        evidence_kind: type,
        ...(input.metadata || {}),
      },
      source: "security-research",
    });
  } catch (error) {
    throw new ResearchError("evidence_write_failed", `could not register evidence custody: ${error.message}`);
  }

  return {
    evidence_id: artifact.artifact_id,
    reference: `artifact:${artifact.artifact_id}`,
    content_hash: artifact.content_hash,
    byte_size: artifact.byte_size,
    storage_ref: artifact.storage_ref,
    redaction_state: artifact.redaction_state,
  };
}

/**
 * Produce a sanitized derivative of an existing original evidence artifact,
 * suitable for export/report material. The original private evidence is never
 * mutated; a new derivative artifact is registered that supersedes it.
 */
function redactEvidence(ctx, evidenceId) {
  const { root, projectId } = ctx;
  const original = requireProjectArtifact(kernel().getArtifact(evidenceId), projectId);
  if (original.custody_role !== "original") {
    throw new ResearchError("invalid_input", "only an original evidence artifact can be redacted");
  }
  const abs = path.join(root, original.storage_ref);
  let bytes;
  try {
    bytes = workspace.readInside(root, abs);
  } catch (error) {
    throw new ResearchError("redaction_failed", `could not read original evidence: ${error.message}`);
  }
  if (looksBinary(bytes)) {
    throw new ResearchError("redaction_failed", "binary evidence cannot be text-redacted; export it through a purpose-built connector instead");
  }
  let sanitized;
  try {
    sanitized = redact().redactSensitive(bytes.toString("utf8"));
  } catch (error) {
    throw new ResearchError("redaction_failed", `redaction failed: ${error.message}`);
  }
  const buffer = Buffer.from(sanitized, "utf8");
  const parsed = path.parse(original.storage_ref);
  const derivativeRel = path.posix.join(path.posix.dirname(original.storage_ref), `${parsed.name}.redacted${parsed.ext}`);
  const derivativeAbs = path.join(root, derivativeRel);
  try {
    workspace.atomicWrite(root, derivativeAbs, buffer);
  } catch (error) {
    throw new ResearchError("redaction_failed", `could not write sanitized derivative: ${error.message}`);
  }
  const digest = sha256Hex(buffer);
  const derivative = kernel().registerArtifact({
    type: "research-evidence",
    name: `${original.name}.redacted`,
    project_id: original.project_id || undefined,
    execution_id: original.execution_id || undefined,
    producer: "security-research",
    storage_ref: workspace.relToWorkspace(root, derivativeAbs),
    content_type: original.content_type || "text/plain",
    byte_size: buffer.length,
    content_hash: `sha256:${digest}`,
    retention_class: original.retention_class || "standard",
    sensitivity: "normal",
    redaction_state: "redacted",
    lineage: { role: "derivative" },
    supersedes_artifact_id: original.artifact_id,
    verification: { algorithm: "sha256", digest, derived_from: original.artifact_id },
    metadata: { ...original.metadata, derivative_of: original.artifact_id },
    source: "security-research",
  });
  return {
    evidence_id: derivative.artifact_id,
    reference: `artifact:${derivative.artifact_id}`,
    supersedes: original.artifact_id,
    content_hash: derivative.content_hash,
    byte_size: derivative.byte_size,
    storage_ref: derivative.storage_ref,
    redaction_state: derivative.redaction_state,
  };
}

// Resolve opaque artifact:<id> references to metadata (never bytes), using the
// pre-existing evidence-vault contract with the kernel resolver injected.
function inspect(references, { projectId } = {}) {
  const vault = evidenceVault();
  const k = kernel();
  return vault.resolveEvidenceReferences(references, {
    resolve: (artifactId) => {
      const artifact = requireProjectArtifact(k.getArtifact(artifactId), projectId);
      if (!artifact) return null;
      return {
        artifact_id: artifact.artifact_id,
        content_hash: artifact.content_hash,
        custody_role: artifact.custody_role,
        redaction_state: artifact.redaction_state,
      };
    },
  });
}

function list(query) {
  return kernel().listArtifacts(query || {}).filter((a) => a.type === "research-evidence").map((a) => ({
    evidence_id: a.artifact_id,
    reference: `artifact:${a.artifact_id}`,
    name: a.name,
    content_hash: a.content_hash,
    byte_size: a.byte_size,
    custody_role: a.custody_role,
    sensitivity: a.sensitivity,
    redaction_state: a.redaction_state,
    storage_ref: a.storage_ref,
    research_run_id: a.metadata && a.metadata.research_run_id,
  }));
}

module.exports = { capture, redactEvidence, inspect, list, sha256Hex };
