"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "test-data-artifact-resource-scope");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";

delete require.cache[require.resolve("../src/db")];
const kernel = require("../src/platform/kernel");

const HASH = "b".repeat(64);
function register(artifactId, projectId, owner, creator) {
  return kernel.registerArtifact({
    artifact_id: artifactId,
    project_id: projectId,
    owner_principal_id: owner,
    created_by_principal_id: creator,
    storage_ref: `artifacts/${artifactId}`,
    content_hash: HASH,
    metadata: { fixture: true },
  });
}

register("art_scope_a", "project_a", "principal_a", "principal_a");
register("art_scope_b", "project_a", "principal_b", "principal_b");
register("art_scope_other_project", "project_b", "principal_a", "principal_a");

const principalA = kernel.listArtifacts({ project_id: "project_a", principal_id: "principal_a" });
assert.deepStrictEqual(principalA.map(artifact => artifact.artifact_id), ["art_scope_a"], "principal scope returns only owned/created metadata in the project");
assert.strictEqual(principalA.some(a => a.artifact_id === "art_scope_b"), false, "another principal's artifact is excluded");
assert.strictEqual(principalA.some(a => a.artifact_id === "art_scope_other_project"), false, "another project's artifact is excluded");
assert.ok(kernel.getArtifact("art_scope_b"), "unscoped internal custody reads remain available");
assert.throws(() => kernel.registerArtifact({
  artifact_id: "art_cross_project_derivative",
  project_id: "project_b",
  supersedes_artifact_id: "art_scope_a",
  lineage: { role: "derivative" },
  storage_ref: "artifacts/art_cross_project_derivative",
}), /same project/, "lineage cannot cross project boundaries");

fs.rmSync(dataDir, { recursive: true, force: true });
console.log("Artifact resource scope tests passed");
