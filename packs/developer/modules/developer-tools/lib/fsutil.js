"use strict";

/**
 * Bounded, policy-respecting filesystem helpers for the Developer pack.
 *
 * Every path the pack reads goes through the shared Sidekick path boundary
 * (services.paths), which is the same boundary the builtin filesystem family
 * uses. The pack never reimplements policy and never reads a path the policy
 * would refuse.
 *
 * Walks are bounded in breadth, depth and count: a repository profile must be
 * cheap and predictable, not a full crawl of a large monorepo.
 */

const fs = require("fs");
const path = require("path");

const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
  "target", "coverage", ".next", ".nuxt", ".cache", "vendor", ".idea", ".vscode",
  ".terraform", ".gradle", ".mypy_cache", ".pytest_cache", ".tox", "bin", "obj",
]);

const DEFAULT_LIMITS = Object.freeze({ maxFiles: 4000, maxDepth: 6 });

function safeStat(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function exists(target) {
  return Boolean(safeStat(target));
}

function isDirectory(target) {
  const stat = safeStat(target);
  return Boolean(stat && stat.isDirectory());
}

function readTextFile(target, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      return fs.readFileSync(target, { encoding: "utf-8" }).slice(0, maxBytes);
    }
    return fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}

function readJsonFile(target) {
  const text = readTextFile(target);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Walk a repository, returning relative file paths. Symlinked directories are
 * not followed — a profile must describe the repository, not wherever a link
 * happens to point.
 */
function walk(root, { maxFiles, maxDepth } = DEFAULT_LIMITS) {
  const limits = { maxFiles: maxFiles || DEFAULT_LIMITS.maxFiles, maxDepth: maxDepth || DEFAULT_LIMITS.maxDepth };
  const files = [];
  let truncated = false;

  const visit = (directory, depth) => {
    if (truncated || depth > limits.maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") && SKIP_DIRECTORIES.has(entry.name)) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
        if (files.length >= limits.maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  };

  visit(root, 0);
  return { files, truncated };
}

/** Which of `candidates` exist directly under `root`. */
function presentFiles(root, candidates) {
  return candidates.filter(candidate => exists(path.join(root, candidate)));
}

/** List files matching a predicate under one relative directory, bounded. */
function listUnder(root, relativeDirectory, { limit = 50, filter } = {}) {
  const directory = path.join(root, relativeDirectory);
  if (!isDirectory(directory)) return [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && (!filter || filter(entry.name)))
    .map(entry => `${relativeDirectory}/${entry.name}`)
    .sort()
    .slice(0, limit);
}

module.exports = { SKIP_DIRECTORIES, DEFAULT_LIMITS, exists, isDirectory, readTextFile, readJsonFile, walk, presentFiles, listUnder, safeStat };
