"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");

test("package CI generates, validates, and publishes a CycloneDX SBOM", () => {
  assert.match(workflow, /npm sbom --package-lock-only --sbom-format=cyclonedx --sbom-type=application > sidekick\.cdx\.json/);
  assert.match(workflow, /bom\.bomFormat !== 'CycloneDX'/);
  assert.match(workflow, /Array\.isArray\(bom\.components\).*Array\.isArray\(bom\.dependencies\).*bom\.components\.length === 0/);
  assert.match(workflow, /uses: actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+name: sidekick-cyclonedx-sbom\n\s+path: sidekick\.cdx\.json\n\s+if-no-files-found: error\n\s+retention-days: 14/);
});
