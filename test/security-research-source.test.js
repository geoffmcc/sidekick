"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-db-"));
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-workspace-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-fixture-"));
const sourceRevisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-revision-"));
const decoyRevisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sr-decoy-revision-"));
process.env.SIDEKICK_DATA_DIR = data;
process.env.SIDEKICK_DB_FILE = path.join(data, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "security-research-source-test-secret";

require(path.join(REPO, "src/db")).runPendingMigrations();
const db = require(path.join(REPO, "src/db"));
const identity = require(path.join(REPO, "src/core/identity"));
const owner = identity.bootstrapOwner({ username: `source-test-${process.pid}`, password: "source-test-password-123" });
const ownerAuthority = { principal_id: owner.principal_id, principal_type: "human", scopes: null };
const kernel = require(path.join(REPO, "src/platform/kernel"));
const projectAccess = require(path.join(REPO, "src/core/project-access"));
const authorization = require(path.join(REPO, "src/core/authorization"));
const source = require(path.join(REPO, "packs/security-research/modules/security-research-tools/lib/source"));
const workspace = require(path.join(REPO, "packs/security-research/modules/security-research-tools/lib/workspace"));
const crypto = require("crypto");

function expectCode(code, fn) {
  assert.throws(fn, (error) => error && error.code === code, `expected ${code}`);
}

function runSource(services, args, actor = "test", authIdentity = ownerAuthority) {
  return source.execute(services, args, actor, authIdentity);
}

async function main() {
fs.mkdirSync(path.join(fixture, "nested"));
fs.writeFileSync(path.join(fixture, "README.txt"), "fixture\n");
fs.writeFileSync(path.join(fixture, "nested", "service.txt"), "status=403\n");
function createRevisionFixture(root, name) {
  execFileSync("git", ["init", "-q", root]);
  fs.writeFileSync(path.join(root, "revision.txt"), `${name}\n`);
  const config = ["-c", "user.name=Security Test", "-c", "user.email=security-test@example.test", "-c", "commit.gpgsign=false"];
  execFileSync("git", ["-C", root, ...config, "add", "revision.txt"]);
  execFileSync("git", ["-C", root, ...config, "commit", "-q", "-m", name]);
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
const expectedSourceRevision = createRevisionFixture(sourceRevisionRoot, "source-revision");
const decoyRevision = createRevisionFixture(decoyRevisionRoot, "decoy-revision");
const oldGitDir = process.env.GIT_DIR;
const oldGitWorkTree = process.env.GIT_WORK_TREE;
try {
  process.env.GIT_DIR = path.join(decoyRevisionRoot, ".git");
  process.env.GIT_WORK_TREE = decoyRevisionRoot;
  assert.strictEqual(execFileSync("git", ["-C", sourceRevisionRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), decoyRevision, "the hostile inherited Git selectors redirect the unsanitized baseline");
  assert.strictEqual(source.sourceRevision(sourceRevisionRoot), expectedSourceRevision, "source provenance must resolve from the requested repo despite inherited Git selectors");
} finally {
  if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir;
  if (oldGitWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldGitWorkTree;
}
const campaign = kernel.createResearchCampaign({ project_id: "source_fixture", name: "source", created_by: "test" });
kernel.registerProject({ project_id: "source_fixture", owner_actor_id: owner.principal_id, source: "test" });
const outsider = identity.createPrincipal({ type: "service", displayName: "Unrelated research reader" });
identity.assignRole(outsider.principal_id, "administrator", owner.principal_id);
const outsiderAuthority = { principal_id: outsider.principal_id, principal_type: "service", scopes: ["tools.execute_high"] };
assert.equal(authorization.authorize({ principalId: outsider.principal_id, permission: "tools.execute_high", credentialScopes: outsiderAuthority.scopes }).ok, true, "the unrelated principal can execute the high-risk research tool");
const services = { config: { workspace: workspaceRoot } };

expectCode("authorization_failed", () => source.execute(services, { action: "list", project_id: "source_fixture" }, "identityless"));
expectCode("not_found", () => runSource(services, { action: "list", project_id: "source_fixture" }, "outsider", outsiderAuthority));
projectAccess.grantProjectAccess({ actorPrincipalId: owner.principal_id, principalId: outsider.principal_id, project: "source_fixture", accessLevel: "read" });
assert.deepStrictEqual(runSource(services, { action: "list", project_id: "source_fixture" }, "outsider", outsiderAuthority).repositories, [], "a read membership permits project-scoped listing");
expectCode("not_found", () => runSource(services, { action: "import", campaign_id: campaign.campaign_id, project_id: "source_fixture", name: "unauthorized-write", source_path: fixture }, "outsider", outsiderAuthority));

const imported = runSource(services, { action: "import", campaign_id: campaign.campaign_id, name: "fixture", source_path: fixture }, "test");
assert.strictEqual(imported.snapshot.state, "finalized");
assert.strictEqual(imported.snapshot.authority, "derived_analysis_input");
assert.strictEqual(imported.verification.verified, true);
assert.strictEqual(imported.snapshot.file_count, 2);
assert.ok(imported.snapshot.storage_ref.startsWith(`projects/${campaign.campaign_id}/repositories/`));
assert.strictEqual(runSource(services, { action: "verify", campaign_id: campaign.campaign_id, project_id: "SOURCE-FIXTURE", repository_id: imported.repository.repository_id, snapshot_id: imported.snapshot.snapshot_id }, "test").verification.verified, true, "Project ownership checks should use canonical identity");
expectCode("not_found", () => runSource(services, { action: "get", campaign_id: campaign.campaign_id, project_id: "wrong-project", repository_id: imported.repository.repository_id, snapshot_id: imported.snapshot.snapshot_id }, "test"));
assert.ok(!path.isAbsolute(imported.snapshot.storage_ref));

const repositoryId = imported.repository.repository_id;
const snapshotId = imported.snapshot.snapshot_id;
kernel.registerProject({ project_id: "source_foreign_fixture", owner_actor_id: owner.principal_id, source: "test" });
const foreignCampaign = kernel.createResearchCampaign({ project_id: "source_foreign_fixture", name: "foreign source", created_by: owner.principal_id });
const foreignRepository = kernel.createResearchSourceRepository({ campaign_id: foreignCampaign.campaign_id, project_id: foreignCampaign.project_id, name: "foreign", created_by: owner.principal_id });
const foreignSnapshot = kernel.createResearchSourceSnapshot({ repository_id: foreignRepository.repository_id, campaign_id: foreignCampaign.campaign_id, project_id: foreignCampaign.project_id, storage_ref: "projects/foreign/snapshot", content_hash: `sha256:${"b".repeat(64)}`, created_by: owner.principal_id });
expectCode("not_found", () => runSource(services, { action: "compare", project_id: "source_fixture", repository_id: repositoryId, campaign_id: campaign.campaign_id, baseline_snapshot_id: snapshotId, candidate_snapshot_id: foreignSnapshot.snapshot_id }));
assert.strictEqual(runSource(services, { action: "select", repository_id: repositoryId, snapshot_id: snapshotId }, "test").repository.selected_snapshot_id, snapshotId);
const evidence = kernel.registerArtifact({ type: "research-evidence", name: "authority-support", project_id: campaign.project_id, storage_ref: "evidence/authority-support.json", content_hash: `sha256:${"a".repeat(64)}`, byte_size: 1, created_by_principal_id: "runtime-actor" });
expectCode("invalid_input", () => runSource(services, { action: "authority", authority_action: "declare", repository_id: repositoryId, snapshot_id: snapshotId, authority_class: "declared_source_authority", scope: { repository: repositoryId }, evidence_refs: [] }, "runtime-actor"));
const claim = runSource(services, { action: "authority", authority_action: "declare", repository_id: repositoryId, snapshot_id: snapshotId, authority_class: "declared_source_authority", scope: { repository: repositoryId, ref: "fixture" }, evidence_refs: [`artifact:${evidence.artifact_id}`], actor: "spoofed-actor", metadata: { reason: "fixture" } }, "runtime-actor").claim;
assert.strictEqual(claim.authority_class, "declared_source_authority");
assert.strictEqual(claim.declaring_actor, "runtime-actor");
assert.strictEqual(claim.snapshot_id, snapshotId);
assert.deepStrictEqual(runSource(services, { action: "authority", authority_action: "list", snapshot_id: snapshotId }, "runtime-actor").claims.map(item => item.claim_id), [claim.claim_id]);
assert.strictEqual(kernel.getResearchSourceSnapshot(snapshotId).authority, "derived_analysis_input");
fs.appendFileSync(path.join(workspaceRoot, imported.snapshot.storage_ref, "README.txt"), "changed\n");
assert.strictEqual(runSource(services, { action: "verify", repository_id: repositoryId, snapshot_id: snapshotId }, "test").verification.state, "stale");
expectCode("state_conflict", () => runSource(services, { action: "select", repository_id: repositoryId, snapshot_id: snapshotId }, "test"));

const symlinkFixture = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-symlink-"));
fs.symlinkSync(path.join(fixture, "README.txt"), path.join(symlinkFixture, "link.txt"));
expectCode("invalid_input", () => runSource(services, { action: "import", campaign_id: campaign.campaign_id, name: "symlink", source_path: symlinkFixture }, "test"));
expectCode("invalid_input", () => workspace.safeSegment("../escape", "snapshot_id"));

const secondFixture = fs.mkdtempSync(path.join(os.tmpdir(), "sr-source-second-"));
fs.writeFileSync(path.join(secondFixture, "new.txt"), "new\n");
const second = runSource(services, { action: "import", campaign_id: campaign.campaign_id, repository_id: repositoryId, source_path: secondFixture }, "test");
const refreshed = runSource(services, { action: "refresh", campaign_id: campaign.campaign_id, repository_id: repositoryId, snapshot_id: second.snapshot.snapshot_id }, "test");
assert.notStrictEqual(refreshed.snapshot.snapshot_id, second.snapshot.snapshot_id);
assert.strictEqual(refreshed.snapshot.metadata.refreshed_from_snapshot_id, second.snapshot.snapshot_id);
const compared = runSource(services, { action: "compare", campaign_id: campaign.campaign_id, repository_id: repositoryId, baseline_snapshot_id: second.snapshot.snapshot_id, candidate_snapshot_id: refreshed.snapshot.snapshot_id }, "test");
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
const indexed = await runSource(semanticServices, { action: "index", campaign_id: campaign.campaign_id, repository_id: repositoryId, snapshot_id: refreshed.snapshot.snapshot_id }, "test");
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
const acquired = await runSource(acquireServices, { action: "acquire", campaign_id: campaign.campaign_id, name: "acquired", source_url: "https://example.test/fixture.git", ref: "fixture" }, "test");
assert.strictEqual(cloneDispatch.args.source_url, "https://example.test/fixture.git");
assert.strictEqual(acquired.snapshot.metadata.import_kind, "git_clone");
assert.strictEqual(acquired.snapshot.metadata.resolved_ref, "a".repeat(40));
assert.strictEqual(acquired.verification.verified, true);
assert.ok(!fs.readdirSync(path.join(workspaceRoot, "projects", campaign.campaign_id, "repositories", acquired.repository.repository_id)).some(name => name.includes("staging")));

const failedAcquireServices = {
  config: { workspace: workspaceRoot },
  dispatch: async () => { throw new Error("synthetic clone failure"); },
};
await assert.rejects(() => runSource(failedAcquireServices, { action: "acquire", campaign_id: campaign.campaign_id, name: "failed-acquire", source_url: "https://example.test/failure.git" }, "test"), /synthetic clone failure/);
const failedRepositories = kernel.listResearchSourceRepositories({ campaign_id: campaign.campaign_id, state: "archived" });
assert.ok(failedRepositories.some(repository => repository.name === "failed-acquire"), "failed acquisition should archive its newly created repository");

const workspaceSource = path.join(workspaceRoot, "input");
fs.mkdirSync(workspaceSource);
expectCode("workspace_unsafe", () => runSource(services, { action: "import", campaign_id: campaign.campaign_id, name: "workspace-input", source_path: workspaceSource }, "test"));
expectCode("not_found", () => runSource(services, { action: "verify", campaign_id: campaign.campaign_id, project_id: "wrong-project", repository_id: repositoryId, snapshot_id: refreshed.snapshot.snapshot_id }, "test"));

runSource(services, { action: "archive", repository_id: repositoryId, snapshot_id: second.snapshot.snapshot_id }, "test");
expectCode("state_conflict", () => runSource(services, { action: "remove", repository_id: repositoryId, snapshot_id: snapshotId }, "test"));
assert.strictEqual(runSource(services, { action: "remove", repository_id: repositoryId, snapshot_id: second.snapshot.snapshot_id }, "test").snapshot.state, "removed");

db.closeDatabase?.();
fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(workspaceRoot, { recursive: true, force: true });
fs.rmSync(fixture, { recursive: true, force: true });
fs.rmSync(sourceRevisionRoot, { recursive: true, force: true });
fs.rmSync(decoyRevisionRoot, { recursive: true, force: true });
fs.rmSync(symlinkFixture, { recursive: true, force: true });
fs.rmSync(secondFixture, { recursive: true, force: true });
console.log("All security-research source tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
