"use strict";

/**
 * Git facts, obtained through Sidekick's governed `git` tool.
 *
 * The pack does NOT shell out to git itself. Every git read goes through the
 * dispatcher via the module services facade, which means it inherits the git
 * tool's path policy, argument handling, redaction, timeout and audit logging.
 * The pack's job is to ask the right questions and parse the answers.
 */

// ASCII unit separator: cannot appear in a commit subject or author name, so
// pretty-format output parses unambiguously without quoting rules.
const SEPARATOR = "\u001f";

function textOf(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map(part => (part && typeof part.text === "string" ? part.text : "")).join("\n");
}

function ok(result) {
  return Boolean(result) && !result.isError;
}

async function gitRead(services, repoPath, action, args) {
  const result = await services.dispatch("git", { action, path: repoPath, args });
  return { ok: ok(result), text: textOf(result).trim(), raw: result };
}

/** Parse `git status --porcelain=v1 -b` into a structured working-tree view. */
function parseStatus(text) {
  const lines = text.split("\n").filter(Boolean);
  const files = [];
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      const [refs, ...rest] = header.split(" ");
      const [local, remote] = refs.split("...");
      branch = local;
      upstream = remote || null;
      const tracking = rest.join(" ");
      const aheadMatch = tracking.match(/ahead (\d+)/);
      const behindMatch = tracking.match(/behind (\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
      continue;
    }
    const index = line[0];
    const worktree = line[1];
    const file = line.slice(3);
    files.push({
      path: file,
      index_status: index === " " ? null : index,
      worktree_status: worktree === " " ? null : worktree,
      staged: index !== " " && index !== "?",
      untracked: index === "?" && worktree === "?",
    });
  }
  return {
    branch,
    upstream,
    ahead,
    behind,
    clean: files.length === 0,
    changed_file_count: files.length,
    staged_count: files.filter(file => file.staged).length,
    untracked_count: files.filter(file => file.untracked).length,
    files: files.slice(0, 200),
    files_truncated: files.length > 200,
  };
}

function parseLog(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [sha, subject, author, date] = line.split(SEPARATOR);
      return { sha: sha || null, subject: subject || null, author: author || null, date: date || null };
    })
    .filter(commit => commit.sha);
}

/**
 * Collect the repository's git facts. Every field is either observed or null;
 * a failed git read degrades that field rather than the whole profile.
 */
async function collectRepositoryFacts(services, repoPath) {
  const facts = { available: false, errors: [] };

  const status = await gitRead(services, repoPath, "status", "--porcelain=v1 -b");
  if (!status.ok) {
    facts.errors.push(`git status failed: ${status.text.slice(0, 300)}`);
    return facts;
  }
  facts.available = true;
  Object.assign(facts, parseStatus(status.text));

  const format = ["%H", "%s", "%an", "%aI"].join(SEPARATOR);
  const head = await gitRead(services, repoPath, "log", `-1 --pretty=format:${format}`);
  if (head.ok) {
    const [commit] = parseLog(head.text);
    facts.head = commit || null;
  } else {
    facts.head = null;
    facts.errors.push("git log for HEAD failed");
  }

  const log = await gitRead(services, repoPath, "log", `-15 --pretty=format:${format}`);
  facts.recent_commits = log.ok ? parseLog(log.text) : [];

  const remoteBranches = await gitRead(services, repoPath, "branch", "-r --format=%(refname:short)");
  facts.remote_branches = remoteBranches.ok ? remoteBranches.text.split("\n").filter(Boolean).slice(0, 40) : [];

  const branches = await gitRead(services, repoPath, "branch", "--format=%(refname:short)");
  facts.branches = branches.ok ? branches.text.split("\n").filter(Boolean).slice(0, 60) : [];

  // `remote -v` is not in the git tool's allowed action list. Rather than reach
  // around the governed surface, remote NAMES are derived from remote-tracking
  // refs; URLs are deliberately not reported.
  facts.remotes = [...new Set(facts.remote_branches.map(ref => ref.split("/")[0]))].map(name => ({ name }));

  return facts;
}

/**
 * Pin WHAT code an analysis or verification ran against. A verdict that does
 * not carry {head_sha, branch, worktree_clean, changed_file_count} cannot be
 * tied back to a commit later — "tests passed" is meaningless once the tree
 * moves. Reads go through the same governed git dispatch as every other fact,
 * and a non-repository degrades to nulls rather than failing the tool.
 */
async function collectStateFacts(services, repoPath) {
  const status = await gitRead(services, repoPath, "status", "--porcelain=v1 -b");
  if (!status.ok) {
    return { available: false, head_sha: null, branch: null, worktree_clean: null, changed_file_count: null };
  }
  const parsed = parseStatus(status.text);
  const head = await gitRead(services, repoPath, "log", "-1 --pretty=format:%H");
  return {
    available: true,
    // A malformed value is reported as null, never passed through: the sha is
    // the anchor other evidence hangs off, so it is either a real sha or absent.
    head_sha: head.ok && /^[0-9a-f]{40}$/.test(head.text) ? head.text : null,
    branch: parsed.branch,
    worktree_clean: parsed.clean,
    changed_file_count: parsed.changed_file_count,
  };
}

/**
 * Resolve a ref (e.g. "origin/main") to its commit sha through the governed
 * git tool. `rev-parse` is not in the git tool's action allowlist, so `log -1`
 * on the ref — equivalent for any committish — keeps the read inside the
 * governed surface. An unresolvable ref returns null; the caller reports the
 * literal ref alongside, so nothing is silently invented.
 */
async function resolveRefSha(services, repoPath, ref) {
  if (!ref || typeof ref !== "string") return null;
  const out = await gitRead(services, repoPath, "log", `-1 --pretty=format:%H ${ref}`);
  const sha = out.text.trim();
  return out.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Structured diff statistics for a change set. */
async function collectDiff(services, repoPath, { base, staged = false } = {}) {
  const scope = [];
  if (staged) scope.push("--cached");
  if (base) scope.push(base);
  const numstat = await gitRead(services, repoPath, "diff", [...scope, "--numstat"].join(" ").trim());
  const nameStatus = await gitRead(services, repoPath, "diff", [...scope, "--name-status"].join(" ").trim());
  if (!numstat.ok) {
    return { ok: false, error: numstat.text.slice(0, 500), files: [], file_count: 0, insertions: 0, deletions: 0, binary_files: 0 };
  }

  const statuses = new Map();
  if (nameStatus.ok) {
    for (const line of nameStatus.text.split("\n").filter(Boolean)) {
      const parts = line.split(/\t/);
      if (parts.length >= 2) statuses.set(parts[parts.length - 1], parts[0]);
    }
  }

  const files = [];
  let insertions = 0;
  let deletions = 0;
  let binaryCount = 0;
  for (const line of numstat.text.split("\n").filter(Boolean)) {
    const [added, removed, file] = line.split(/\t/);
    if (!file) continue;
    const binary = added === "-" || removed === "-";
    if (binary) binaryCount++;
    const addedCount = binary ? 0 : Number(added) || 0;
    const removedCount = binary ? 0 : Number(removed) || 0;
    insertions += addedCount;
    deletions += removedCount;
    files.push({ path: file, insertions: addedCount, deletions: removedCount, binary, status: statuses.get(file) || "M" });
  }
  return { ok: true, files, insertions, deletions, binary_files: binaryCount, file_count: files.length };
}

module.exports = { collectRepositoryFacts, collectStateFacts, resolveRefSha, collectDiff, parseStatus, parseLog, textOf, SEPARATOR };
