"use strict";

/**
 * The research workspace boundary — the single most important safety control in
 * this pack.
 *
 * All target-specific research (evidence, reports, run artifacts) lives in an
 * EXTERNAL, private, configurable workspace. The public Sidekick repository
 * must never become the storage location for real research. This module:
 *
 *   1. resolves the configured workspace (pack config, else the
 *      SIDEKICK_RESEARCH_WORKSPACE environment variable),
 *   2. canonicalizes it through realpath so `..` and symlinks cannot disguise
 *      where it actually points,
 *   3. refuses to operate when it resolves to the Sidekick source repository,
 *      the Sidekick data directory, or the managed pack store — in either
 *      containment direction, so a workspace that is an ANCESTOR of the repo is
 *      rejected too,
 *   4. confines every read/write to inside the resolved workspace and writes
 *      important state atomically.
 *
 * String comparison alone is deliberately not trusted: canonical paths are
 * compared, and unresolved/dangling components fail closed.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ResearchError } = require("./errors");

// Resolve the deepest existing ancestor through realpath (which follows every
// symlink in the existing prefix) and re-attach the not-yet-created tail. A
// component that cannot be resolved for any reason other than "absent" fails
// closed rather than being guessed past.
function canonicalize(inputPath) {
  let current = path.resolve(String(inputPath || ""));
  if (!current) throw new ResearchError("workspace_unsafe", "workspace path is empty");
  const tail = [];
  for (let guard = 0; guard < 4096; guard += 1) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (error) {
      if (error && error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw new ResearchError("workspace_unsafe", `workspace path could not be resolved (${error.code || "unknown"})`);
      }
      const parent = path.dirname(current);
      if (parent === current) throw new ResearchError("workspace_unsafe", "workspace path could not be resolved");
      tail.push(path.basename(current));
      current = parent;
    }
  }
  throw new ResearchError("workspace_unsafe", "workspace path is too deep to resolve");
}

// Does `outer` contain `inner` (or are they the same path), lexically, on
// already-canonicalized inputs?
function contains(outer, inner) {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Walk up from a directory looking for the Sidekick package root (package.json
// with name "sidekick"). At runtime the module lives under <install>/data/packs,
// so this climbs to the real install/repo root; during tests it finds the repo.
function findSidekickRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 64; i += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg && pkg.name === "sidekick") return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// The set of roots the workspace must not equal, contain, or be contained by.
// Canonicalized; unresolvable candidates are simply dropped (they cannot match).
function protectedRoots() {
  const raw = new Set();
  const repoFromModule = findSidekickRoot(__dirname);
  const repoFromCwd = findSidekickRoot(process.cwd());
  if (repoFromModule) raw.add(repoFromModule);
  if (repoFromCwd) raw.add(repoFromCwd);
  if (process.env.SIDEKICK_ROOT) raw.add(process.env.SIDEKICK_ROOT);

  const dataDir = process.env.SIDEKICK_DATA_DIR
    || (repoFromModule ? path.join(repoFromModule, "data") : null)
    || (repoFromCwd ? path.join(repoFromCwd, "data") : null);
  if (dataDir) {
    raw.add(dataDir);
    raw.add(path.join(dataDir, "packs"));
  }

  const roots = [];
  for (const candidate of raw) {
    try {
      roots.push(canonicalize(candidate));
    } catch {
      // An unresolved protected-root candidate cannot contain the workspace,
      // and echoing it would leak configuration. Drop it silently.
    }
  }
  return roots;
}

// Reject a workspace that is dangerously shallow (filesystem root, a top-level
// directory, or the OS temp root itself), which would make a stray write far
// too broad even if it were technically outside the repo.
function isTooShallow(canonicalWorkspace) {
  const segments = canonicalWorkspace.split(path.sep).filter(Boolean);
  if (segments.length < 2) return true;
  try {
    if (canonicalWorkspace === canonicalize(os.tmpdir())) return true;
  } catch {}
  return false;
}

/**
 * Resolve and validate the research workspace. Returns { root, source } where
 * root is the canonical, safe workspace path. Never creates anything.
 *
 * @param {object} config - the module configuration (services.config)
 * @param {object} [opts] - { requireExists }
 */
function resolveWorkspace(config, opts = {}) {
  const configured = (config && typeof config.workspace === "string" && config.workspace.trim())
    ? config.workspace.trim()
    : null;
  const fromEnv = (process.env.SIDEKICK_RESEARCH_WORKSPACE || "").trim() || null;
  const source = configured ? "config" : (fromEnv ? "environment" : null);
  const raw = configured || fromEnv;
  if (!raw) {
    throw new ResearchError("workspace_missing", "No research workspace configured. Set the pack's 'workspace' config or the SIDEKICK_RESEARCH_WORKSPACE environment variable to an absolute path OUTSIDE the Sidekick repository.");
  }
  if (!path.isAbsolute(raw)) {
    throw new ResearchError("workspace_unsafe", `research workspace must be an absolute path, got: ${raw}`);
  }

  const canonical = canonicalize(raw);

  if (isTooShallow(canonical)) {
    throw new ResearchError("workspace_unsafe", `research workspace is too shallow to be safe: ${canonical}`);
  }

  for (const root of protectedRoots()) {
    if (contains(root, canonical) || contains(canonical, root)) {
      throw new ResearchError("workspace_unsafe", `research workspace must not be inside, equal to, or a parent of a protected Sidekick location (${root}). Point it at an external private directory.`, { protected_root: root });
    }
  }

  if (opts.requireExists) {
    let stat = null;
    try {
      stat = fs.statSync(canonical);
    } catch {
      throw new ResearchError("environment_failed", `research workspace does not exist: ${canonical}`);
    }
    if (!stat.isDirectory()) {
      throw new ResearchError("workspace_unsafe", `research workspace is not a directory: ${canonical}`);
    }
  }

  return { root: canonical, source, configured: Boolean(configured), from_env: Boolean(fromEnv) };
}

// Sanitize an id used as a path segment. Ids are pack-generated, but callers can
// supply them too, so refuse anything that could traverse.
function safeSegment(value, name = "id") {
  const text = String(value == null ? "" : value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(text) || text === "." || text === "..") {
    throw new ResearchError("invalid_input", `${name} is not a safe path segment: ${text}`);
  }
  return text;
}

// --- layout -----------------------------------------------------------------

function projectDir(root, campaignId) {
  return path.join(root, "projects", safeSegment(campaignId, "campaign_id"));
}
function runDir(root, campaignId, runId) {
  return path.join(projectDir(root, campaignId), "runs", safeSegment(runId, "run_id"));
}
function evidenceDir(root, campaignId, runId) {
  return path.join(runDir(root, campaignId, runId), "evidence");
}
function reportDir(root, campaignId) {
  return path.join(projectDir(root, campaignId), "reports");
}

// A storage_ref for the artifact custody system must be a safe RELATIVE path.
function relToWorkspace(root, absPath) {
  const rel = path.relative(root, absPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ResearchError("evidence_write_failed", "computed storage reference escapes the workspace");
  }
  return rel.split(path.sep).join("/");
}

// Confirm a target lies inside the workspace, resolving symlinks in its
// existing prefix, before any read or write touches it.
function assertInside(root, absPath) {
  const canonicalRoot = canonicalize(root);
  const canonicalTarget = canonicalize(absPath);
  if (!contains(canonicalRoot, canonicalTarget)) {
    throw new ResearchError("evidence_write_failed", "target path escapes the research workspace");
  }
  return canonicalTarget;
}

// Atomic write: write to a temp sibling then rename, so a crash never leaves a
// half-written state file behind.
function atomicWrite(root, absPath, data) {
  assertInside(root, path.dirname(absPath));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, absPath);
  return { path: absPath, bytes: buffer.length };
}

function readInside(root, absPath) {
  assertInside(root, absPath);
  return fs.readFileSync(absPath);
}

module.exports = {
  canonicalize,
  contains,
  protectedRoots,
  resolveWorkspace,
  safeSegment,
  projectDir,
  runDir,
  evidenceDir,
  reportDir,
  relToWorkspace,
  assertInside,
  atomicWrite,
  readInside,
};
