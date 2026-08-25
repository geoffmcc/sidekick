"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_DISCOVERY_DEPTH = 12;
const MAX_DISCOVERY_RESULTS = 256;
const PROTECTED_RELATIVE = [
  ".ssh",
  ".config",
  ".local/share/opencode",
  ".sidekick",
  ".env",
];

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
}

function canonicalExisting(target) {
  const raw = String(target || "");
  if (!raw || raw.includes("\0")) throw new Error("path is invalid");
  if (!path.isAbsolute(raw)) throw new Error("path must be absolute");
  if (raw.split(/[\\/]/).includes("..")) throw new Error("parent traversal is not permitted");
  let resolved;
  try { resolved = fs.realpathSync(raw); } catch (error) { throw Object.assign(new Error("path does not exist"), { code: error.code }); }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
    throw new Error("special files and symlinks are not permitted");
  }
  return { path: resolved, stat };
}

function contains(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function protectedPath(root, target) {
  const relative = path.relative(root, target).split(path.sep).join("/");
  return PROTECTED_RELATIVE.some(entry => relative === entry || relative.startsWith(`${entry}/`));
}

function createWorkspace({ name, root, permissions = {}, limits = {} }) {
  const canonical = canonicalExisting(root);
  if (!canonical.stat.isDirectory()) throw new Error("workspace root must be a directory");
  return {
    workspaceId: stableId("ws", `${name}:${canonical.path}`),
    name: String(name || "").trim(),
    root: canonical.path,
    rootIdentity: stableId("root", canonical.path),
    permissions: {
      read: permissions.read !== false,
      write: permissions.write === true,
      execute: permissions.execute === true,
      networkScopes: Array.isArray(permissions.networkScopes) ? permissions.networkScopes.slice(0, 32) : [],
    },
    limits: {
      maxRepositories: Math.min(1024, Math.max(1, Number(limits.maxRepositories) || 256)),
      maxDepth: Math.min(MAX_DISCOVERY_DEPTH, Math.max(1, Number(limits.maxDepth) || MAX_DISCOVERY_DEPTH)),
      maxOutputBytes: Math.min(10 * 1024 * 1024, Math.max(1024, Number(limits.maxOutputBytes) || 1024 * 1024)),
      maxRuntimeMs: Math.min(30 * 60 * 1000, Math.max(1000, Number(limits.maxRuntimeMs) || 120000)),
      maxConcurrent: Math.min(16, Math.max(1, Number(limits.maxConcurrent) || 2)),
    },
  };
}

function resolveWorkspacePath(workspace, requested, { operation = "read", allowMissing = false } = {}) {
  if (!workspace || !workspace.root) throw new Error("workspace is required");
  const raw = String(requested || "");
  if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) throw new Error("workspace paths must be absolute");
  if (raw.split(/[\\/]/).includes("..")) throw new Error("parent traversal is not permitted");
  const root = canonicalExisting(workspace.root).path;
  let target;
  try {
    target = canonicalExisting(raw).path;
  } catch (error) {
    if (!allowMissing || !["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    target = path.resolve(raw);
    let parent = path.dirname(target);
    while (!fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) throw new Error("path has no existing parent");
      parent = next;
    }
    parent = canonicalExisting(parent).path;
    if (!contains(root, parent)) throw new Error("path is outside the authorized workspace");
  }
  if (!contains(root, target) || protectedPath(root, target)) throw new Error("path is outside the authorized workspace");
  if (operation === "write" && workspace.permissions.write !== true) throw new Error("workspace is read-only");
  if (operation === "execute" && workspace.permissions.execute !== true) throw new Error("workspace does not permit execution");
  return target;
}

function discoverRepositories(workspace) {
  const root = canonicalExisting(workspace.root).path;
  const results = [];
  const ignored = new Set(["node_modules", ".git", ".venv", "vendor", "target", "dist", "build"]);
  function visit(directory, depth) {
    if (results.length >= workspace.limits.maxRepositories || depth > workspace.limits.maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (results.length >= workspace.limits.maxRepositories) break;
      const candidate = path.join(directory, entry.name);
      if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith(".")) continue;
      let canonical;
      try { canonical = canonicalExisting(candidate); } catch { continue; }
      if (!contains(root, canonical.path) || protectedPath(root, canonical.path)) continue;
      const gitMarker = path.join(canonical.path, ".git");
      let isRepository = false;
      try { isRepository = fs.lstatSync(gitMarker).isDirectory() || fs.lstatSync(gitMarker).isFile(); } catch {}
      if (isRepository) {
        results.push({ repositoryId: stableId("repo", canonical.path), root: canonical.path, rootIdentity: stableId("root", canonical.path) });
        continue;
      }
      visit(canonical.path, depth + 1);
    }
  }
  visit(root, 0);
  return results;
}

function revalidateRepository(workspace, repository) {
  const current = resolveWorkspacePath(workspace, repository.root, { operation: "read" });
  if (current !== repository.root || stableId("root", current) !== repository.rootIdentity) throw new Error("repository was moved or replaced");
  return { ...repository, root: current };
}

module.exports = { MAX_DISCOVERY_DEPTH, createWorkspace, resolveWorkspacePath, discoverRepositories, revalidateRepository, stableId, contains };
