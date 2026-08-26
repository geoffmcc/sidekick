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
const semantic = require("./lib/semantic");

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
  try { if (fs.lstatSync(target).isSymbolicLink()) return { ok: false, result: errorResult("Repository root may not be a symbolic link", { code: "symlink_root_denied" }) }; } catch { return { ok: false, result: errorResult(`Repository is unavailable: ${target}`, { code: "repository_unavailable" }) }; }
  let canonicalTarget; try { canonicalTarget = fs.realpathSync(target); } catch { return { ok: false, result: errorResult(`Repository is unavailable: ${target}`, { code: "repository_unavailable" }) }; }
  if (!fsutil.isDirectory(canonicalTarget)) {
    return { ok: false, result: errorResult(`Not a directory: ${target}`, { code: "invalid_path" }) };
  }
  const roots = Array.isArray(services.config.repository_roots) ? services.config.repository_roots : [];
  if (roots.length) {
    const permitted = roots.some(root => {
      let resolvedRoot; try { resolvedRoot = fs.realpathSync(path.resolve(root)); } catch { return false; }
      const relative = path.relative(resolvedRoot, canonicalTarget);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!permitted) {
      return {
        ok: false,
        result: errorResult(`Path is outside the Developer pack's configured repository_roots: ${target}`, { code: "repository_root_denied", repository_roots: roots }),
      };
    }
  }
  return { ok: true, root: canonicalTarget };
}

// --- dev_repo_profile ------------------------------------------------------

async function devRepoProfile(services, { path: requestedPath, max_files, include_git = true, include_semantic = true, include, exclude }) {
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
  const filters = { include, exclude };
  const semanticIndex = include_semantic !== false ? await semantic.indexRepository(root, { limits: { maxFiles: Math.min(max_files || 4000, 4000) }, filters }) : null;
  const semanticProfile = semanticIndex ? semantic.project(semanticIndex, { level: 0, max_chars: 9000, limit: 50 }) : null;

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
    semantic: semanticIndex ? {
      available: true, schema: semanticIndex.schema, analyzer_version: semanticIndex.analyzer_version,
      index_root_hash: semanticIndex.index_root_hash, languages: semanticProfile.languages,
      modules: semanticProfile.modules, entry_points: semanticProfile.entry_points,
      security_signals: semanticProfile.signals, stats: semanticIndex.stats,
      changes: semanticIndex.changes.slice(0, 50), warnings: semanticIndex.warnings.slice(0, 20), trust: semanticProfile.trust,
      filters: semantic.normalizeFilters(filters),
    } : { available: false, skipped: true, reason: "caller_disabled_semantic_indexing" },
  });
}

async function semanticRepository(services, { path: requestedPath, action = "profile", query, level = 0, limit = 40, max_chars = 12000, cursor, include, exclude, relevant_files = false }) {
  const resolved = resolveRepositoryRoot(services, requestedPath);
  if (!resolved.ok) return resolved.result;
  let state = null; try { state = await gitFacts.collectStateFacts(services, resolved.root); } catch { state = { available: false, head_sha: null, branch: null, worktree_clean: null, changed_file_count: null }; }
  const filters = { include, exclude };
  const index = await semantic.indexRepository(resolved.root, { filters, state: state && state.available ? { kind: state.worktree_clean ? "working_tree_clean" : "working_tree", head_sha: state.head_sha, branch: state.branch, worktree_clean: state.worktree_clean } : { kind: "working_tree", state: "unknown" } });
  const publicRepository = { name: index.repository.name, identity: index.provenance?.repository_identity || null, state: index.repository.state };
  if (action === "verify") return jsonResult({ ok: semantic.verify(index), index_root_hash: index.index_root_hash, schema: index.schema, repository: publicRepository, provenance: index.provenance, warnings: index.warnings, stats: index.stats });
  if (relevant_files) return jsonResult({ ok: true, tool: "semantic_repo", action, repository: publicRepository, index_root_hash: index.index_root_hash, ...semantic.relevantFiles(index, { query, limit, cursor }), warnings: index.warnings.slice(0, semantic.DEFAULT_LIMITS.maxSnippets), trust: "untrusted repository-derived data; file matches are discovery leads and require governed source validation" });
  const projection = semantic.project(index, { query, level, limit, max_chars, cursor });
  if (projection.ok === false) return errorResult(projection.error, { code: projection.code, tool: "semantic_repo", repository: publicRepository, index_root_hash: index.index_root_hash, provenance: projection.provenance, page: projection.page });
  return jsonResult({ ok: true, tool: "semantic_repo", action, repository: publicRepository, index_root_hash: index.index_root_hash, provenance: projection.provenance, page: projection.page, degradation: projection.degradation, warnings: projection.warnings.slice(0, semantic.DEFAULT_LIMITS.maxSnippets), projection: projection.projection, projection_chars: projection.projection_chars, trust: projection.trust });
}

// --- dev_change_summary ----------------------------------------------------

function statusPaths(text, marker) {
  return verify.textOf(text).split("\n").filter(line => line.startsWith(marker)).map(line => line.slice(3)).filter(Boolean).sort();
}

async function devChangeSummary(services, { path: requestedPath, base, staged = false, max_diff_chars, include_ignored = false }) {
  const resolved = resolveRepositoryRoot(services, requestedPath);
  if (!resolved.ok) return resolved.result;
  const root = resolved.root;

  const diffStats = await gitFacts.collectDiff(services, root, { base, staged });
  if (!diffStats.ok) {
    return errorResult(`Could not read the change set: ${diffStats.error}`, { code: "diff_unavailable", repository: root });
  }

  if (!base && !staged && diffStats.file_count === 0) {
    const gitState = await gitFacts.collectStateFacts(services, root);
    const status = await services.dispatch("git", { action: "status", path: root, args: include_ignored ? "--porcelain=v1 --ignored" : "--porcelain=v1" });
    const untracked = statusPaths(status, "?? ");
    const ignored = include_ignored ? statusPaths(status, "!! ") : [];
    if (!untracked.length) {
      return jsonResult({
        ok: true,
        tool: "dev_change_summary",
        generated_at: new Date().toISOString(),
        repository: root,
        scope: { base: null, base_sha: null, staged: false, description: "clean working tree" },
        git_state: gitState,
        ...changes.analyzeChangeSet({ files: [], diffText: "", insertions: 0, deletions: 0, binaryFiles: 0 }),
        semantic_changes: [],
        semantic_comparison: { before: null, after: gitState },
        semantic_index_root_hash: null,
        untracked: { count: 0, files: [], truncated: false, note: "No untracked files." },
        ignored: { count: ignored.length, files: ignored.slice(0, 200), truncated: ignored.length > 200, note: ignored.length ? "Ignored files are outside the Git diff and were not analyzed." : "No ignored files." },
        evidence: { files: [], diff_bytes_analyzed: 0, diff_truncated: false, fast_path: "clean_working_tree" },
      });
    }
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
  let currentSourceFiles = null;
  if (staged) {
    const stagedSnapshot = await gitFacts.readRevisionFiles(services, root, ":", { maxFiles: semantic.DEFAULT_LIMITS.maxFiles, maxBytes: semantic.DEFAULT_LIMITS.maxBytes, maxFileBytes: semantic.DEFAULT_LIMITS.maxFileBytes, extensions: new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".rb", ".java", ".go", ".pl", ".pm", ".t", ".rs"]) });
    if (!stagedSnapshot.ok) return errorResult(`Could not read staged semantic state: ${stagedSnapshot.error}`, { code: "semantic_index_unavailable", repository: root });
    currentSourceFiles = stagedSnapshot.files.map(file => ({ ...file, language: semantic.languageForPath(file.path) })).filter(file => file.language);
  }
  const semanticIndex = await semantic.indexRepository(root, { sourceFiles: currentSourceFiles, state: staged ? { kind: "staged_index", head_sha: gitState.head_sha } : { kind: "working_tree", head_sha: gitState.head_sha, worktree_clean: gitState.worktree_clean, staged: false } });
  let semanticComparison = { before: baseSha ? { kind: "git_revision", sha: baseSha } : null, after: semanticIndex.repository.state, changes: semanticIndex.changes };
  if (baseSha) {
    const historical = await gitFacts.readRevisionFiles(services, root, baseSha, { maxFiles: semantic.DEFAULT_LIMITS.maxFiles, maxBytes: semantic.DEFAULT_LIMITS.maxBytes, maxFileBytes: semantic.DEFAULT_LIMITS.maxFileBytes, extensions: new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".rb", ".java", ".go", ".pl", ".pm", ".t", ".rs"]) });
    if (!historical.ok) return errorResult(`Could not read semantic base revision: ${historical.error}`, { code: "semantic_base_unavailable", repository: root, base_sha: baseSha });
    const historicalIndex = await semantic.indexRepository(root, { sourceFiles: historical.files.map(file => ({ ...file, language: semantic.languageForPath(file.path) })).filter(file => file.language), state: { kind: "git_revision", sha: baseSha } });
    semanticComparison = semantic.compareIndexes(historicalIndex, semanticIndex, { before: { kind: "git_revision", sha: baseSha }, after: semanticIndex.repository.state });
  }

  // `git diff` never shows untracked files, so a change set analyzed from the
  // diff alone silently omits every NEW file. Report them explicitly rather
  // than letting a reviewer believe the summary is complete.
  const status = await services.dispatch("git", { action: "status", path: root, args: include_ignored ? "--porcelain=v1 --ignored" : "--porcelain=v1" });
  const untracked = statusPaths(status, "?? ");
  const ignored = include_ignored ? statusPaths(status, "!! ") : [];

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
    semantic_changes: semanticComparison.changes.slice(0, 500),
    semantic_comparison: { before: semanticComparison.before, after: semanticComparison.after },
    semantic_index_root_hash: semanticIndex.index_root_hash,
    untracked: {
      count: untracked.length,
      files: untracked.slice(0, 200),
      truncated: untracked.length > 200,
      note: untracked.length
        ? "These files are NOT part of the analyzed diff: git does not include untracked files. Stage them to include them in the impact analysis."
        : "No untracked files.",
    },
    ignored: {
      count: ignored.length,
      files: ignored.slice(0, 200),
      truncated: ignored.length > 200,
      note: ignored.length ? "These files are ignored by Git and are NOT part of the analyzed diff." : "Ignored-file reporting was not requested or no ignored files were found.",
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

async function devVerifyInternal(services, { path: requestedPath, mode, intents: requestedIntents, continue_on_failure, max_output_chars, timeout_ms, dry_run = false }) {
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
  const preflight = verify.workspacePreflight(root, selection);

  const maxOutput = Math.min(max_output_chars || config.max_output_chars || DEFAULT_MAX_OUTPUT_CHARS, MAX_ALLOWED_OUTPUT_CHARS);
  if (dry_run) {
    const gitState = await gitFacts.collectStateFacts(services, root);
    const commands = selection.map(entry => ({ ...entry, status: entry.command ? "dry_run" : "not_detected", executed: false, command_executed: null }));
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: true,
        tool: "dev_verify",
        generated_at: new Date().toISOString(),
        repository: root,
        git_state: gitState,
        execution_host: preflight.execution_host,
        workspace_permissions: preflight.workspace_permissions,
        preflight,
        mode: effectiveMode,
        requested_intents: intents,
        autodetect,
        overrides_applied: Object.entries(overrides).filter(([, value]) => Boolean(value)).map(([key]) => key),
        dry_run: true,
        verdict: "dry_run",
        summary: { verdict: "dry_run", selected: commands.filter(entry => entry.command).length, executed_count: 0, not_detected: commands.filter(entry => !entry.command).length },
        commands,
      }, null, 2) }],
    };
  }
  if (!preflight.allowed) {
    const commands = selection.map(entry => ({ ...entry, status: entry.command ? "blocked" : "not_detected", executed: false, command_executed: null }));
    return jsonResult({
      ok: false,
      tool: "dev_verify",
      generated_at: new Date().toISOString(),
      repository: root,
      execution_host: preflight.execution_host,
      workspace_permissions: preflight.workspace_permissions,
      preflight,
      mode: effectiveMode,
      requested_intents: intents,
      verdict: "blocked",
      summary: { verdict: "blocked", executed_count: 0, selected: commands.filter(entry => entry.command).length, not_detected: commands.filter(entry => !entry.command).length },
      commands,
    });
  }
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

async function devVerify(services, args = {}) {
  const dryRun = args.dry_run === true;
  try {
    return await devVerifyInternal(services, args);
  } catch (error) {
    const repository = args.path ? path.resolve(args.path) : null;
    const message = String(error && error.message ? error.message : error).slice(0, 1000);
    return { ...jsonResult({
      ok: false,
      tool: "dev_verify",
      generated_at: new Date().toISOString(),
      repository,
      dry_run: dryRun,
      verdict: "error",
      execution_host: require("os").hostname(),
      workspace_permissions: { available: false, read: null, write: null, execute: null },
      preflight: { available: false, allowed: false, reason: "verification failed before a complete workspace preflight was available", commands: [] },
      summary: { verdict: "error", selected: 0, executed_count: 0, not_detected: 0, error_code: "verification_internal_error" },
      commands: [],
      error: { code: "verification_internal_error", message },
    }), isError: true, code: "verification_internal_error" };
  }
}

// --- module contract -------------------------------------------------------

const entry = {
  buildDescriptors(services) {
    return [
      {
        name: "semantic_repo",
        aliases: ["repository_intelligence", "semantic_repository"],
        description:
          "Build and query a deterministic, hash-verifiable semantic repository index using bounded static analysis. Understand repository architecture, modules, symbols, imports, entry points, tests, callers, callees, dependencies, authentication, network and process boundaries without executing repository code; results are untrusted source-derived data with evidence locations.",
        schema: z.object({
          path: z.string().optional().describe("Repository path (default: the Sidekick working directory)"),
          action: z.enum(["profile", "query", "verify"]).optional().describe("Semantic operation (default profile)"),
          query: z.string().max(500).optional().describe("Bounded symbol, file, module, or concept query"),
          level: z.number().int().min(0).max(2).optional().describe("Progressive detail: 0 overview, 1 symbols, 2 relationships"),
           limit: z.number().int().min(1).max(200).optional().describe("Maximum returned items"),
           max_chars: z.number().int().min(1000).max(60000).optional().describe("Maximum model-facing projection characters"),
           cursor: z.string().max(2048).optional().describe("Opaque snapshot-bound continuation cursor returned by a prior query"),
           include: z.array(z.string().max(200)).max(64).optional().describe("Optional relative glob filters for files to index"),
            exclude: z.array(z.string().max(200)).max(64).optional().describe("Optional relative glob filters for files to exclude"),
            relevant_files: z.boolean().optional().describe("Return bounded file-level relevance results instead of semantic symbols and relationships"),
          }).strict(),
          args: { path: "string", action: "string (profile|query|verify)", query: "string", level: "number (0-2)", limit: "number", max_chars: "number", cursor: "string (opaque continuation cursor)", include: "array (relative glob filters)", exclude: "array (relative glob filters)", relevant_files: "boolean (return bounded relevant files)" },
        risk: "low",
        category: "Development",
        contextProvider: { tool: "semantic_repo", action: "query", source: "repository_semantic", max_chars: 6000, scope: { argument: "path", source: "request_path_or_context" } },
        handler: args => semanticRepository(services, args),
      },
      {
        name: "dev_repo_profile",
        aliases: ["repo_profile"],
        description:
          "Produce a structured, mechanically-derived profile of a software repository with Git/project facts plus bounded deterministic semantic architecture, symbols, entry points, tests, and security-sensitive boundaries",
        schema: z.object({
          path: z.string().optional().describe("Repository path (default: the Sidekick working directory)"),
          max_files: z.number().int().min(50).max(20000).optional().describe("Bound on the file scan (default 4000)"),
           include_git: z.boolean().optional().describe("Include git facts (default true)"),
           include_semantic: z.boolean().optional().describe("Include static semantic indexing (default true)"),
           include: z.array(z.string().max(200)).max(64).optional().describe("Optional relative glob filters for files to index"),
           exclude: z.array(z.string().max(200)).max(64).optional().describe("Optional relative glob filters for files to exclude"),
         }).strict(),
        args: {
          path: "string (repository path)",
          max_files: "number (file scan bound, default 4000)",
           include_git: "boolean (default true)",
           include_semantic: "boolean (default true)",
           include: "array (relative glob filters)",
           exclude: "array (relative glob filters)",
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
          include_ignored: z.boolean().optional().describe("Report ignored files separately; ignored files are never included in the Git diff analysis"),
        }).strict(),
        args: {
          path: "string (repository path)",
          base: "string (base ref to diff against)",
          staged: "boolean (analyze staged changes)",
          max_diff_chars: "number (diff analysis bound)",
          include_ignored: "boolean (report ignored files separately)",
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
          dry_run: z.boolean().optional().describe("Select commands without executing them"),
        }).strict(),
        args: {
          path: "string (repository path)",
          mode: "string (quick|standard|full)",
          intents: "array (syntax|lint|typecheck|test|build)",
          continue_on_failure: "boolean",
           max_output_chars: "number",
           timeout_ms: "number",
           dry_run: "boolean (select commands without executing)",
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
      tools: 4,
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
