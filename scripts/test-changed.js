#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { discoverSuites, runSuites } = require("../test/suite-runner");

const root = path.resolve(__dirname, "..");
const sourceExtensions = ["", ".js", ".cjs", ".mjs", ".json"];

// These are intentionally small, reviewed fallbacks. They are not substitutes
// for a graph match; they cover loader boundaries when static evidence is weak.
const FALLBACK_SUITES = Object.freeze({
  dashboard: ["test/dashboard-api.test.js", "test/dashboard-shell.test.js"],
  workflow: ["test/workflow-definitions.test.js", "test/workflow-runner.test.js", "test/cross-pack-workflow-fixtures.test.js"],
  pack: ["test/pack-manifest-consistency.test.js", "test/capability-packs.test.js"],
  knowledge: ["test/knowledge-promotion.test.js", "test/documentation-drift.test.js"],
  migration: ["test/migration-self-containment.test.js", "test/kernel-migration-parity.test.js", "test/fts-migration-parity.test.js"],
  persistence: ["test/db-tools.test.js", "test/kernel-migration-parity.test.js"],
  dependency: ["test/github-setup.test.js", "test/release-manifest.test.js"],
  github: ["test/github-setup.test.js", "test/ci-status.test.js"],
  ci: ["test/github-setup.test.js", "test/scripts-quality-gates.test.js"],
  test: ["test/scripts-quality-gates.test.js", "test/run-all.test.js"],
  fixture: ["test/scripts-quality-gates.test.js", "test/static-code-quality.test.js"],
  config: ["test/config-registry.test.js", "test/static-code-quality.test.js"],
  dynamic: ["test/modules-discovery.test.js", "test/workflow-definitions.test.js", "test/capability-catalog.test.js"],
  source: ["test/static-code-quality.test.js", "test/architecture-boundaries.test.js"],
  unknown: ["test/static-code-quality.test.js", "test/architecture-boundaries.test.js"],
});

const FALLBACK_DOMAINS = Object.freeze({
  dashboard: ["platforms"], workflow: ["packs"], pack: ["packs"], knowledge: ["compatibility", "packs"],
  migration: ["compatibility", "platforms"], persistence: ["compatibility", "platforms"],
  dependency: ["compatibility", "platforms"], github: ["compatibility", "platforms"], ci: ["compatibility"],
  test: ["compatibility", "core"], fixture: ["core", "platforms"], config: ["core", "compatibility"],
  dynamic: ["packs", "platforms", "core"], source: ["core", "platforms", "compatibility"],
  unknown: ["core", "platforms", "compatibility"],
});

function normalize(file) { return file.split(path.sep).join("/").replace(/^\.\//, ""); }

function relativeFile(file, repositoryRoot = root) {
  return normalize(path.isAbsolute(file) ? path.relative(repositoryRoot, file) : file);
}

function stripJavaScriptComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function importSpecifiers(source) {
  const clean = stripJavaScriptComments(source);
  const specs = [];
  const patterns = [
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\.resolve\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\b(?:import|export)\s+(?:(?:[^"';]*?)\s+from\s+)?["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) for (const match of clean.matchAll(pattern)) specs.push(match[1]);
  return [...new Set(specs)];
}

function quotedValues(text) {
  return [...text.matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
}

function runtimeSpecifiers(source) {
  const clean = stripJavaScriptComments(source);
  const specs = [];
  const direct = /\b(?:readFileSync|readFile|readFilePromise|existsSync|createReadStream|accessSync)\s*\(\s*["']([^"']+)["']/g;
  for (const match of clean.matchAll(direct)) specs.push(match[1]);
  const joined = /\bpath\.(?:join|resolve)\s*\(\s*__dirname\s*,\s*([^)]*)\)/g;
  for (const match of clean.matchAll(joined)) {
    const parts = quotedValues(match[1]);
    if (parts.length) specs.push(parts.join("/"));
  }
  return [...new Set(specs)];
}

function hasDynamicRegistration(source) {
  const clean = stripJavaScriptComments(source);
  return /\b(?:fs\.)?readdir(?:Sync)?\s*\(|\bglob(?:Sync)?\s*\(|\b(?:require|import)\s*\(\s*[A-Za-z_$]/.test(clean)
    || /\b(?:register|discover|load)(?:[A-Z][A-Za-z]+)*(?:Pack|Workflow|Knowledge|Module|Tool|Plugin|Manifest|Config)\s*\(/.test(clean);
}

function importCandidates(fromFile, specifier, repositoryRoot = root) {
  if (!specifier.startsWith(".")) return [];
  const base = path.resolve(repositoryRoot, path.dirname(fromFile), specifier);
  const candidates = [];
  for (const extension of sourceExtensions) candidates.push(`${base}${extension}`);
  for (const extension of sourceExtensions.slice(1)) candidates.push(path.join(base, `index${extension}`));
  return candidates;
}

function resolveImport(fromFile, specifier, repositoryRoot = root) {
  for (const candidate of importCandidates(fromFile, specifier, repositoryRoot)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return normalize(path.relative(repositoryRoot, candidate));
  }
  return null;
}

function unresolvedImport(fromFile, specifier, repositoryRoot = root) {
  const candidates = importCandidates(fromFile, specifier, repositoryRoot);
  if (!candidates.length) return null;
  const explicitExtension = path.extname(specifier) ? candidates[0] : `${path.resolve(repositoryRoot, path.dirname(fromFile), specifier)}.js`;
  return normalize(path.relative(repositoryRoot, explicitExtension));
}

function resolveRuntimeFile(fromFile, specifier, repositoryRoot = root) {
  if (!specifier.startsWith(".")) return null;
  const absolute = path.resolve(repositoryRoot, path.dirname(fromFile), specifier);
  const candidates = [absolute, ...sourceExtensions.slice(1).map(extension => `${absolute}${extension}`)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return normalize(path.relative(repositoryRoot, candidate));
  }
  return normalize(path.relative(repositoryRoot, absolute));
}

function buildDependencyGraph(suites, repositoryRoot = root) {
  const graph = new Map();
  const metadata = { dynamic_files: new Set(), runtime_files: new Set() };
  const visit = file => {
    if (graph.has(file)) return graph.get(file);
    const dependencies = new Set();
    graph.set(file, dependencies);
    const absolute = path.join(repositoryRoot, file);
    if (!fs.existsSync(absolute) || !/\.(?:c|m)?js$/.test(file)) return dependencies;
    const source = fs.readFileSync(absolute, "utf8");
    if (hasDynamicRegistration(source)) metadata.dynamic_files.add(file);
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveImport(file, specifier, repositoryRoot) || unresolvedImport(file, specifier, repositoryRoot);
      if (resolved) { dependencies.add(resolved); visit(resolved); }
    }
    for (const specifier of runtimeSpecifiers(source)) {
      const resolved = resolveRuntimeFile(file, specifier, repositoryRoot);
      if (resolved) { dependencies.add(resolved); metadata.runtime_files.add(resolved); visit(resolved); }
    }
    return dependencies;
  };
  for (const suite of suites) visit(relativeFile(suite.file, repositoryRoot));
  graph.metadata = metadata;
  return graph;
}

function dependencyClosure(graph, start) {
  const seen = new Set();
  const visit = file => { if (seen.has(file)) return; seen.add(file); for (const dependency of graph.get(file) || []) visit(dependency); };
  visit(start);
  return seen;
}

function classifyPath(file) {
  const normalized = normalize(file);
  const lower = normalized.toLowerCase();
  if (/^(?:readme|changelog|license)(?:\.|$)/i.test(normalized) || lower.startsWith("docs/") || lower.startsWith("artifacts/")) return { impactful: false, categories: ["documentation"] };
  const categories = [];
  const add = category => { if (!categories.includes(category)) categories.push(category); };
  if (lower.startsWith(".github/workflows/")) add("github");
  if (lower === "package.json" || lower === "package-lock.json" || /(?:^|\/)(?:npm-shrinkwrap|yarn|pnpm-lock)\.ya?ml$/.test(lower)) add("dependency");
  if (lower.startsWith("migrations/") || /(?:^|\/)(?:migration|persistence|db|database)[^/]*\.(?:js|cjs|mjs|json|sql)$/.test(lower)) add("migration");
  if (lower.includes("dashboard") || lower.startsWith("static/") || lower.startsWith("src/browser/")) add("dashboard");
  if (lower.startsWith("packs/")) {
    add("pack");
    if (lower.includes("/workflows/")) add("workflow");
    if (lower.includes("/knowledge/")) add("knowledge");
    if (lower.endsWith("sidekick.pack.json") || lower.includes("/modules/")) add("config");
  }
  if (lower.startsWith("test/manifests/") || lower === "test/suite-resources.json" || /(?:^|\/)(?:fixtures?|resources?)\//.test(lower)) add("fixture");
  if (lower.startsWith("test/helpers/") || lower.includes("fixture")) add("fixture");
  if (lower.startsWith("scripts/") || lower.startsWith("test/") || lower.startsWith(".github/")) add("test");
  if (/(?:^|\/)(?:config|configuration)[^/]*\//.test(lower) || /(?:^|\/)(?:config|configuration)[^/]*\.(?:js|cjs|mjs|json|ya?ml|ini|toml)$/.test(lower)) add("config");
  if (lower.startsWith("src/") || /\.(?:js|cjs|mjs)$/.test(lower)) add("source");
  if (!categories.length && /\.(?:json|ya?ml|yaml|ini|toml|env|properties|xml|csv|sql)$/.test(lower)) add("config");
  if (!categories.length) add("unknown");
  return { impactful: true, categories };
}

function isSafeFallbackSuite(file) {
  return !/(?:flake|suite[-_]?resources?|resource|monolith)/i.test(file) && file !== "test/integration.test.js";
}

function fallbackCategory(info, dynamic) {
  const explicitCategories = ["dashboard", "workflow", "knowledge", "pack", "migration", "persistence", "dependency", "github", "ci", "test", "fixture", "config"];
  if (dynamic && !info.categories.some(category => explicitCategories.includes(category))) return "dynamic";
  for (const category of ["dashboard", "workflow", "knowledge", "pack", "migration", "persistence", "dependency", "github", "ci", "fixture", "config", "test", "source", "unknown"]) {
    if (info.categories.includes(category)) return category;
  }
  return "unknown";
}

function availableFallbacks(category, suites, options = {}) {
  const byFile = new Map(suites.map(suite => [suite.file, suite]));
  const configured = options.fallbackSuites?.[category] || options.fallbackSuites?.unknown;
  const named = configured || FALLBACK_SUITES[category] || FALLBACK_SUITES.unknown;
  const explicit = named.filter(file => byFile.has(file) && isSafeFallbackSuite(file));
  if (explicit.length) return explicit;
  const domains = FALLBACK_DOMAINS[category] || FALLBACK_DOMAINS.unknown;
  return suites.filter(suite => domains.includes(suite.domain) && isSafeFallbackSuite(suite.file)).map(suite => suite.file);
}

function selectChangedTests(changed, suites, repositoryRoot = root, options = {}) {
  const changedFiles = new Set(changed.flatMap(item => [item.file, item.oldFile].filter(Boolean)).map(file => relativeFile(file, repositoryRoot)));
  const graph = buildDependencyGraph(suites, repositoryRoot);
  const selected = new Set();
  const reasons = {};
  const matchedFiles = new Set();
  const dynamicGraph = graph.metadata?.dynamic_files?.size > 0;
  for (const suite of suites) {
    const suiteFile = relativeFile(suite.file, repositoryRoot);
    const closure = dependencyClosure(graph, suiteFile);
    const direct = changedFiles.has(suiteFile);
    const imports = [...changedFiles].filter(file => file !== suiteFile && closure.has(file)).sort();
    if (!direct && !imports.length) continue;
    selected.add(suite.file);
    for (const file of [suiteFile, ...imports]) matchedFiles.add(file);
    reasons[suite.file] = { owner: suite.owner || suite.domain, domain: suite.domain, direct_change: direct, imported_changes: imports, fallback: false };
  }

  const impactful = [...changedFiles].filter(file => classifyPath(file).impactful);
  const unmatched = impactful.filter(file => !matchedFiles.has(file)).sort();
  const fallbackByFile = {};
  const fallbackReasons = {};
  const fallbackSelected = new Set();
  for (const file of unmatched) {
    const info = classifyPath(file);
    const category = fallbackCategory(info, dynamicGraph);
    const candidates = availableFallbacks(category, suites, options);
    fallbackByFile[file] = { category, candidates };
    if (!candidates.length) continue;
    for (const suiteFile of candidates) {
      fallbackSelected.add(suiteFile);
      fallbackReasons[suiteFile] = fallbackReasons[suiteFile] || [];
      fallbackReasons[suiteFile].push({ file, category, reason: "unmatched-impactful-change" });
    }
  }
  // A clean or documentation-only diff still must not report a successful zero-test run.
  if (!selected.size && !fallbackSelected.size) {
    const candidates = availableFallbacks("unknown", suites, options);
    for (const suiteFile of candidates) {
      fallbackSelected.add(suiteFile);
      fallbackReasons[suiteFile] = [{ category: "unknown", reason: "no-tests-selected" }];
    }
  }
  for (const suiteFile of fallbackSelected) {
    selected.add(suiteFile);
    reasons[suiteFile] = { ...(reasons[suiteFile] || {}), owner: suites.find(suite => suite.file === suiteFile)?.owner, domain: suites.find(suite => suite.file === suiteFile)?.domain, direct_change: Boolean(reasons[suiteFile]?.direct_change), imported_changes: reasons[suiteFile]?.imported_changes || [], fallback: true, fallback_reasons: fallbackReasons[suiteFile] };
  }
  const fallbackRequired = unmatched.length > 0 || (!selected.size && fallbackSelected.size > 0);
  const fallbackUnavailable = Object.entries(fallbackByFile).filter(([, value]) => !value.candidates.length).map(([file]) => file).sort();
  return {
    selected: [...selected].sort(),
    reasons,
    changed_files: [...changedFiles].sort(),
    impactful_changes: impactful.sort(),
    unmatched_changes: unmatched,
    impactful_unmatched_changes: unmatched,
    fallback_required: fallbackRequired,
    fallback_selected: [...fallbackSelected].sort(),
    fallback_by_file: fallbackByFile,
    fallback_unavailable: fallbackUnavailable,
    dynamic_registration_detected: dynamicGraph,
  };
}

function readChanges(base, repositoryRoot = root) {
  const output = execFileSync("git", ["diff", "--name-status", "-z", base, "--"], { cwd: repositoryRoot, encoding: "utf8" });
  const tokens = output.split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (/^[RC]/.test(status)) {
      const oldFile = tokens[index++];
      changes.push({ status, file: tokens[index++], oldFile: oldFile || null });
    }
    else changes.push({ status, file: tokens[index++], oldFile: null });
  }
  return changes;
}

async function runChangedTests({ changes, base, cwd = root, suites = discoverSuites(cwd), runner = runSuites, options = {} } = {}) {
  const selection = selectChangedTests(changes || readChanges(base, cwd), suites, cwd, options);
  const report = { version: 4, base: base || null, ...selection };
  if (!selection.selected.length || selection.fallback_unavailable.length) {
    return { ...report, execution: { exitCode: 1, error: "No runnable conservative fallback suite is available.", results: [] }, exitCode: 1 };
  }
  const result = await runner({ requested: selection.selected, cwd, concurrency: options.concurrency || 4, ...options });
  const executed = new Set((result.results || []).filter(item => !["skipped", "cancelled"].includes(item.status)).map(item => item.suite));
  const fallbackNotRun = selection.fallback_selected.filter(file => !executed.has(file)).sort();
  const zeroTests = !result.results?.length || !Number.isInteger(result.passed) || result.passed < 1;
  const errors = [];
  if (fallbackNotRun.length) errors.push(`required fallback suites were not run: ${fallbackNotRun.join(", ")}`);
  if (zeroTests) errors.push("changed-test analysis completed with zero passing tests");
  const exitCode = errors.length || result.exitCode !== 0 ? 1 : 0;
  return { ...report, execution: { ...result, fallback_not_run: fallbackNotRun, zero_tests: zeroTests, errors }, exitCode };
}

if (require.main === module) {
  let base;
  try {
    base = process.env.SIDEKICK_TEST_BASE || execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
    const suites = discoverSuites(root);
    const changes = readChanges(base, root);
    runChangedTests({ base, cwd: root, suites, changes }).then(report => {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.exitCode;
    }).catch(error => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  FALLBACK_SUITES,
  buildDependencyGraph,
  classifyPath,
  dependencyClosure,
  hasDynamicRegistration,
  importSpecifiers,
  normalize,
  readChanges,
  resolveImport,
  runChangedTests,
  selectChangedTests,
};
