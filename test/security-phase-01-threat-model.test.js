"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const artifact = fs.readFileSync(
  path.join(__dirname, "..", "docs", "archive", "security-audits", "security-phase-01-threat-model.md"),
  "utf8"
);

const requiredSections = [
  "## System and trust boundaries",
  "## Assets",
  "## Identities and authority",
  "## External entry points and execution paths",
  "## Attacker catalogue",
  "## Primary abuse cases",
  "## Phase-gate mapping",
  "## Evidence and current residuals"
];

for (const section of requiredSections) {
  assert.ok(artifact.includes(section), `Phase 1 artifact is missing ${section}`);
}

for (const service of ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"]) {
  assert.ok(artifact.includes(service), `Phase 1 artifact must name ${service}`);
}

for (const boundary of ["authenticated server-side context", "Compute workers/providers", "Installed packs/modules"]) {
  assert.ok(artifact.includes(boundary), `Phase 1 artifact must record ${boundary}`);
}

assert.ok(!/SIDEKICK_SECRET_KEY\s*=\s*[^`\s]+/.test(artifact), "Threat model must not contain secret values");
console.log("Phase 1 threat-model artifact checks passed.");
