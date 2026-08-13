"use strict";

/**
 * Accessors for the Sidekick platform primitives this pack composes.
 *
 * The security-research DOMAIN already exists inside the platform kernel
 * (migrations 032-035: scope snapshots and guard, campaigns, hypotheses, test
 * runs, findings, reports, disclosures, artifact custody with SHA-256 lineage).
 * This pack is the governed tool/workflow surface over that existing layer plus
 * the filesystem/composition pieces the kernel deliberately does not own — it
 * does NOT re-implement the record layer.
 *
 * Everything is resolved lazily through the install-root-aware resolver so the
 * pack shares the running server's single kernel instance (one database, one
 * event ledger), never a second copy.
 */

const { requireSidekickSrc } = require("./deps");

let _kernel = null;
let _redact = null;
let _labPolicy = null;
let _evidenceVault = null;

function kernel() {
  if (!_kernel) _kernel = requireSidekickSrc("src/platform/kernel.js");
  return _kernel;
}

function redact() {
  if (!_redact) _redact = requireSidekickSrc("src/redact.js");
  return _redact;
}

// The pure fail-closed lab policy already shipped in src/security-research/.
function labPolicy() {
  if (!_labPolicy) _labPolicy = requireSidekickSrc("src/security-research/lab-policy.js");
  return _labPolicy;
}

// The evidence-reference contract already shipped in src/security-research/. It
// validates opaque artifact:<id> references and resolves them through an
// injected resolver — we inject kernel.getArtifact.
function evidenceVault() {
  if (!_evidenceVault) _evidenceVault = requireSidekickSrc("src/security-research/evidence-vault.js");
  return _evidenceVault;
}

module.exports = { kernel, redact, labPolicy, evidenceVault };
