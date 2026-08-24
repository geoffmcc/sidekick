"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-db-"));
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-workspace-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-fixture-"));
process.env.SIDEKICK_DATA_DIR = data;
process.env.SIDEKICK_DB_FILE = path.join(data, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "security-research-source-test-secret";

require(path.join(REPO, "src/db")).runPendingMigrations();
const kernel = require(path.join(REPO, "src/platform/kernel"));
const source = require(path.join(REPO, "packs/security-research/modules/security-research-tools/lib/source"));
const workspace = require(path.join(REPO, "packs/security-research/modules/security-research-tools/lib/workspace"));
const crypto = require("crypto");

function expectCode(code, fn) {
  assert.throws(fn, (error) => error && error.code === code, `expected ${code}`);
}

async function main() {
fs.mkdirSync(path.join(fixture, "nested"));
fs.writeFileSync(path.join(fixture, "README.txt"), "fixture\n");
fs.writeFileSync(path.join(fixture, "nested", "service.txt"), "status=403\n");
const campaign = kernel.createResearchCampaign({ project_id: "source_fixture", name: "source", created_by: "test" });
const services = { config: { workspace: workspaceRoot } };

const imported = source.execute(services, { action: "import", campaign_id: campaign.campaign_id, name: "fixture", source_path: fixture }, "test");
assert.strictEqual(imported.snapshot.state, "finalized");
assert.strictEqual(imported.snapshot.authority, "derived_analysis_input");
assert.strictEqual(imported.verification.verified, true);
assert.strictEqual(imported.snapshot.file_count, 2);
assert.ok(imported.snapshot.storage_ref.startsWith(`projects/${campaign.campaign_id}/repositories/`));
assert.ok(!path.isAbsolute(imported.snapshot.storage_ref));

const repositoryId = imported.repository.repository_id;
const snapshotId = imported.snapshot.snapshot_id;
assert.strictEqual(source.execute(services, { action: "select", repository_id: repositoryId, snapshot_id: snapshotId }, "test").repository.selected_snapshot_id, snapshotId);
const evidence = kernel.registerArtifact({ type: "research-evidence", name: "authority-support", project_id: campaign.project_id, storage_ref: "evidence/authority-support.json", content_hash: `sha256:${"a".repeat(64)}`, byte_size: 1, created_by_principal_id: "runtime-actor" });
expectCode("invalid_input", () => source.execute(services, { action: "authority", authority_action: "declare", repository_id: repositoryId, snapshot_id: snapshotId, authority_class: "declared_source_authority", scope: { repository: repositoryId }, evidence_refs: [] }, "runtime-actor"));
const claim = source.execute(services, { action: "authority", authority_action: "declare", repository_id: repositoryId, snapshot_id: snapshotId, authority_class: "declared_source_authority", scope: { repository: repositoryId, ref: "fixture" }, evidence_refs: [`artifact:${evidence.artifact_id}`], actor: "spoofed-actor", metadata: { reason: "fixture" } }, "runtime-actor").claim;
assert.strictEqual(claim.authority_class, "declared_source_authority");
assert.strictEqual(claim.declaring_actor, "runtime-actor");
assert.strictEqual(claim.snapshot_id, snapshotId);
assert.deepStrictEqual(source.execute(services, { action: "authority", authority_action: "list", snapshot_id: snapshotId }, "runtime-actor").claims.map(item => item.claim_id), [claim.claim_id]);
assert.strictEqual(kernel.getResearchSourceSnapshot(snapshotId).authority, "derived_analysis_input");
fs.appendFileSync(path.join(workspaceRoot, imported.snapshot.storage_ref, "README.txt"), "changed\n");
assert.strictEqual(source.execute(services, { action: "verify", repository_id: repositoryId, snapshot_id: snapshotId }, "test").verification.state, "stale");
expectCode("state_conflict", () => source.execute(services, { action: "select", repository_id: repositoryId, snapshot_id: snapshotId }, "test"));

const symlinkFixture = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-symlink-"));
fs.symlinkSync(path.join(fixture, "README.txt"), path.join(symlinkFixture, "link.txt"));
expectCode("invalid_input", () => source.execute(services, { action: "import", campaign_id: campaign.campaign_id, name: "symlink", source_path: symlinkFixture }, "test"));
expectCode("invalid_input", () => workspace.safeSegment("../escape", "snapshot_id"));

const secondFixture = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-second-"));
fs.writeFileSync(path.join(secondFixture, "new.txt"), "new\n");
const second = source.execute(services, { action: "import", campaign_id: campaign.campaign_id, repository_id: repositoryId, source_path: secondFixture }, "test");
const refreshed = source.execute(services, { action: "refresh", campaign_id: campaign.campaign_id, repository_id: repositoryId, snapshot_id: second.snapshot.snapshot_id }, "test");
assert.notStrictEqual(refreshed.snapshot.snapshot_id, second.snapshot.snapshot_id);
assert.strictEqual(refreshed.snapshot.metadata.refreshed_from_snapshot_id, second.snapshot.snapshot_id);
const compared = source.execute(services, { action: "compare", campaign_id: campaign.campaign_id, repository_id: repositoryId, baseline_snapshot_id: second.snapshot.snapshot_id, candidate_snapshot_id: refreshed.snapshot.snapshot_id }, "test");
assert.strictEqual(compared.changed, false);
assert.deepStrictEqual(compared.baseline.snapshot_id, second.snapshot.snapshot_id);
assert.deepStrictEqual(compared.candidate.content_hash, refreshed.snapshot.content_hash);

const semanticPath = path.join(workspaceRoot, refreshed.snapshot.storage_ref);
const semanticIdentity = crypto.createHash("sha256").update("sidekick.semantic.repository.v1\0").update(path.resolve(semanticPath)).digest("hex");
let dispatchArgs = null;
const semanticServices = {
  config: { workspace: workspaceRoot },
  dispatch: async (name, args) => {
    dispatchArgs = { name, args };
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool: "semantic_repo", index_root_hash: "index-hash", provenance: { repository_identity: semanticIdentity, index_root_hash: "index-hash" } }) }] };
  },
};
const indexed = await source.execute(semanticServices, { action: "index", campaign_id: campaign.campaign_id, repository_id: repositoryId, snapshot_id: refreshed.snapshot.snapshot_id }, "test");
assert.strictEqual(dispatchArgs.name, "semantic_repo");
assert.strictEqual(dispatchArgs.args.path, semanticPath);
assert.strictEqual(indexed.provenance.snapshot_id, refreshed.snapshot.snapshot_id);
assert.strictEqual(indexed.provenance.snapshot_content_hash, refreshed.snapshot.content_hash);

let cloneDispatch = null;
const acquireServices = {
  config: { workspace: workspaceRoot },
  // Synthetic local fixture only: no public network is used by this test.
  dispatch: async (name, args) => {
    cloneDispatch = { name, args };
    assert.strictEqual(name, "git");
    assert.strictEqual(args.action, "clone");
    fs.cpSync(fixture, args.destination, { recursive: true });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "clone", destination: args.destination, requested_ref: "fixture", resolved_ref: "a".repeat(40), remote_identity: { scheme: "https", host: "example.test", path: "/fixture.git" } }) }] };
  },
};
const acquired = await source.execute(acquireServices, { action: "acquire", campaign_id: campaign.campaign_id, name: "acquired", source_url: "https://example.test/fixture.git", ref: "fixture" }, "test");
assert.strictEqual(cloneDispatch.args.source_url, "https://example.test/fixture.git");
assert.strictEqual(acquired.snapshot.metadata.import_kind, "git_clone");
assert.strictEqual(acquired.snapshot.metadata.resolved_ref, "a".repeat(40));
assert.strictEqual(acquired.verification.verified, true);
assert.ok(!fs.readdirSync(path.join(workspaceRoot, "projects", campaign.campaign_id, "repositories", acquired.repository.repository_id)).some(name => name.includes("staging")));

const workspaceSource = path.join(workspaceRoot, "input");
fs.mkdirSync(workspaceSource);
expectCode("workspace_unsafe", () => source.execute(services, { action: "import", campaign_id: campaign.campaign_id, name: "workspace-input", source_path: workspaceSource }, "test"));
expectCode("not_found", () => source.execute(services, { action: "verify", campaign_id: campaign.campaign_id, project_id: "wrong-project", repository_id: repositoryId, snapshot_id: refreshed.snapshot.snapshot_id }, "test"));

source.execute(services, { action: "archive", repository_id: repositoryId, snapshot_id: second.snapshot.snapshot_id }, "test");
expectCode("state_conflict", () => source.execute(services, { action: "remove", repository_id: repositoryId, snapshot_id: snapshotId }, "test"));
assert.strictEqual(source.execute(services, { action: "remove", repository_id: repositoryId, snapshot_id: second.snapshot.snapshot_id }, "test").snapshot.state, "removed");

fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(workspaceRoot, { recursive: true, force: true });
fs.rmSync(fixture, { recursive: true, force: true });
fs.rmSync(symlinkFixture, { recursive: true, force: true });
fs.rmSync(secondFixture, { recursive: true, force: true });
console.log("All security-research source tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
