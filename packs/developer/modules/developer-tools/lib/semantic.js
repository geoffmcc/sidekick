"use strict";

/*
 * Semantic Repository Intelligence
 *
 * This module is deliberately static.  It reads bounded source bytes, applies
 * language-specific lexical parsers, and normalizes their useful results into
 * a versioned IR.  It never loads, imports, builds, or executes repository
 * code.  Repository text is data and is never returned as instructions.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ignore = require("ignore");
const ast = require("./ast");

const IR_VERSION = "sidekick.semantic-ir.v1";
const ANALYZER_VERSION = "sidekick.semantic-analyzer.v2-ast";
const DEFAULT_LIMITS = Object.freeze({ maxFiles: 4000, maxBytes: 64 * 1024 * 1024, maxFileBytes: 512 * 1024, maxUnits: 30000, maxEntries: 20000, maxAstNodes: 50000, maxResultChars: 18000 });
const EXTENSIONS = Object.freeze({
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".rb": "ruby", ".java": "java", ".go": "go", ".pl": "perl", ".pm": "perl", ".t": "perl",
  ".rs": "rust",
});
const SKIP = new Set([".git", "node_modules", "vendor", "target", "dist", "build", "out", "coverage", ".cache", ".next", ".gradle", ".venv", "venv", "__pycache__", "generated"]);

function sha256(domain, value) { const h = crypto.createHash("sha256").update(domain + "\0"); return h.update(Buffer.isBuffer(value) ? value : String(value)).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}
function clean(value, max = 160) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function loc(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  return { line: before.split("\n").length, column: before.length - before.lastIndexOf("\n") };
}
function evidence(file, sourceHash, text, offset) { return { path: file, source_hash: sourceHash, ...loc(text, offset) }; }
function addUnique(list, item, key = stable) { if (!list.some(x => key(x) === key(item))) list.push(item); }
function parameterNames(raw) { return clean(raw, 500).split(",").map(part => part.trim().replace(/^\.\.\./, "").split(/[=:]/, 1)[0].replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 64); }
function semanticIdentity(unit) { return sha256("sidekick.semantic.unit.v1", stable({ language: unit.language, modules: unit.modules, imports: unit.imports.map(x => x.name || x.text), exports: unit.exports.map(x => x.name || x.text), symbols: unit.symbols.map(x => ({ name: x.name, kind: x.kind, parameters: x.parameters, parent: x.parent })), relationships: unit.relationships.map(x => ({ kind: x.kind, from: x.from, to: x.to, certainty: x.certainty })), signals: unit.signals.map(x => x.kind) })); }
function semanticChanges(previousFiles = [], currentFiles = []) {
  const oldByPath = new Map(previousFiles.map(x => [x.path, x.unit])); const newByPath = new Map(currentFiles.map(x => [x.path, x.unit])); const changes = [];
  const names = unit => new Set((unit?.symbols || []).map(x => `${x.kind}:${x.name}`));
  for (const file of [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort()) {
    const before = oldByPath.get(file); const after = newByPath.get(file);
    if (!before) { changes.push({ path: file, kind: "added", symbols_added: [...names(after)].sort() }); continue; }
    if (!after) { changes.push({ path: file, kind: "removed", symbols_removed: [...names(before)].sort() }); continue; }
    if (before.semantic_hash === after.semantic_hash) continue;
    const oldNames = names(before); const newNames = names(after);
    changes.push({ path: file, kind: "changed", semantic_identity_before: before.semantic_hash, semantic_identity_after: after.semantic_hash, symbols_added: [...newNames].filter(x => !oldNames.has(x)).sort(), symbols_removed: [...oldNames].filter(x => !newNames.has(x)).sort(), relationships_changed: stable(before.relationships || []) !== stable(after.relationships || []) });
  }
  return changes;
}
function ignoreMatcher(root) { const matcher = ignore(); try { matcher.add(fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).filter(Boolean)); } catch {} return matcher; }

function discover(root, limits) {
  const files = []; const skipped = []; let bytes = 0; let truncated = false;
  const matcher = ignoreMatcher(root);
  function visit(dir, depth) {
    if (depth > 32 || truncated) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.length > limits.maxEntries) { skipped.push({ code: "entry_limit", path: path.relative(root, dir).split(path.sep).join("/"), limit: limits.maxEntries }); entries = entries.slice(0, limits.maxEntries); }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === "." || entry.name === ".." || SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relativeEntry = path.relative(root, full).split(path.sep).join("/");
      if (matcher.ignores(relativeEntry) || matcher.ignores(`${relativeEntry}/`)) continue;
      // lstat + no symlink following prevents escapes and loops.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { visit(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const language = EXTENSIONS[path.extname(entry.name).toLowerCase()];
      if (!language) continue;
      let stat; try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > limits.maxFileBytes) { skipped.push({ code: "file_size_limit", path: path.relative(root, full).split(path.sep).join("/"), limit: limits.maxFileBytes }); continue; }
      if (bytes + stat.size > limits.maxBytes) { skipped.push({ code: "repository_bytes_limit", path: path.relative(root, full).split(path.sep).join("/"), limit: limits.maxBytes }); truncated = true; continue; }
      const relative = path.relative(root, full).split(path.sep).join("/");
      files.push({ path: relative, language, size: stat.size }); bytes += stat.size;
      if (files.length >= limits.maxFiles) truncated = true;
    }
  }
  visit(root, 0); files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { files, bytes, truncated, skipped };
}

function regexMatches(text, re, fn) { let m; while ((m = re.exec(text))) fn(m); }
function parseSource(language, file, text, sourceHash) {
  const out = { modules: [], imports: [], exports: [], symbols: [], relationships: [], signals: [], tests: [], entry_points: [], warnings: [] };
  const addSymbol = (name, kind, m, extra = {}) => {
    if (!name || out.symbols.length >= 10000) return;
    const symbol = { name: clean(name, 200), kind, ...extra, evidence: evidence(file, sourceHash, text, m.index) };
    addUnique(out.symbols, symbol, x => `${x.name}:${x.kind}:${x.evidence.line}`);
    if (/test|spec/i.test(file) || /^(test|spec|describe|it|beforeEach)$/.test(name)) addUnique(out.tests, { name: symbol.name, kind: symbol.kind, evidence: symbol.evidence }, x => stable(x));
    return symbol;
  };
  const addImport = (name, m, extra = {}) => addUnique(out.imports, { name: clean(name, 240), ...extra, evidence: evidence(file, sourceHash, text, m.index) }, x => x.name);
  const addModule = (name, m, kind = "module") => addUnique(out.modules, { name: clean(name, 240), kind, evidence: evidence(file, sourceHash, text, m.index) }, x => x.name);

  const importPatterns = {
    javascript: [/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g],
    typescript: [/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g],
    ruby: [/^\s*(?:require|require_relative)\s+["']([^"']+)["']/gm],
    java: [/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm],
    go: [/\bimport\s+\(?\s*(?:[\w.]+\s+)?["']([^"']+)["']/g],
    perl: [/^\s*(?:use|require)\s+([\w:]+|["'][^"']+["'])/gm],
    rust: [/\buse\s+([\w:]+)|\bextern\s+crate\s+([\w]+)/g],
  };
  for (const re of importPatterns[language] || []) regexMatches(text, re, m => addImport(m[1] || m[2], m));

  const modulePatterns = {
    javascript: [/\b(?:class|namespace)\s+([A-Za-z_$][\w$]*)/g], typescript: [/\b(?:class|namespace|module)\s+([A-Za-z_$][\w$]*)/g],
    ruby: [/^\s*module\s+([\w:]+)/gm, /^\s*class\s+([\w:]+)/gm], java: [/\bpackage\s+([\w.]+)\s*;/g, /\b(?:class|interface|enum|record)\s+(\w+)/g],
    go: [/\bpackage\s+(\w+)/g], perl: [/\bpackage\s+([\w:]+)/g], rust: [/\bmod\s+(\w+)/g],
  };
  for (const re of modulePatterns[language] || []) regexMatches(text, re, m => addModule(m[1], m, language === "java" && m[0].startsWith("package") ? "package" : "module"));

  const fn = language === "ruby" ? /\bdef\s+([\w!?=]+)/g : language === "java" ? /\b(?:public|private|protected|static|final|synchronized|native|abstract|\s)+[\w<>\[\], ?]+\s+(\w+)\s*\(([^)]*)\)/g : language === "go" ? /\bfunc\s+(?:\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)/g : language === "rust" ? /\bfn\s+(\w+)\s*\(([^)]*)\)/g : /\b(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)|\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  regexMatches(text, fn, m => addSymbol(m[1] || m[3], "function", m, { parameters: parameterNames(m[2] || m[4] || ""), visibility: /\b(?:public|export)\b/.test(m[0]) ? "public" : "unknown" }));
  const type = /\b(?:export\s+)?(?:abstract\s+)?(class|interface|trait|struct|enum|record)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^\{]+))?/g;
  regexMatches(text, type, m => { const s = addSymbol(m[2], m[1], m, { visibility: /\bexport\b/.test(m[0]) ? "public" : "unknown" }); if (s && m[3]) out.relationships.push({ kind: "inherits", from: s.name, to: clean(m[3]), certainty: "parsed", evidence: s.evidence }); if (s && m[4]) for (const to of m[4].split(",")) out.relationships.push({ kind: "implements", from: s.name, to: clean(to), certainty: "parsed", evidence: s.evidence }); });
  const exported = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
  regexMatches(text, exported, m => addUnique(out.exports, { name: m[1], evidence: evidence(file, sourceHash, text, m.index) }, x => x.name));
  if (/\b(?:main|__main__|if\s+require\.main|func\s+main|fn\s+main)\b/.test(text) || /(^|\/)(server|app|main|index|cli)\.[^.]+$/i.test(file)) out.entry_points.push(evidence(file, sourceHash, text, Math.max(0, text.search(/\b(?:main|__main__)\b/))));
  const signals = [
    ["process_execution", /\b(?:child_process|exec|spawn|system|popen|shell_exec|Command::new|Runtime\.getRuntime)\b/i],
    ["filesystem_access", /\b(?:fs\.(?:read|write|rm|mkdir)|File\.(?:open|write)|os\.ReadFile|open\(|Pathname)\b/i],
    ["network_boundary", /\b(?:fetch|axios|http\.request|https?\.|Net::HTTP|Faraday|reqwest|TcpListener|net\/http)\b/i],
    ["database_boundary", /\b(?:SELECT\s+|INSERT\s+INTO|UPDATE\s+\w+\s+SET|sqlite|postgres|mysql|ActiveRecord|JDBC|database\/sql)\b/i],
    ["environment_access", /\b(?:process\.env|ENV\[|System\.getenv|os\.Getenv|std::env)\b/i],
    ["dynamic_code", /\b(?:eval|Function\s*\(|load\s*\(|require\s*\([^)]*\+|import\s*\([^)]*\+)\b/i],
    ["serialization_boundary", /\b(?:JSON\.(?:parse|stringify)|Marshal\.|ObjectInputStream|serde_json|yaml\.load|deserialize)\b/i],
    ["crypto_security_api", /\b(?:crypto|OpenSSL|BCrypt|bcrypt|Cipher|sha256|AES|HMAC|ring::)\b/i],
  ];
  for (const [kind, re] of signals) { const at = text.search(re); if (at >= 0) out.signals.push({ kind, certainty: "heuristic", evidence: evidence(file, sourceHash, text, at) }); }
  if (/\b(?:describe|it|test|RSpec|JUnit|Test::More|#\[test\])\b/.test(text) || /(^|\/)(test|tests|spec|__tests__)\//i.test(file)) out.tests.push({ name: path.basename(file), kind: "test_file", evidence: evidence(file, sourceHash, text, 0) });
  out.semantic_hash = sha256("sidekick.semantic.unit.v1", stable({ language, modules: out.modules, imports: out.imports.map(x => x.name), exports: out.exports.map(x => x.name), symbols: out.symbols.map(x => ({ name: x.name, kind: x.kind, parameters: x.parameters })), relationships: out.relationships, signals: out.signals.map(x => x.kind) }));
  return out;
}

const memoryCache = new Map();
const MAX_MEMORY_CACHE_ENTRIES = 8;
function cacheFile(root) { return path.join(os.tmpdir(), "sidekick-semantic-cache", sha256("sidekick.semantic.cache.v1", path.resolve(root)) + ".json"); }
function readCache(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function pruneDiskCache(directory, keepFile) {
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => {
        const file = path.join(directory, entry.name);
        try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(32)) {
      if (entry.file !== keepFile) { try { fs.unlinkSync(entry.file); } catch { /* advisory cache */ } }
    }
  } catch { /* cache cleanup is non-fatal */ }
}
function writeCache(file, value) {
  try {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
    pruneDiskCache(directory, file);
  } catch { /* cache failure is non-fatal */ }
}

async function indexRepository(root, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const found = discover(root, limits); let previous = memoryCache.get(root) || readCache(cacheFile(root));
  const warnings = [...found.skipped];
  if (previous && !verify(previous)) { previous = null; warnings.push({ code: "cache_integrity_failed", message: "Cached semantic data was not reused; rebuilding." }); }
  const files = []; let cacheHits = 0; let parsed = 0; let units = 0;
  for (const item of found.files) {
    const full = path.join(root, item.path); let buf; let fd = null;
    try { fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.size > limits.maxFileBytes) { warnings.push({ code: "file_size_limit", path: item.path, limit: limits.maxFileBytes }); fs.closeSync(fd); continue; } buf = fs.readFileSync(fd); fs.closeSync(fd); } catch { if (fd !== null) try { fs.closeSync(fd); } catch {} warnings.push({ code: "unavailable", path: item.path }); continue; }
    if (buf.includes(0)) { warnings.push({ code: "binary_skipped", path: item.path }); continue; }
    const sourceHash = sha256("sidekick.semantic.source.v1", buf);
    const old = previous?.files?.find(x => x.path === item.path && x.source_hash === sourceHash && x.analyzer_version === ANALYZER_VERSION && x.ir_version === IR_VERSION);
    let unit;
    if (old) { unit = old.unit; cacheHits++; } else {
      let text; try { text = buf.toString("utf8"); } catch { warnings.push({ code: "encoding_failed", path: item.path }); continue; }
      try {
        unit = parseSource(item.language, item.path, text, sourceHash);
        try {
          const tree = await ast.parse(item.language, text, { maxNodes: limits.maxAstNodes });
          unit.parser = tree.parser; unit.parser_version = tree.parser_version; unit.parse_errors = tree.parse_errors; unit.ast_root = tree.root_type; unit.ast_nodes = tree.visited_nodes;
          for (const symbol of tree.symbols) addUnique(unit.symbols, { name: clean(symbol.name, 200), kind: symbol.kind, parent: symbol.parent || null, certainty: "parsed", evidence: evidence(item.path, sourceHash, text, symbol.start_byte) }, x => `${x.name}:${x.kind}:${x.evidence.line}`);
          for (const relation of tree.relationships) addUnique(unit.relationships, { kind: relation.kind, from: relation.from, to: relation.to, certainty: relation.certainty, evidence: evidence(item.path, sourceHash, text, relation.start_byte) }, x => `${x.kind}:${x.from}:${x.to}:${x.evidence.line}`);
          for (const entry of tree.imports) addUnique(unit.imports, { name: clean(entry.text, 240), certainty: "parsed", evidence: evidence(item.path, sourceHash, text, entry.start_byte) }, x => x.name);
          for (const entry of tree.exports) addUnique(unit.exports, { name: clean(entry.text, 240), certainty: "parsed", evidence: evidence(item.path, sourceHash, text, entry.start_byte) }, x => x.name);
        } catch (error) { unit.parser = "lexical-fallback"; unit.parser_error = clean(error.message, 240); warnings.push({ code: "parser_unavailable", path: item.path, language: item.language }); }
        unit.semantic_hash = semanticIdentity({ ...unit, language: item.language }); parsed++;
      } catch { warnings.push({ code: "parser_failed", path: item.path, language: item.language }); continue; }
    }
    unit.path = item.path; unit.language = item.language; unit.source_hash = sourceHash; unit.analyzer_version = ANALYZER_VERSION; unit.ir_version = IR_VERSION; files.push({ path: item.path, language: item.language, source_hash: sourceHash, analyzer_version: ANALYZER_VERSION, ir_version: IR_VERSION, unit }); units += unit.symbols.length;
    if (units >= limits.maxUnits) { warnings.push({ code: "semantic_units_limit", limit: limits.maxUnits }); break; }
  }
  const knownPaths = new Set(files.map(x => x.path));
  for (const file of files) {
    for (const imported of file.unit.imports || []) {
      const name = String(imported.name || imported.text || "");
      if (!name.startsWith(".")) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), name));
      const target = [base, ...[".ts", ".tsx", ".js", ".jsx", ".rb", ".java", ".go", ".pl", ".pm", ".rs"].map(ext => `${base}${ext}`), `${base}/index.ts`, `${base}/index.js`].find(candidate => knownPaths.has(candidate));
      if (target) addUnique(file.unit.relationships, { kind: "imports", from: file.path, to: target, certainty: "inferred", evidence: imported.evidence }, x => `${x.kind}:${x.from}:${x.to}`);
    }
    file.unit.semantic_hash = semanticIdentity({ ...file.unit, language: file.language });
  }
  const aggregate = { ir_version: IR_VERSION, analyzer_version: ANALYZER_VERSION, files: files.map(x => ({ path: x.path, language: x.language, source_hash: x.source_hash, analyzer_version: x.analyzer_version, ir_version: x.ir_version, unit: x.unit })) };
  const indexRootHash = sha256("sidekick.semantic.index.v1", stable(aggregate));
  if (found.truncated) warnings.push({ code: "discovery_truncated", limit: limits.maxFiles });
  const result = { ok: true, schema: IR_VERSION, analyzer_version: ANALYZER_VERSION, repository: { name: path.basename(root), path: root }, files, changes: semanticChanges(previous?.files || [], files), stats: { discovered: found.files.length, parsed, cache_hits: cacheHits, skipped: found.files.length - files.length, bytes: found.bytes, symbols: units, truncated: found.truncated }, warnings, index_root_hash: indexRootHash, generated_from_source: true };
  memoryCache.delete(root); memoryCache.set(root, result); while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) memoryCache.delete(memoryCache.keys().next().value); writeCache(cacheFile(root), result); return result;
}

function project(index, { query = "", level = 0, max_chars = 12000, limit = 40 } = {}) {
  const q = clean(query, 500).toLowerCase(); const tokens = q.split(/[^a-z0-9_:$.-]+/).filter(x => x.length > 1);
  const all = index.files.flatMap(f => f.unit.symbols.map(s => ({ ...s, path: f.path, language: f.language, source_hash: f.source_hash }))); const score = item => tokens.reduce((n, t) => n + (String(item.name).toLowerCase().includes(t) || String(item.kind).toLowerCase().includes(t) || item.path.toLowerCase().includes(t) ? 1 : 0), 0);
  const symbols = all.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name)).slice(0, Math.min(200, limit));
  const overview = { schema: index.schema, index_root_hash: index.index_root_hash, repository: index.repository, stats: index.stats, warnings: index.warnings.slice(0, 20), languages: [...new Set(index.files.map(x => x.language))].sort(), modules: index.files.flatMap(f => f.unit.modules.map(m => ({ ...m, path: f.path }))).slice(0, limit), entry_points: index.files.flatMap(f => f.unit.entry_points).slice(0, limit), signals: index.files.flatMap(f => f.unit.signals.map(s => ({ ...s, path: f.path }))).slice(0, limit), changes: (index.changes || []).slice(0, limit) };
  if (q || level > 0) {
    const projectedSymbols = symbols.map(s => level > 1 ? s : ({ name: s.name, kind: s.kind, path: s.path, language: s.language, evidence: s.evidence }));
    // Query relevance must survive the context bound. Put requested evidence
    // before broad repository decoration so truncation never returns a large
    // overview while silently dropping the answer to the query.
    Object.assign(overview, { symbols: projectedSymbols });
    const ordered = { schema: overview.schema, index_root_hash: overview.index_root_hash, repository: overview.repository, symbols: overview.symbols, languages: overview.languages, modules: overview.modules, entry_points: overview.entry_points, signals: overview.signals, changes: overview.changes, stats: overview.stats, warnings: overview.warnings };
    if (level > 1) ordered.relationships = index.files.flatMap(f => f.unit.relationships.map(r => ({ ...r, path: f.path }))).slice(0, limit);
    let orderedText = JSON.stringify(ordered, null, 2); if (orderedText.length > max_chars) orderedText = orderedText.slice(0, Math.max(0, max_chars - 40)) + "\n[semantic projection truncated]";
    return { ...ordered, projection: orderedText, projection_chars: orderedText.length, trust: "untrusted repository-derived data; evidence locations require governed source reads" };
  }
  if (level > 1) overview.relationships = index.files.flatMap(f => f.unit.relationships.map(r => ({ ...r, path: f.path }))).slice(0, limit);
  let text = JSON.stringify(overview, null, 2); if (text.length > max_chars) text = text.slice(0, Math.max(0, max_chars - 40)) + "\n[semantic projection truncated]";
  return { ...overview, projection: text, projection_chars: text.length, trust: "untrusted repository-derived data; evidence locations require governed source reads" };
}

function verify(index) {
  if (!index || !Array.isArray(index.files)) return false;
  const wrappersValid = index.files.every(x => x && x.unit && x.path === x.unit.path && x.language === x.unit.language && x.source_hash === x.unit.source_hash && x.analyzer_version === x.unit.analyzer_version && x.ir_version === x.unit.ir_version);
  if (!wrappersValid) return false;
  return sha256("sidekick.semantic.index.v1", stable({ ir_version: index.schema, analyzer_version: index.analyzer_version, files: index.files.map(x => ({ path: x.path, language: x.language, source_hash: x.source_hash, analyzer_version: x.analyzer_version, ir_version: x.ir_version, unit: x.unit })) })) === index.index_root_hash;
}
function clearMemory(root) { if (root) memoryCache.delete(root); else memoryCache.clear(); }
module.exports = { IR_VERSION, ANALYZER_VERSION, DEFAULT_LIMITS, discover, indexRepository, project, verify, stable, sha256, cacheFile, clearMemory };
