"use strict";

/**
 * Report material.
 *
 * Produces the structured input a human later turns into a responsible
 * disclosure report. Nothing here publishes, emails, or submits anything — that
 * remains a separate, explicit action. Every claim can reference evidence ids so
 * the material stays evidence-linked rather than free model prose, and the
 * material document is written into the private workspace, not the repository.
 */

const path = require("path");
const { kernel } = require("./platform");
const { ResearchError } = require("./errors");
const workspace = require("./workspace");
const evidence = require("./evidence");
const records = require("./records");
const runs = require("./runs");
const { requireText } = require("./identity");

// Validate that every referenced evidence id resolves, so a report cannot claim
// support from evidence that does not exist.
function verifyEvidenceRefs(refs) {
  const k = kernel();
  const resolved = [];
  for (const ref of refs) {
    const id = String(ref).replace(/^artifact:/, "");
    const artifact = k.getArtifact(id);
    if (!artifact) throw new ResearchError("not_found", `report references unknown evidence: ${ref}`);
    resolved.push({ reference: `artifact:${id}`, content_hash: artifact.content_hash, redaction_state: artifact.redaction_state });
  }
  return resolved;
}

/**
 * Materialize report material into the workspace and create the kernel report
 * record. Returns { report, material_ref }.
 */
function materialize(ctx, input, actor) {
  const campaign = records.getCampaign(requireText(input.campaign_id, "campaign_id"));
  const findingRefs = Array.isArray(input.finding_refs) ? input.finding_refs : [];

  // Collect evidence: explicit claim evidence + any run evidence.
  const claims = Array.isArray(input.claims) ? input.claims : [];
  const evidenceRefs = new Set();
  for (const claim of claims) {
    for (const ref of (claim.evidence_refs || [])) evidenceRefs.add(ref);
  }
  if (input.run_id) {
    // Use the run's ARTIFACT-DERIVED evidence (the same source runs.get exposes),
    // not the raw kernel test_run.evidence_json — the latter is only populated on
    // completion, so a running run with captured evidence would otherwise report
    // zero evidence.
    let run = null;
    try { run = runs.get(input.run_id); } catch { run = null; }
    if (run) for (const ref of (run.evidence || [])) evidenceRefs.add(ref);
  }
  const verifiedEvidence = verifyEvidenceRefs([...evidenceRefs]);

  const material = {
    schema: "security-research/report-material/v1",
    title: requireText(input.title, "title"),
    campaign_id: campaign.campaign_id,
    project_id: campaign.project_id,
    generated_at: new Date().toISOString(),
    summary: input.summary || null,
    affected_versions: input.affected_versions || null,
    tested_versions: input.tested_versions || null,
    environment: input.environment || null,
    reproduction: input.reproduction || null,
    observed_behavior: input.observed_behavior || null,
    expected_behavior: input.expected_behavior || null,
    impact: input.impact || null,
    comparison: input.comparison || null,
    validation: input.validation || null,
    limitations: input.limitations || null,
    confidence: input.confidence || "unverified",
    claims: claims.map((c) => ({ statement: c.statement, disposition: c.disposition || "observed", evidence_refs: c.evidence_refs || [] })),
    finding_refs: findingRefs,
    evidence: verifiedEvidence,
  };

  // Write the material document into the workspace and register custody.
  const dir = workspace.reportDir(ctx.root, campaign.campaign_id);
  const filename = `report-material-${Date.now()}.json`;
  const abs = path.join(dir, filename);
  const buffer = Buffer.from(JSON.stringify(material, null, 2), "utf8");
  workspace.atomicWrite(ctx.root, abs, buffer);
  const digest = evidence.sha256Hex(buffer);
  const artifact = kernel().registerArtifact({
    type: "research-report-material",
    name: filename,
    project_id: campaign.project_id,
    producer: "security-research",
    storage_ref: workspace.relToWorkspace(ctx.root, abs),
    content_type: "application/json",
    byte_size: buffer.length,
    content_hash: `sha256:${digest}`,
    retention_class: "standard",
    sensitivity: "sensitive",
    redaction_state: "none",
    lineage: { role: "original" },
    verification: { algorithm: "sha256", digest },
    metadata: { campaign_id: campaign.campaign_id, kind: "report-material" },
    source: "security-research",
  });

  const report = records.createReport({
    campaign_id: campaign.campaign_id,
    title: material.title,
    status: input.status || "draft",
    finding_refs: findingRefs,
    artifact_id: artifact.artifact_id,
    metadata: { material_ref: `artifact:${artifact.artifact_id}`, evidence_count: verifiedEvidence.length },
  }, actor);

  return {
    report,
    material_ref: `artifact:${artifact.artifact_id}`,
    material_storage_ref: artifact.storage_ref,
    evidence_count: verifiedEvidence.length,
    finding_count: findingRefs.length,
  };
}

module.exports = { materialize, verifyEvidenceRefs };
