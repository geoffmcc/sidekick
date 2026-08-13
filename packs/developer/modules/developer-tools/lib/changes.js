"use strict";

/**
 * Change-set classification.
 *
 * Everything here is derived from the diff itself: paths, insertion/deletion
 * counts, and the added/removed lines of textual hunks. No judgement is
 * invented — where the analysis makes a claim ("this looks like an API
 * change"), it carries the concrete evidence that produced it, so a reviewer
 * can check the claim instead of trusting it.
 */

const path = require("path");

const TEST_PATTERNS = [
  /(^|\/)tests?(\/|$)/i,
  /(^|\/)__tests__(\/|$)/i,
  /(^|\/)spec(\/|$)/i,
  /\.(test|spec)\.[a-z]+$/i,
  /_test\.[a-z]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
];

const DOC_PATTERNS = [
  /(^|\/)docs?(\/|$)/i,
  /\.(md|mdx|rst|adoc|txt)$/i,
  /(^|\/)(README|CHANGELOG|ROADMAP|CONTRIBUTING|MIGRATION|SECURITY|AGENTS|CLAUDE)[^/]*$/i,
];

const CONFIG_PATTERNS = [
  /\.(json|ya?ml|toml|ini|cfg|conf|env\.example|properties)$/i,
  /(^|\/)\.[^/]*rc$/i,
  /(^|\/)(Dockerfile|Containerfile|Makefile|Justfile)$/i,
];

const CI_PATTERNS = [
  /^\.github\/workflows\//i,
  /^\.gitlab-ci\.yml$/i,
  /^\.circleci\//i,
  /^Jenkinsfile$/i,
  /^azure-pipelines\.ya?ml$/i,
];

const MIGRATION_PATTERNS = [
  /(^|\/)migrations?(\/|$)/i,
  /(^|\/)alembic\/versions(\/|$)/i,
  /(^|\/)prisma\/migrations(\/|$)/i,
  /(^|\/)db\/migrate(\/|$)/i,
];

const DEPENDENCY_FILES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "requirements.txt", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile", "Gemfile.lock",
  "composer.json", "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts",
]);

const SCHEMA_PATTERNS = [
  /schema/i,
  /\.sql$/i,
  /\.proto$/i,
  /\.graphql$/i,
  /openapi/i,
  /swagger/i,
];

const SECURITY_SENSITIVE_PATTERNS = [
  /auth/i, /login/i, /session/i, /token/i, /password/i, /crypt/i, /permission/i,
  /policy/i, /approval/i, /secret/i, /acl/i, /rbac/i,
];

const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs",
  ".rb", ".php", ".java", ".kt", ".scala", ".cs", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".swift", ".sh", ".bash", ".lua", ".dart", ".ex", ".exs", ".vue", ".svelte",
]);

function matchesAny(patterns, value) {
  return patterns.some(pattern => pattern.test(value));
}

/**
 * Classify one path. Order matters: a test file that also ends in `.ts` is a
 * test, and a migration is a migration even though it is also `.sql`.
 */
function classifyPath(filePath) {
  const base = path.basename(filePath);
  if (matchesAny(CI_PATTERNS, filePath)) return "ci";
  if (matchesAny(MIGRATION_PATTERNS, filePath)) return "migration";
  if (DEPENDENCY_FILES.has(base)) return "dependency";
  if (matchesAny(TEST_PATTERNS, filePath)) return "test";
  if (matchesAny(DOC_PATTERNS, filePath)) return "documentation";
  if (SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return "source";
  if (matchesAny(CONFIG_PATTERNS, filePath)) return "configuration";
  return "other";
}

/** Top-level area a path belongs to, used to describe blast radius. */
function areaOf(filePath) {
  const segments = filePath.split("/");
  if (segments.length === 1) return "(root)";
  if (segments.length === 2) return segments[0];
  return `${segments[0]}/${segments[1]}`;
}

const EXPORT_PATTERNS = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/,
  /^\s*module\.exports\s*=\s*\{?/,
  /^\s*exports\.([A-Za-z0-9_$]+)\s*=/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)(?:async\s+)?fn\s+([A-Za-z0-9_]+)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z][A-Za-z0-9_]*)\s*\(/,
  /^\s*def\s+([a-z_][A-Za-z0-9_]*)\s*\(/,
  /^\s*(?:public|protected)\s+[A-Za-z0-9_<>,\[\]\s]+\s+([A-Za-z0-9_]+)\s*\(/,
];

/**
 * Detect likely public-surface changes from unified diff text.
 *
 * This reads only lines the diff added or removed, and reports the symbol
 * names it saw. It does not claim to be a complete API diff — it is a signal
 * with its evidence attached, which is exactly what a reviewer needs.
 */
function detectApiSurfaceChanges(diffText) {
  const added = new Set();
  const removed = new Set();
  let currentFile = null;
  const byFile = new Map();
  // A multi-line `module.exports = {` block spans many diff lines; without
  // tracking it, moving a one-line export object to a multi-line one reads as
  // "every symbol removed". Tracked separately per direction, because the same
  // block can be removed in one form and added in another.
  const inExportBlock = { add: false, remove: false };

  for (const line of String(diffText || "").split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    if (!currentFile) continue;
    const isAdd = line.startsWith("+") && !line.startsWith("+++");
    const isRemove = line.startsWith("-") && !line.startsWith("---");
    if (!isAdd && !isRemove) continue;
    const body = line.slice(1);
    const bucketFor = () => {
      const bucket = byFile.get(currentFile) || { added: new Set(), removed: new Set() };
      byFile.set(currentFile, bucket);
      return bucket;
    };
    const record = symbol => {
      (isAdd ? bucketFor().added : bucketFor().removed).add(symbol);
      (isAdd ? added : removed).add(symbol);
    };

    // CommonJS exports the whole public surface in one object literal, so a
    // changed `module.exports = { a, b }` line IS the API change. Recording it
    // only as "(default export)" would hide exactly the names a caller depends
    // on, and CommonJS is the dominant shape in this codebase's ecosystem.
    const direction = isAdd ? "add" : "remove";
    const inlineExports = body.match(/^\s*module\.exports\s*=\s*\{([^}]*)\}/);
    if (inlineExports) {
      record("(default export)");
      for (const part of inlineExports[1].split(",")) {
        const name = part.split(":")[0].trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) record(name);
      }
      continue;
    }
    if (/^\s*module\.exports\s*=\s*\{\s*$/.test(body)) {
      record("(default export)");
      inExportBlock[direction] = true;
      continue;
    }
    if (inExportBlock[direction]) {
      if (/^\s*\}/.test(body)) {
        inExportBlock[direction] = false;
        continue;
      }
      const name = body.split(":")[0].replace(/,\s*$/, "").trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) record(name);
      continue;
    }

    for (const pattern of EXPORT_PATTERNS) {
      const match = body.match(pattern);
      if (!match) continue;
      record(match[1] || "(default export)");
      break;
    }
  }

  const files = [...byFile.entries()].map(([file, bucket]) => ({
    file,
    added_symbols: [...bucket.added].sort(),
    removed_symbols: [...bucket.removed].sort(),
  }));
  const removedOnly = [...removed].filter(symbol => !added.has(symbol)).sort();
  return {
    detected: files.length > 0,
    files,
    added_symbols: [...added].sort(),
    removed_symbols: [...removed].sort(),
    // Symbols that disappeared without reappearing are the ones most likely to
    // break a caller; they are called out separately.
    potentially_breaking: removedOnly,
  };
}

function detectDependencyChanges(diffText, files) {
  const changes = [];
  const dependencyFiles = files.filter(file => DEPENDENCY_FILES.has(path.basename(file.path)));
  if (!dependencyFiles.length) return { detected: false, files: [], entries: [] };

  let currentFile = null;
  const entries = [];
  for (const line of String(diffText || "").split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    if (!currentFile || !DEPENDENCY_FILES.has(path.basename(currentFile))) continue;
    const isAdd = line.startsWith("+") && !line.startsWith("+++");
    const isRemove = line.startsWith("-") && !line.startsWith("---");
    if (!isAdd && !isRemove) continue;
    const body = line.slice(1).trim();
    // "name": "^1.2.3"   |   name = "1.2.3"   |   name==1.2.3   |   name>=1.2
    const match =
      body.match(/^"([^"]+)"\s*:\s*"([^"]+)"/) ||
      body.match(/^([A-Za-z0-9_.\-@/]+)\s*=\s*"([^"]+)"/) ||
      body.match(/^([A-Za-z0-9_.\-@/]+)\s*(?:==|>=|~=|<=)\s*([0-9][^\s;]*)/);
    if (!match) continue;
    entries.push({ file: currentFile, name: match[1], version: match[2], direction: isAdd ? "added" : "removed" });
  }

  // Pair added/removed entries for the same dependency into version changes.
  const byName = new Map();
  for (const entry of entries) {
    const bucket = byName.get(entry.name) || { name: entry.name, file: entry.file };
    bucket[entry.direction === "added" ? "to" : "from"] = entry.version;
    byName.set(entry.name, bucket);
  }
  const summarized = [...byName.values()].map(entry => ({
    ...entry,
    change: entry.from && entry.to ? "updated" : entry.to ? "added" : "removed",
  }));

  return {
    detected: true,
    files: dependencyFiles.map(file => file.path),
    entries: summarized.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100),
  };
}

/**
 * Build the full structured impact analysis for a change set.
 * `files` comes from git numstat/name-status; `diffText` is the unified diff.
 */
function analyzeChangeSet({ files = [], diffText = "", insertions = 0, deletions = 0, binaryFiles = 0 } = {}) {
  const classified = { source: [], test: [], documentation: [], configuration: [], migration: [], dependency: [], ci: [], other: [] };
  const areas = new Map();

  for (const file of files) {
    const kind = classifyPath(file.path);
    classified[kind].push(file);
    const area = areaOf(file.path);
    const bucket = areas.get(area) || { area, files: 0, insertions: 0, deletions: 0 };
    bucket.files++;
    bucket.insertions += file.insertions || 0;
    bucket.deletions += file.deletions || 0;
    areas.set(area, bucket);
  }

  const api = detectApiSurfaceChanges(diffText);
  const dependencies = detectDependencyChanges(diffText, files);

  const sourceFiles = classified.source;
  const testFiles = classified.test;
  const securitySensitive = files.filter(file => matchesAny(SECURITY_SENSITIVE_PATTERNS, file.path)).map(file => file.path);
  const schemaTouching = files.filter(file => matchesAny(SCHEMA_PATTERNS, file.path)).map(file => file.path);

  const verification = {
    source_files_changed: sourceFiles.length,
    test_files_changed: testFiles.length,
    tests_accompany_source: sourceFiles.length === 0 || testFiles.length > 0,
    documentation_changed: classified.documentation.length > 0,
    // "Untested areas" is a coverage HEURISTIC over paths, not a coverage
    // measurement: an area with changed source and no changed test in the same
    // area is flagged for a reviewer to consider, nothing more.
    areas_with_source_but_no_tests: [...new Set(
      sourceFiles.map(file => areaOf(file.path)).filter(area => !testFiles.some(test => areaOf(test.path) === area))
    )].sort(),
  };

  const risks = [];
  if (classified.migration.length) {
    risks.push({ risk: "schema_migration", severity: "high", evidence: classified.migration.map(f => f.path) });
  }
  if (api.potentially_breaking.length) {
    risks.push({ risk: "removed_public_symbols", severity: "high", evidence: api.potentially_breaking });
  }
  if (dependencies.entries.length) {
    risks.push({ risk: "dependency_change", severity: "medium", evidence: dependencies.entries.map(e => `${e.name}: ${e.from || "-"} -> ${e.to || "-"}`) });
  }
  if (securitySensitive.length) {
    risks.push({ risk: "security_sensitive_paths", severity: "medium", evidence: securitySensitive });
  }
  if (schemaTouching.length) {
    risks.push({ risk: "schema_or_contract_files", severity: "medium", evidence: schemaTouching });
  }
  if (sourceFiles.length > 0 && testFiles.length === 0) {
    risks.push({ risk: "source_changed_without_tests", severity: "medium", evidence: sourceFiles.slice(0, 20).map(f => f.path) });
  }
  if (classified.ci.length) {
    risks.push({ risk: "ci_configuration_change", severity: "medium", evidence: classified.ci.map(f => f.path) });
  }
  if (binaryFiles > 0) {
    risks.push({ risk: "binary_files_changed", severity: "low", evidence: files.filter(f => f.binary).map(f => f.path) });
  }
  const churn = insertions + deletions;
  if (churn > 2000) {
    risks.push({ risk: "large_change_set", severity: "medium", evidence: [`${churn} changed lines across ${files.length} files`] });
  }

  const severityRank = { high: 3, medium: 2, low: 1 };
  const overall = risks.length === 0
    ? "low"
    : Object.entries(severityRank).sort((a, b) => b[1] - a[1]).find(([level]) => risks.some(risk => risk.severity === level))[0];

  return {
    totals: {
      files: files.length,
      insertions,
      deletions,
      churn,
      binary_files: binaryFiles,
    },
    by_kind: Object.fromEntries(
      Object.entries(classified).map(([kind, entries]) => [kind, {
        count: entries.length,
        insertions: entries.reduce((sum, file) => sum + (file.insertions || 0), 0),
        deletions: entries.reduce((sum, file) => sum + (file.deletions || 0), 0),
        files: entries.map(file => file.path).slice(0, 100),
      }])
    ),
    areas: [...areas.values()].sort((a, b) => (b.insertions + b.deletions) - (a.insertions + a.deletions)).slice(0, 25),
    api_surface: api,
    dependencies,
    verification,
    risks,
    risk_level: overall,
  };
}

module.exports = { analyzeChangeSet, classifyPath, areaOf, detectApiSurfaceChanges, detectDependencyChanges, DEPENDENCY_FILES };
