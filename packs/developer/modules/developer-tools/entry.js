"use strict";

/**
 * developer-tools module — the runtime of the Developer / Software Engineering
 * capability pack.
 *
 * Contributes three tools that add STRUCTURE Sidekick did not have, rather
 * than aliases for primitives it already has:
 *
 *   dev_repo_profile    a mechanically-derived software-project profile
 *   dev_change_summary  evidence-backed engineering impact of a change set
 *   dev_verify          governed selection and execution of the project's own
 *                       verification commands
 *
 * Everything that touches git goes through the `git` tool, everything that
 * runs a command goes through the `bash` tool, and everything that touches a
 * path goes through the shared path policy — all via the module services
 * facade, so the pack inherits Sidekick's policy, approval, timeout,
 * redaction and audit path instead of reimplementing any of it.
 */

const fs = require("fs");
const path = require("path");
const { requireFromSidekick } = require("./lib/deps");
const fsutil = require("./lib/fsutil");
const detect = require("./lib/detect");
const gitFacts = require("./lib/git");
const changes = require("./lib/changes");
const verify = require("./lib/verify");

const { z } = requireFromSidekick("zod");

const DEFAULT_MAX_OUTPUT_CHARS = 12000;
const MAX_ALLOWED_OUTPUT_CHARS = 60000;

function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message, extra = {}) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }], isError: true };
}

/**
 * Resolve and authorize the target repository path.
 *
 * Two gates, both required: the shared Sidekick path policy (which decides
 * whether this execution source may touch the path at all), and the pack's own
 * optional `repository_roots` confinement (which lets an operator restrict the
 * pack to specific trees even where the global policy is open).
 */
function resolveRepositoryRoot(services, requestedPath) {
  const target = path.resolve(requestedPath || process.cwd());
  const policyError = services.paths.enforce(target, "read");
  if (policyError) return { ok: false, result: policyError };
  if (!fsutil.isDirectory(target)) {
    return { ok: false, result: errorResult(`Not a directory: ${target}`, { code: "invalid_path" }) };
  }
  const roots = Array.isArray(services.config.repository_roots) ? services.config.repository_roots : [];
  if (roots.length) {
    const permitted = roots.some(root => {
      const resolvedRoot = path.resolve(root);
      const relative = path.relative(resolvedRoot, target);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!permitted) {
      return {
        ok: false,
        result: errorResult(`Path is outside the Developer pack's configured repository_roots: ${target}`, { code: "repository_root_denied", repository_roots: roots }),
      };
    }
  }
  return { ok: true, root: target };
}

// --- dev_repo_profile ------------------------------------------------------

async function devRepoProfile(services, { path: requestedPath, max_files, include_git = true }) {
  const resolved = resolveRepositoryRoot(services, requestedPath);
  if (!resolved.ok) return resolved.result;
  const root = resolved.root;

  const walk = fsutil.walk(root, { maxFiles: max_files || 4000, maxDepth: 6 });
  const packageJson = fsutil.readJsonFile(path.join(root, "package.json"));
  const scripts = detect.classifyScripts(packageJson && packageJson.scripts ? packageJson.scripts : {});
  const ecosystems = detect.detectEcosystems(root);
  const packageManagers = detect.detectPackageManagers(root);
  const languages = detect.detectLanguages(walk.files);
  const workspaces = detect.detectWorkspaces(root);
  const ci = detect.detectCi(root);
  const migrations = detect.detectMigrations(root);
  const candidates = detect.verificationCandidates(root, { scripts, packageManagers, ecosystems });

  const instructionFiles = detect.presentFiles(root, detect.INSTRUCTION_FILES);
  const docs = detect.presentFiles(root, detect.DOC_FILES);
  const containers = detect.presentFiles(root, detect.CONTAINER_FILES);

  const git = include_git ? await gitFacts.collectRepositoryFacts(services, root) : { available: false, skipped: true };

  const topLevelDirectories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !fsutil.SKIP_DIRECTORIES.has(entry.name))
    .map(entry => entry.name)
    .sort();

  return jsonResult({
    ok: true,
    tool: "dev_repo_profile",
    generated_at: new Date().toISOString(),
    repository: {
      path: root,
      name: path.basename(root),
      is_git_repository: Boolean(git.available),
      branch: git.branch || null,
      upstream: git.upstream || null,
      ahead: git.ahead || 0,
      behind: git.behind || 0,
      head: git.head || null,
      working_tree: git.available
        ? {
            clean: git.clean,
            changed_files: git.changed_file_count,
            staged: git.staged_count,
            untracked: git.untracked_count,
            files: git.files,
          }
        : null,
      remotes: git.remotes || [],
      branches: git.branches || [],
      recent_commits: git.recent_commits || [],
      git_errors: git.errors || [],
    },
    structure: {
      top_level_directories: topLevelDirectories,
      file_count: walk.files.length,
      file_scan_truncated: walk.truncated,
      workspaces,
    },
    languages,
    ecosystems,
    package_managers: packageManagers,
    manifests: detect.presentFiles(root, ecosystems.map(entry => entry.manifest)),
    scripts: {
      build: scripts.build,
      test: scripts.test,
      lint: scripts.lint,
      typecheck: scripts.typecheck,
      other_count: scripts.other.length,
    },
    ci,
    containers,
    migrations,
    documentation: docs,
    instruction_files: instructionFiles,
    verification: {
      candidates,
      // The pack states what it believes the verification path is, and shows
      // the evidence. It never asserts a command it could not detect.
      likely_commands: Object.fromEntries(
        ["lint", "typecheck", "test", "build"].map(intent => {
          const match = candidates.find(candidate => candidate.intent === intent);
          return [intent, match ? match.command : null];
        })
      ),
    },
  });
}

// --- dev_change_summary ----------------------------------------------------

async function devChangeSummary(services, { path: requestedPath, base, staged = false, max_diff_chars }) {
  const resolved = resolveRepositoryRoot(services, requestedPath);
  if (!resolved.ok) return resolved.result;
  const root = resolved.root;

  const diffStats = await gitFacts.collectDiff(services, root, { base, staged });
  if (!diffStats.ok) {
    return errorResult(`Could not read the change set: ${diffStats.error}`, { code: "diff_unavailable", repository: root });
  }

  const diffScope = [];
  if (staged) diffScope.push("--cached");
  if (base) diffScope.push(base);
  const unified = await services.dispatch("git", { action: "diff", path: root, args: [...diffScope, "--unified=0"].join(" ").trim() });
  // A failed unified-diff read must not be fed to the analyzer as if it were
  // diff text — an error message contains no hunks, so the analysis would
  // "succeed" on garbage. Same failure contract as collectDiff above.
  if (!unified || unified.isError) {
    return errorResult(`Could not read the change set diff: ${verify.textOf(unified).trim().slice(0, 500)}`, { code: "diff_unavailable", repository: root });
  }
  const diffText = verify.textOf(unified).slice(0, max_diff_chars || 400000);

  // Pin exactly what was analyzed: the commit, branch and tree state, and the
  // base resolved to a sha — "diff against origin/main" is not reproducible
  // once origin/main moves, but "diff against <sha>" is.
  const gitState = await gitFacts.collectStateFacts(services, root);
  const baseSha = base ? await gitFacts.resolveRefSha(services, root, base) : null;

  const analysis = changes.analyzeChangeSet({
    files: diffStats.files,
    diffText,
    insertions: diffStats.insertions,
    deletions: diffStats.deletions,
    binaryFiles: diffStats.binary_files,
  });

  // `git diff` never shows untracked files, so a change set analyzed from the
  // diff alone silently omits every NEW file. Report them explicitly rather
  // than letting a reviewer believe the summary is complete.
  const status = await services.dispatch("git", { action: "status", path: root, args: "--porcelain=v1" });
  const untracked = verify
    .textOf(status)
    .split("\n")
    .filter(line => line.startsWith("?? "))
    .map(line => line.slice(3))
    .sort();

  return jsonResult({
    ok: true,
    tool: "dev_change_summary",
    generated_at: new Date().toISOString(),
    repository: root,
    scope: { base: base || null, base_sha: baseSha, staged: Boolean(staged), description: base ? `diff against ${base}` : staged ? "staged changes" : "unstaged working-tree changes" },
    git_state: {
      head_sha: gitState.head_sha,
      branch: gitState.branch,
      worktree_clean: gitState.worktree_clean,
      changed_file_count: gitState.changed_file_count,
    },
    ...analysis,
    untracked: {
      count: untracked.length,
      files: untracked.slice(0, 200),
      truncated: untracked.length > 200,
      note: untracked.length
        ? "These files are NOT part of the analyzed diff: git does not include untracked files. Stage them to include them in the impact analysis."
        : "No untracked files.",
    },
    evidence: {
      // The raw per-file numbers the analysis was computed from stay available,
      // so nothing above has to be taken on trust.
      files: diffStats.files,
      diff_bytes_analyzed: diffText.length,
      diff_truncated: diffText.length >= (max_diff_chars || 400000),
    },
  });
}

// --- dev_verify ------------------------------------------------------------

async function devVerify(services, { path: requestedPath, mode, intents: requestedIntents, continue_on_failure, max_output_chars, timeout_ms }) {
  const resolved = resolveRepositoryRoot(services, requestedPath);
  if (!resolved.ok) return resolved.result;
  const root = resolved.root;

  const config = services.config || {};
  const effectiveMode = mode || config.verification_mode || "standard";
  const intents = requestedIntents && requestedIntents.length
    ? requestedIntents
    : verify.MODE_INTENTS[effectiveMode] || verify.MODE_INTENTS.standard;

  const packageJson = fsutil.readJsonFile(path.join(root, "package.json"));
  const scripts = detect.classifyScripts(packageJson && packageJson.scripts ? packageJson.scripts : {});
  const ecosystems = detect.detectEcosystems(root);
  const packageManagers = detect.detectPackageManagers(root);
  const autodetect = config.autodetect_verification !== false;
  const candidates = autodetect ? detect.verificationCandidates(root, { scripts, packageManagers, ecosystems }) : [];

  const overrides = {
    test_command: config.test_command,
    lint_command: config.lint_command,
    typecheck_command: config.typecheck_command,
    build_command: config.build_command,
    syntax_command: config.syntax_command,
  };
  const selection = verify.selectCommands({ intents, candidates, overrides, ecosystems });

  const maxOutput = Math.min(max_output_chars || config.max_output_chars || DEFAULT_MAX_OUTPUT_CHARS, MAX_ALLOWED_OUTPUT_CHARS);
  const results = await verify.runSelection(services, {
    root,
    selection,
    maxOutputChars: maxOutput,
    timeoutMs: timeout_ms || config.command_timeout_ms || undefined,
    continueOnFailure: continue_on_failure !== undefined ? continue_on_failure : config.continue_on_failure === true,
  });
  const summary = verify.summarize(results, intents);

  // Pin exactly what was verified. A verification verdict that cannot name
  // the commit and tree state it ran against loses its meaning the moment the
  // worktree changes; collected AFTER the run so the sha reflects the tree
  // the commands actually saw (nothing here mutates the repository).
  const gitState = await gitFacts.collectStateFacts(services, root);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: summary.verdict === "passed" || summary.verdict === "passed_partial",
        tool: "dev_verify",
        generated_at: new Date().toISOString(),
        repository: root,
        git_state: {
          head_sha: gitState.head_sha,
          branch: gitState.branch,
          worktree_clean: gitState.worktree_clean,
          changed_file_count: gitState.changed_file_count,
        },
        mode: effectiveMode,
        requested_intents: intents,
        autodetect: autodetect,
        overrides_applied: Object.entries(overrides).filter(([, value]) => Boolean(value)).map(([key]) => key),
        verdict: summary.verdict,
        summary,
        // Every command that was chosen, why it was chosen, and exactly what
        // was executed — including the ones that were deliberately not run.
        commands: results,
      }, null, 2),
    }],
    isError: summary.verdict === "failed",
  };
}

// --- module contract -------------------------------------------------------

const entry = {
  buildDescriptors(services) {
    return [
      {
        name: "dev_repo_profile",
        aliases: ["repo_profile"],
        description:
          "Produce a structured, mechanically-derived profile of a software repository: git state, languages, ecosystems, package managers, workspace layout, build/test/lint/typecheck scripts, CI and container configuration, migrations, documentation, agent instruction files, and the verification commands the project itself defines",
        schema: z.object({
          path: z.string().optional().describe("Repository path (default: the Sidekick working directory)"),
          max_files: z.number().int().min(50).max(20000).optional().describe("Bound on the file scan (default 4000)"),
          include_git: z.boolean().optional().describe("Include git facts (default true)"),
        }),
        args: {
          path: "string (repository path)",
          max_files: "number (file scan bound, default 4000)",
          include_git: "boolean (default true)",
        },
        risk: "low",
        category: "Development",
        handler: args => devRepoProfile(services, args),
      },
      {
        name: "dev_change_summary",
        aliases: ["change_summary"],
        description:
          "Analyze a repository change set and return structured engineering impact: per-kind classification (source, tests, docs, config, migrations, dependencies, CI), affected areas, likely public API/schema changes with the symbols involved, dependency version changes, verification coverage signals, and evidence-backed risk indicators",
        schema: z.object({
          path: z.string().optional().describe("Repository path (default: the Sidekick working directory)"),
          base: z.string().optional().describe("Compare against this ref (e.g. origin/main); omit for working-tree changes"),
          staged: z.boolean().optional().describe("Analyze staged changes instead of unstaged (default false)"),
          max_diff_chars: z.number().int().min(1000).max(2000000).optional().describe("Bound on diff text analyzed (default 400000)"),
        }),
        args: {
          path: "string (repository path)",
          base: "string (base ref to diff against)",
          staged: "boolean (analyze staged changes)",
          max_diff_chars: "number (diff analysis bound)",
        },
        risk: "low",
        category: "Development",
        handler: args => devChangeSummary(services, args),
      },
      {
        name: "dev_verify",
        aliases: ["verify_project"],
        description:
          "Select and run a software project's own verification commands (syntax, lint, typecheck, test, build) through Sidekick's governed shell path, returning for each command what was selected, why, exactly what executed, the exit status, duration, bounded output, and an overall verification verdict",
        schema: z.object({
          path: z.string().optional().describe("Repository path (default: the Sidekick working directory)"),
          mode: z.enum(["quick", "standard", "full"]).optional().describe("Verification breadth (default from pack configuration, else standard)"),
          intents: z.array(z.enum(["syntax", "lint", "typecheck", "test", "build"])).optional().describe("Explicit intents, overriding mode"),
          continue_on_failure: z.boolean().optional().describe("Keep running later commands after a failure (default false)"),
          max_output_chars: z.number().int().min(500).max(60000).optional().describe("Bound on retained command output"),
          timeout_ms: z.number().int().min(1000).max(600000).optional().describe("Per-command timeout"),
        }),
        args: {
          path: "string (repository path)",
          mode: "string (quick|standard|full)",
          intents: "array (syntax|lint|typecheck|test|build)",
          continue_on_failure: "boolean",
          max_output_chars: "number",
          timeout_ms: "number",
        },
        risk: "high",
        category: "Development",
        handler: args => devVerify(services, args),
      },
    ];
  },

  healthCheck({ config }) {
    // Synchronous and cheap by contract. It verifies the module's own
    // preconditions: its libraries load, and any configured repository roots
    // and command overrides are usable.
    const details = {
      tools: 3,
      autodetect: config.autodetect_verification !== false,
      verification_mode: config.verification_mode || "standard",
      overrides: ["test_command", "lint_command", "typecheck_command", "build_command", "syntax_command"].filter(key => Boolean(config[key])),
    };
    const roots = Array.isArray(config.repository_roots) ? config.repository_roots : [];
    const missingRoots = roots.filter(root => !fsutil.isDirectory(path.resolve(root)));
    details.repository_roots = roots;
    if (missingRoots.length) {
      return { ok: false, error: `configured repository_roots do not exist: ${missingRoots.join(", ")}`, details };
    }
    return { ok: true, details };
  },
};

module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
