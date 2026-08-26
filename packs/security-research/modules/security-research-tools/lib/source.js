"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { kernel } = require("./platform");
const workspace = require("./workspace");
const { ResearchError } = require("./errors");
const { requireText } = require("./identity");
const { canonicalizeProjectName } = require("../../../../../src/core/project-identity");

const DEFAULT_LIMITS = Object.freeze({ max_files: 10000, max_bytes: 100 * 1024 * 1024, max_depth: 32, max_path_bytes: 4096 });

function limits(config = {}) {
  const configured = config.source_limits || {};
  return {
    max_files: Math.min(Math.max(Number(configured.max_files) || DEFAULT_LIMITS.max_files, 1), DEFAULT_LIMITS.max_files),
    max_bytes: Math.min(Math.max(Number(configured.max_bytes) || DEFAULT_LIMITS.max_bytes, 1), DEFAULT_LIMITS.max_bytes),
    max_depth: Math.min(Math.max(Number(configured.max_depth) || DEFAULT_LIMITS.max_depth, 1), DEFAULT_LIMITS.max_depth),
    max_path_bytes: Math.min(Math.max(Number(configured.max_path_bytes) || DEFAULT_LIMITS.max_path_bytes, 1), DEFAULT_LIMITS.max_path_bytes),
  };
}

function fail(code, message, details) { throw new ResearchError(code, message, details); }
function kernelCall(fn) {
  try { return fn(); } catch (error) {
    const message = String(error && error.message || "source lifecycle failed");
    if (/referenced by repository|cannot select|only an active|transition/i.test(message)) fail("state_conflict", message);
    if (/not found|must reference|must belong|must match/i.test(message)) fail("not_found", message);
    fail("invalid_input", message);
  }
}
function safeId(value, name) { return workspace.safeSegment(requireText(value, name), name); }
function sameProject(left, right) {
  return canonicalizeProjectName(left) === canonicalizeProjectName(right);
}
function hashBuffer(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function manifestHash(entries) { return `sha256:${hashBuffer(Buffer.from(JSON.stringify(entries)))}`; }

function sourceAuthority(sourceRoot, workspaceRoot, metadata = {}) {
  if (metadata.source_authority) return metadata.source_authority;
  if (metadata.import_kind === "git_clone") return "sidekick_mirror";
  if (String(sourceRoot).startsWith("/mnt/") || String(sourceRoot).startsWith("/home/")) return "local_wsl";
  if (workspaceRoot && workspace.contains(workspaceRoot, sourceRoot)) return "sidekick_mirror";
  return "unverified";
}

function sourceRevision(sourceRoot, metadata = {}) {
  if (metadata.resolved_ref) return metadata.resolved_ref;
  try { return execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

function canonicalSource(sourcePath, workspaceRoot) {
  if (!path.isAbsolute(String(sourcePath || ""))) fail("invalid_input", "source_path must be absolute");
  try {
    const requested = fs.lstatSync(sourcePath);
    if (requested.isSymbolicLink()) fail("invalid_input", "source_path must not be a symbolic link");
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    fail("not_found", "source_path is unavailable");
  }
  let resolved;
  try { resolved = workspace.canonicalize(sourcePath); } catch (error) { throw error; }
  for (const root of workspace.protectedRoots()) {
    if (workspace.contains(root, resolved) || workspace.contains(resolved, root)) fail("workspace_unsafe", "source_path must not be a Sidekick protected location");
  }
  if (workspaceRoot && (workspace.contains(workspaceRoot, resolved) || workspace.contains(resolved, workspaceRoot))) {
    fail("workspace_unsafe", "source_path must be outside the research workspace");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid_input", "source_path must be a real directory");
  return resolved;
}

function inspectTree(root, config, destinationRoot = null) {
  const bound = limits(config);
  const entries = [];
  const seenInodes = new Set();
  let bytes = 0;
  let maxDepth = 0;
  function walk(current, relative, depth) {
    if (depth > bound.max_depth) fail("invalid_input", "source directory exceeds max_depth");
    maxDepth = Math.max(maxDepth, depth);
    const children = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name === "." || child.name === ".." || child.name.includes("\0")) fail("invalid_input", "source contains an unsafe filename");
      const rel = relative ? path.posix.join(relative, child.name) : child.name;
      if (destinationRoot && rel === "manifest.json") continue;
      if (!destinationRoot && rel === "manifest.json") fail("invalid_input", "source filename manifest.json is reserved");
      if (Buffer.byteLength(rel) > bound.max_path_bytes || rel.startsWith("/") || rel.split("/").includes("..")) fail("invalid_input", "source contains an unsafe relative path");
      const abs = path.join(current, child.name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail("invalid_input", "source contains a symlink or special file", { path: rel });
      if (stat.isDirectory()) { walk(abs, rel, depth + 1); continue; }
      const inode = `${stat.dev}:${stat.ino}`;
      if (seenInodes.has(inode)) fail("invalid_input", "source contains hard-linked files", { path: rel });
      seenInodes.add(inode);
      if (entries.length >= bound.max_files) fail("invalid_input", "source exceeds max_files");
      bytes += stat.size;
      if (bytes > bound.max_bytes) fail("invalid_input", "source exceeds max_bytes");
      const content = fs.readFileSync(abs);
      if (content.length !== stat.size) fail("invalid_input", "source changed while it was being read", { path: rel });
      entries.push({ path: rel, bytes: content.length, hash: `sha256:${hashBuffer(content)}` });
    }
  }
  walk(root, "", 0);
  return { entries, file_count: entries.length, byte_count: bytes, max_depth: maxDepth, content_hash: manifestHash(entries) };
}

function copyTree(sourceRoot, destinationRoot, manifest, config) {
  const bound = limits(config);
  for (const entry of manifest.entries) {
    const source = path.join(sourceRoot, ...entry.path.split("/"));
    const destination = path.join(destinationRoot, ...entry.path.split("/"));
    workspace.assertInside(destinationRoot, destination);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("invalid_input", "source changed to a non-regular file during import", { path: entry.path });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) fail("invalid_input", "source changed during import", { path: entry.path });
      const content = fs.readFileSync(fd);
      if (content.length !== entry.bytes || `sha256:${hashBuffer(content)}` !== entry.hash) fail("invalid_input", "source changed during import", { path: entry.path });
      fs.writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  const manifestPath = path.join(destinationRoot, "manifest.json");
  workspace.atomicWrite(destinationRoot, manifestPath, JSON.stringify({ version: 1, ...manifest }, null, 2));
  if (manifest.file_count > bound.max_files || manifest.byte_count > bound.max_bytes) fail("invalid_input", "source exceeds configured limits");
}

function repositoryContext(root, repository) {
  const project = workspace.projectDir(root, repository.campaign_id);
  const base = path.join(project, "repositories", safeId(repository.repository_id, "repository_id"));
  workspace.assertInside(root, base);
  return base;
}

function snapshotManifest(root, snapshot) {
  const directory = path.join(root, snapshot.storage_ref);
  workspace.assertInside(root, directory);
  const manifestPath = path.join(directory, "manifest.json");
  if (!fs.existsSync(manifestPath)) fail("state_conflict", "snapshot manifest is missing");
  let manifest;
  try { manifest = JSON.parse(workspace.readInside(root, manifestPath).toString("utf8")); } catch { fail("state_conflict", "snapshot manifest is invalid"); }
  if (!Array.isArray(manifest.entries) || typeof manifest.content_hash !== "string") fail("state_conflict", "snapshot manifest is incomplete");
  if (manifest.content_hash !== manifestHash(manifest.entries)) fail("state_conflict", "snapshot manifest hash is invalid");
  return { directory, manifest };
}

function verifySnapshot(root, snapshot, config = {}) {
  if (snapshot.state !== "finalized" && snapshot.state !== "archived") fail("state_conflict", `cannot verify snapshot in state ${snapshot.state}`);
  const { directory, manifest } = snapshotManifest(root, snapshot);
  const actual = inspectTree(directory, config, directory);
  const expectedEntries = manifest.entries;
  const same = JSON.stringify(actual.entries) === JSON.stringify(expectedEntries) && actual.content_hash === manifest.content_hash && actual.content_hash === snapshot.content_hash;
  const result = { snapshot_id: snapshot.snapshot_id, verified: same, state: same ? "verified" : "stale", expected_hash: snapshot.content_hash, actual_hash: actual.content_hash, expected_file_count: snapshot.file_count, actual_file_count: actual.file_count, expected_byte_count: snapshot.byte_count, actual_byte_count: actual.byte_count };
  kernel().markResearchSourceSnapshotVerification(snapshot.snapshot_id, result, { actor_id: null, source: "security-research" });
  return result;
}

function importDirectory(services, args, actor, sourceRootOverride = null, metadata = {}) {
  const root = workspace.resolveWorkspace(services.config || {}, { requireExists: false }).root;
  const requestedSource = requireText(args.source_path, "source_path");
  if (!sourceRootOverride && services.paths && typeof services.paths.enforce === "function") {
    const policyError = services.paths.enforce(requestedSource, "read");
    if (policyError) fail("path_denied", "source_path is not authorized for this execution", { policy: policyError });
  }
  const sourceRoot = sourceRootOverride || canonicalSource(requestedSource, root);
  const campaignId = requireText(args.campaign_id, "campaign_id");
  const manifest = inspectTree(sourceRoot, services.config || {}, sourceRootOverride ? sourceRoot : null);
  const authority = sourceAuthority(sourceRoot, root, metadata);
  const revision = sourceRevision(sourceRoot, metadata);
  let repository = args.repository_id ? kernel().getResearchSourceRepository(safeId(args.repository_id, "repository_id")) : null;
  if (repository && repository.campaign_id !== campaignId) fail("not_found", "source repository not found");
  if (repository && args.project_id && !sameProject(repository.project_id, args.project_id)) fail("not_found", "source repository not found");
  if (!repository) repository = kernelCall(() => kernel().createResearchSourceRepository({ campaign_id: campaignId, project_id: args.project_id, name: requireText(args.name || path.basename(sourceRoot), "name"), created_by: actor, metadata: { authority: "derived_analysis_input" }, source: "security-research" }));
  const operationId = metadata.operation_id || `source_op_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  metadata = { ...metadata, operation_id: operationId };
  const snapshotId = `source_snap_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  const base = repositoryContext(root, repository);
  const staging = path.join(base, `.${snapshotId}.staging`);
  const final = path.join(base, snapshotId);
  workspace.assertInside(root, staging);
  if (!sourceRootOverride && (workspace.contains(sourceRoot, base) || workspace.contains(base, sourceRoot))) fail("invalid_input", "source and destination directories must be separate");
  let snapshot = null;
  try {
    fs.mkdirSync(staging, { recursive: true });
    copyTree(sourceRoot, staging, manifest, services.config || {});
    fs.renameSync(staging, final);
    snapshot = kernelCall(() => kernel().createResearchSourceSnapshot({ repository_id: repository.repository_id, campaign_id: repository.campaign_id, storage_ref: workspace.relToWorkspace(root, final), content_hash: manifest.content_hash, source_root_hash: manifest.content_hash, file_count: manifest.file_count, byte_count: manifest.byte_count, max_depth: manifest.max_depth, authority: "derived_analysis_input", created_by: actor, state: "finalized", verification: { verified: true, manifest_version: 1 }, metadata: { import_kind: "directory", source_authority: authority, source_revision: revision, ...metadata }, source: "security-research" }));
    if (metadata && Object.keys(metadata).length) snapshot = kernelCall(() => kernel().updateResearchSourceSnapshotProvenance(snapshot.snapshot_id, { acquisition_operation_id: operationId, source_type: metadata.import_kind === "git_clone" ? "git" : "directory", requested_ref: metadata.requested_ref, resolved_commit_sha: metadata.resolved_ref, remote_identity: metadata.remote_identity ? JSON.stringify(metadata.remote_identity) : null, source_root_hash: manifest.content_hash, metadata, actor_id: actor, source: "security-research" }));
    return { repository, snapshot, verification: verifySnapshot(root, snapshot, services.config || {}) };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (snapshot) {
      try { kernel().removeResearchSourceSnapshot(snapshot.snapshot_id, { actor_id: actor, source: "security-research-recovery" }); } catch {}
    }
    fs.rmSync(final, { recursive: true, force: true });
    throw error;
  }
}

function getOwned(repositoryId, snapshotId, campaignId, projectId) {
  const repository = kernel().getResearchSourceRepository(safeId(repositoryId, "repository_id"));
  if (!repository || (campaignId && repository.campaign_id !== String(campaignId)) || (projectId && !sameProject(repository.project_id, projectId))) fail("not_found", "source repository not found");
  if (!snapshotId) return { repository };
  const snapshot = kernel().getResearchSourceSnapshot(safeId(snapshotId, "snapshot_id"));
  if (!snapshot || snapshot.repository_id !== repository.repository_id || snapshot.campaign_id !== repository.campaign_id || snapshot.project_id !== repository.project_id) fail("not_found", "source snapshot not found");
  return { repository, snapshot };
}

function unsupported(action, reason) {
  return { ok: false, code: "unsupported", action, reason, supported_git_actions: ["status", "diff", "log", "show", "ls-tree", "ls-files", "add", "commit", "push", "pull", "branch", "checkout", "stash"] };
}

function registeredDirectory(root, snapshot) {
  const { directory } = snapshotManifest(root, snapshot);
  let stat;
  try { stat = fs.lstatSync(directory); } catch { fail("state_conflict", "snapshot directory is missing"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("state_conflict", "snapshot directory is not a real directory");
  return directory;
}

function refreshSnapshot(services, args, actor) {
  const root = workspace.resolveWorkspace(services.config || {}, { requireExists: false }).root;
  const owned = getOwned(args.repository_id, args.snapshot_id, args.campaign_id, args.project_id);
  if (!owned.snapshot) fail("invalid_input", "refresh requires snapshot_id");
  if (owned.repository.state !== "active" || owned.snapshot.state !== "finalized") fail("state_conflict", "cannot refresh an inactive or non-finalized snapshot");
  const directory = registeredDirectory(root, owned.snapshot);
  const actual = inspectTree(directory, services.config || {}, directory);
  const snapshotArgs = { ...args, source_path: directory };
  return importDirectory(services, snapshotArgs, actor, directory, { import_kind: "refresh", refreshed_from_snapshot_id: owned.snapshot.snapshot_id, source_manifest_hash: actual.content_hash });
}

function parseDispatchJson(result, action) {
  if (!result || result.isError) fail("unsupported", `${action} dispatch failed`);
  const text = Array.isArray(result.content) ? result.content.map(item => item && item.text || "").join("") : "";
  try { return JSON.parse(text); } catch { fail("state_conflict", `${action} returned invalid JSON`); }
}

async function acquireSource(services, args, actor) {
  const root = workspace.resolveWorkspace(services.config || {}, { requireExists: false }).root;
  const campaignId = requireText(args.campaign_id, "campaign_id");
  const sourceUrl = requireText(args.source_url, "source_url");
  if (!services.dispatch || typeof services.dispatch !== "function") {
    return unsupported("acquire", "the canonical git clone action is unavailable; acquisition was not attempted");
  }
  let repository = args.repository_id ? kernel().getResearchSourceRepository(safeId(args.repository_id, "repository_id")) : null;
  if (repository && (repository.campaign_id !== campaignId || args.project_id && !sameProject(repository.project_id, args.project_id))) fail("not_found", "source repository not found");
  if (!repository) repository = kernelCall(() => kernel().createResearchSourceRepository({ campaign_id: campaignId, project_id: args.project_id, name: requireText(args.name || new URL(sourceUrl).hostname, "name"), created_by: actor, metadata: { authority: "derived_analysis_input" }, source: "security-research" }));
  if (repository.state !== "active") fail("state_conflict", "cannot acquire into an inactive source repository");

  const snapshotId = `source_snap_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  const base = repositoryContext(root, repository);
  const staging = path.join(base, `.${snapshotId}.staging`);
  workspace.assertInside(root, staging);
  if (fs.existsSync(staging)) fail("state_conflict", "source acquisition staging path already exists");
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const cloneArgs = { action: "clone", source_url: sourceUrl, destination: staging };
    if (args.ref != null) cloneArgs.ref = args.ref;
    const configuredHosts = services.config && services.config.source_allowed_hosts;
    if (args.allowed_hosts != null) cloneArgs.allowed_hosts = args.allowed_hosts;
    else if (Array.isArray(configuredHosts)) cloneArgs.allowed_hosts = configuredHosts;
    const cloned = parseDispatchJson(await services.dispatch("git", cloneArgs), "git clone");
    if (cloned.ok !== true || cloned.action !== "clone" || cloned.destination !== staging) fail("state_conflict", "git clone returned invalid acquisition metadata");
    const gitMetadata = path.join(staging, ".git");
    if (fs.existsSync(gitMetadata)) {
      const stat = fs.lstatSync(gitMetadata);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("invalid_input", "cloned source has an unsafe git metadata entry");
      fs.rmSync(gitMetadata, { recursive: true, force: true });
    }
    const result = importDirectory(services, { ...args, action: "import", campaign_id: campaignId, repository_id: repository.repository_id, source_path: staging, name: args.name || repository.name }, actor, staging, {
      import_kind: "git_clone",
      requested_ref: cloned.requested_ref,
      resolved_ref: cloned.resolved_ref,
      remote_identity: cloned.remote_identity,
    });
    return result;
  } catch (error) {
    throw error;
  } finally {
    try {
      const stat = fs.lstatSync(staging);
      if (!stat.isSymbolicLink()) fs.rmSync(staging, { recursive: true, force: true });
    } catch {}
  }
}

function semanticRepositoryIdentity(directory) {
  return crypto.createHash("sha256").update("sidekick.semantic.repository.v1\0").update(path.resolve(directory)).digest("hex");
}

async function indexSnapshot(services, args, actor) {
  const root = workspace.resolveWorkspace(services.config || {}, { requireExists: false }).root;
  const owned = getOwned(args.repository_id, args.snapshot_id, args.campaign_id, args.project_id);
  if (!owned.snapshot || owned.snapshot.state !== "finalized") fail("state_conflict", "index requires a finalized snapshot");
  const verification = verifySnapshot(root, owned.snapshot, services.config || {});
  if (!verification.verified) fail("state_conflict", "cannot index a stale snapshot");
  const directory = registeredDirectory(root, owned.snapshot);
  const result = parseDispatchJson(await services.dispatch("semantic_repo", { action: args.index_action || "profile", path: directory, query: args.query, level: args.level, limit: args.limit, max_chars: args.max_chars }), "semantic_repo");
  const sourceAuthorityLabel = owned.snapshot.metadata?.source_authority || "unverified";
  const sourceCommit = owned.snapshot.metadata?.source_revision || owned.snapshot.resolved_commit_sha || null;
  const provenance = result.provenance || {};
  if (result.ok !== true || provenance.repository_identity !== semanticRepositoryIdentity(directory) || !result.index_root_hash || result.index_root_hash !== provenance.index_root_hash) fail("state_conflict", "semantic result provenance does not match the registered snapshot");
  const partial = result.degradation?.truncated === true || result.page?.has_more === true || provenance.completeness === "partial";
  kernel().updateResearchSourceSnapshotProvenance(owned.snapshot.snapshot_id, { semantic_index: { index_root_hash: result.index_root_hash, schema: result.schema || null, analyzer_version: result.analyzer_version || null, indexed_at: new Date().toISOString(), snapshot_content_hash: owned.snapshot.content_hash, completeness: partial ? "partial" : "complete" }, metadata: { index_status: partial ? "partial" : "indexed" }, source: "security-research" });
  const indexedProvenance = { ...provenance, source_authority: sourceAuthorityLabel, source_revision: sourceCommit };
  result.provenance = indexedProvenance;
  return { repository: owned.repository, snapshot: owned.snapshot, verification, index: result, provenance: { ...indexedProvenance, snapshot_id: owned.snapshot.snapshot_id, snapshot_content_hash: owned.snapshot.content_hash, storage_ref: owned.snapshot.storage_ref, actor } };
}

function compareSnapshots(services, args) {
  const root = workspace.resolveWorkspace(services.config || {}, { requireExists: false }).root;
  const left = getOwned(args.repository_id, args.baseline_snapshot_id, args.campaign_id, args.project_id);
  const right = getOwned(args.repository_id, args.candidate_snapshot_id, args.campaign_id, args.project_id);
  if (!left.snapshot || !right.snapshot || left.snapshot.snapshot_id === right.snapshot.snapshot_id) fail("invalid_input", "compare requires two distinct snapshot ids");
  const baseline = verifySnapshot(root, left.snapshot, services.config || {});
  const candidate = verifySnapshot(root, right.snapshot, services.config || {});
  if (!baseline.verified || !candidate.verified) fail("state_conflict", "cannot compare a stale snapshot");
  const baselineManifest = snapshotManifest(root, left.snapshot).manifest;
  const candidateManifest = snapshotManifest(root, right.snapshot).manifest;
  const files = new Set([...baselineManifest.entries, ...candidateManifest.entries].map(entry => entry.path));
  const changes = [...files].sort().map(file => {
    const before = baselineManifest.entries.find(entry => entry.path === file) || null;
    const after = candidateManifest.entries.find(entry => entry.path === file) || null;
    return { path: file, status: !before ? "added" : !after ? "removed" : before.hash === after.hash && before.bytes === after.bytes ? "unchanged" : "changed", baseline_hash: before && before.hash, candidate_hash: after && after.hash };
  }).filter(change => change.status !== "unchanged");
  return { baseline: { snapshot_id: left.snapshot.snapshot_id, content_hash: left.snapshot.content_hash }, candidate: { snapshot_id: right.snapshot.snapshot_id, content_hash: right.snapshot.content_hash }, changed: changes.length > 0, changes };
}

function authority(services, args, actor) {
  if (!actor || !String(actor).trim()) fail("authorization_failed", "an authenticated runtime actor is required to declare source authority");
  if (args.authority_action === "declare") {
    const owned = getOwned(args.repository_id, args.snapshot_id, args.campaign_id, args.project_id);
    if (!owned.snapshot) fail("invalid_input", "authority declaration requires snapshot_id");
    return { claim: kernelCall(() => kernel().createResearchSourceAuthorityClaim({ snapshot_id: owned.snapshot.snapshot_id, repository_id: owned.repository.repository_id, campaign_id: owned.snapshot.campaign_id, project_id: owned.snapshot.project_id, authority_class: args.authority_class, scope: args.scope, evidence_refs: args.evidence_refs, declaring_actor: actor, metadata: args.metadata, source: "security-research" })) };
  }
  if (args.authority_action === "get") {
    const claim = kernel().getResearchSourceAuthorityClaim(safeId(args.claim_id, "claim_id"));
    if (!claim || (args.project_id && !sameProject(claim.project_id, args.project_id)) || (args.campaign_id && claim.campaign_id !== String(args.campaign_id)) || (args.snapshot_id && claim.snapshot_id !== String(args.snapshot_id)) || (args.repository_id && claim.repository_id !== String(args.repository_id))) fail("not_found", "source authority claim not found");
    return { claim };
  }
  if (args.authority_action === "revoke") {
    const claim = kernel().getResearchSourceAuthorityClaim(safeId(args.claim_id, "claim_id"));
    if (!claim || args.project_id && !sameProject(claim.project_id, args.project_id) || args.campaign_id && claim.campaign_id !== String(args.campaign_id)) fail("not_found", "source authority claim not found");
    return { claim: kernelCall(() => kernel().transitionResearchSourceAuthorityClaim(claim.claim_id, "revoked", { actor_id: actor, source: "security-research" })) };
  }
  if (args.authority_action === "list") return { claims: kernel().listResearchSourceAuthorityClaims({ snapshot_id: args.snapshot_id, repository_id: args.repository_id, campaign_id: args.campaign_id, project_id: args.project_id, authority_class: args.authority_class, state: args.authority_state, limit: args.limit }) };
  fail("invalid_input", "authority_action must be declare, get, or list");
}

function execute(services, args, actor) {
  const root = workspace.resolveWorkspace(services.config || {}, { requireExists: false }).root;
  if (args.action === "recover" && !args.campaign_id) fail("invalid_input", "recover requires an explicit campaign_id scope");
  if (args._runtime_project && args.project_id && !sameProject(args._runtime_project, args.project_id)) fail("not_found", "source repository not found");
  if (args._runtime_project) args = { ...args, project_id: String(args._runtime_project) };
  switch (args.action) {
    case "list": return { repositories: kernel().listResearchSourceRepositories({ campaign_id: args.campaign_id, project_id: args.project_id, state: args.state, limit: args.limit }), snapshots: args.repository_id ? kernel().listResearchSourceSnapshots({ repository_id: safeId(args.repository_id, "repository_id"), state: args.snapshot_state, limit: args.limit }) : undefined };
    case "get": { const owned = getOwned(args.repository_id, args.snapshot_id, args.campaign_id); return owned.snapshot ? { repository: owned.repository, snapshot: owned.snapshot } : { repository: owned.repository, snapshots: kernel().listResearchSourceSnapshots({ repository_id: owned.repository.repository_id, limit: args.limit }) }; }
    case "import": return importDirectory(services, args, actor);
    case "acquire": return acquireSource(services, args, actor);
    case "refresh": return refreshSnapshot(services, args, actor);
    case "index": return indexSnapshot(services, args, actor);
    case "compare": return compareSnapshots(services, args);
    case "authority": return authority(services, args, actor);
    case "verify": { const owned = getOwned(args.repository_id, args.snapshot_id, args.campaign_id, args.project_id); return { verification: verifySnapshot(root, owned.snapshot, services.config || {}) }; }
    case "select": { const owned = getOwned(args.repository_id, args.snapshot_id, args.campaign_id, args.project_id); const verification = verifySnapshot(root, owned.snapshot, services.config || {}); if (!verification.verified) fail("state_conflict", "cannot select a stale snapshot"); return { repository: kernelCall(() => kernel().selectResearchSourceSnapshot(owned.repository.repository_id, owned.snapshot.snapshot_id, { actor_id: actor, source: "security-research" })) }; }
    case "archive": { const owned = getOwned(args.repository_id, args.snapshot_id, args.campaign_id, args.project_id); return { item: args.snapshot_id ? kernelCall(() => kernel().transitionResearchSourceSnapshot(owned.snapshot.snapshot_id, "archived", { actor_id: actor, source: "security-research" })) : kernelCall(() => kernel().transitionResearchSourceRepository(owned.repository.repository_id, "archived", { actor_id: actor, source: "security-research" })) }; }
    case "remove": { const owned = getOwned(args.repository_id, args.snapshot_id, args.campaign_id, args.project_id); if (!owned.snapshot) fail("invalid_input", "remove requires snapshot_id"); const directory = registeredDirectory(root, owned.snapshot); const removed = kernelCall(() => kernel().removeResearchSourceSnapshot(owned.snapshot.snapshot_id, { actor_id: actor, source: "security-research" })); fs.rmSync(directory, { recursive: true, force: true }); if (fs.existsSync(directory)) fail("state_conflict", "snapshot removal could not be verified"); return { snapshot: removed, storage_removed: true }; }
     case "recover": { const removed = []; const rootProjects = path.join(root, "projects"); if (fs.existsSync(rootProjects)) for (const campaign of fs.readdirSync(rootProjects).filter(name => name === String(args.campaign_id))) { const repositories = path.join(rootProjects, campaign, "repositories"); if (!fs.existsSync(repositories) || fs.lstatSync(repositories).isSymbolicLink()) continue; for (const repository of fs.readdirSync(repositories)) { const repositoryDir = path.join(repositories, repository); if (fs.lstatSync(repositoryDir).isSymbolicLink()) continue; for (const item of fs.readdirSync(repositoryDir)) if (/^\.source_snap_[A-Za-z0-9_-]+\.staging$/.test(item)) { const target = path.join(repositoryDir, item); if (!fs.lstatSync(target).isSymbolicLink()) { fs.rmSync(target, { recursive: true, force: true }); if (!fs.existsSync(target)) removed.push(path.posix.join("projects", campaign, "repositories", repository, item)); } } } } return { recovered: removed, count: removed.length }; }
    default: fail("invalid_input", `unknown action: ${args.action}`);
  }
}

module.exports = { execute, inspectTree, verifySnapshot };
