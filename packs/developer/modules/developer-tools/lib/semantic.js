"use strict";

/*
 * Semantic Repository Intelligence
 *
 * This module is deliberately static.  It reads bounded source bytes, applies
 * language-specific AST adapters plus conservative lexical signals, and normalizes their useful results into
 * a versioned IR.  It never loads, imports, builds, or executes repository
 * code.  Repository text is data and is never returned as instructions.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ignore = require("ignore");
const ast = require("./ast");

const IR_VERSION = "sidekick.semantic-ir.v2";
const ANALYZER_VERSION = "sidekick.semantic-analyzer.v3.9-semantic-flow";
const DEFAULT_LIMITS = Object.freeze({ maxFiles: 4000, maxBytes: 64 * 1024 * 1024, maxFileBytes: 512 * 1024, maxUnits: 30000, maxEntries: 20000, maxAstNodes: 50000, maxResultChars: 18000 });
const EXTENSIONS = Object.freeze({
  ".ts": "typescript", ".tsx": "typescript_tsx", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript_jsx", ".mjs": "javascript", ".cjs": "javascript",
  ".rb": "ruby", ".java": "java", ".go": "go", ".pl": "perl", ".pm": "perl", ".t": "perl",
  ".rs": "rust",
});
const SKIP = new Set([".git", "node_modules", "vendor", "target", "dist", "build", "out", "coverage", ".cache", ".next", ".gradle", ".venv", "venv", "__pycache__", "generated"]);
function languageForPath(file) { return EXTENSIONS[path.extname(String(file || "")).toLowerCase()] || null; }

function sha256(domain, value) { const h = crypto.createHash("sha256").update(domain + "\0"); return h.update(Buffer.isBuffer(value) ? value : String(value)).digest("hex"); }
// Canonicalization preserves array order by default. Callers explicitly use
// canonicalSet for IR fields whose semantics are set-like. This prevents
// positional parameters and ordered argument structures from collapsing into
// the same semantic identity.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}
function canonicalSet(values) { return [...(values || [])].map(value => stable(value)).sort().map(value => JSON.parse(value)); }
function clean(value, max = 160) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function decodeUtf8(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return null; }
}
function loc(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  return { line: before.split("\n").length, column: before.length - before.lastIndexOf("\n") };
}
// File-level source_hash is the integrity anchor. Evidence intentionally
// carries only a bounded location so repeated edges do not replicate a
// 64-byte digest throughout the model-facing IR.
function evidence(file, sourceHash, text, offset) { return { path: file, ...loc(text, offset) }; }
function addUnique(list, item, key = stable) { if (!list.some(x => key(x) === key(item))) list.push(item); }
function parameterNames(raw) { return clean(raw, 500).split(",").map(part => part.trim().replace(/^\.\.\./, "").split(/[=:]/, 1)[0].replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 64); }
function semanticIdentity(unit) { return sha256("sidekick.semantic.unit.v2", stable({ language: unit.language, modules: canonicalSet(unit.modules), imports: canonicalSet(unit.imports.map(x => x.name || x.text)), exports: canonicalSet(unit.exports.map(x => x.name || x.text)), symbols: unit.symbols.map(x => ({ name: x.name, kind: x.kind, parameters: x.parameters || [], parent: x.parent || null, execution_phase: x.execution_phase || "unknown", lifecycle_semantics: canonicalSet(unit.lifecycle_semantics?.filter(y => y.symbol === x.name).map(y => y.kind) || x.lifecycle_semantics || []), security_boundaries: canonicalSet((x.security_boundaries || []).map(y => ({ kind: y.kind, confidence: y.confidence }))), side_effects: x.side_effects || [] })), relationships: canonicalSet(unit.relationships.map(x => ({ kind: x.kind, from: x.from, to: x.to, certainty: x.certainty, phase: x.phase || null, boundary: x.boundary || null }))), control_flow: canonicalSet((unit.control_flow || []).map(x => ({ kind: x.kind, from: x.from || null, ast_node: x.provenance?.ast_node || null }))), state_transitions: canonicalSet((unit.state_transitions || []).map(x => ({ state: x.state, to: x.to }))), continuation_edges: canonicalSet((unit.continuation_edges || []).map(x => ({ kind: x.kind, from: x.from || null, to: x.to || null }))), lifecycle_semantics: canonicalSet((unit.lifecycle_semantics || []).map(x => ({ kind: x.kind, symbol: x.symbol || null }))), security_boundaries: canonicalSet((unit.security_boundaries || []).map(x => ({ kind: x.kind, confidence: x.confidence }))), execution_phase: unit.execution_phase || "unknown", dynamic_capabilities: canonicalSet((unit.dynamic_capabilities || []).map(x => ({ kind: x.kind, symbol: x.symbol || null }))), signals: canonicalSet(unit.signals.map(x => x.kind)) })); }
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
function configurationHash(root, limits, sourceFiles) {
  let ignoreBytes = "";
  if (!sourceFiles) { try { ignoreBytes = fs.readFileSync(path.join(root, ".gitignore")); } catch {} }
  return sha256("sidekick.semantic.config.v1", stable({ limits, gitignore: ignoreBytes.toString("base64") }));
}

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
const PHASE_WORDS = Object.freeze({ startup: /(?:^|[a-z])(?:startup|start|initialize|initialise|bootstrap|provision|restore|load|register|install)(?:\b|[A-Z_])/i, request: /(?:^|[a-z])(?:request|handler|dispatch|resolve|execute|invoke|call)(?:\b|[A-Z_])/i, continuation: /(?:^|[a-z])(?:resume|continuation|continue|claim|retry|requeue|worker|event|callback)(?:\b|[A-Z_])/i, shutdown: /(?:^|[a-z])(?:shutdown|stop|close|unload|dispose|teardown)(?:\b|[A-Z_])/i });
const LIFECYCLE_WORDS = Object.freeze(["provision", "verify", "load", "register", "resolve", "execute", "unload"]);
const SECURITY_WORDS = Object.freeze({ schema_validation: /\b(?:schema|parse|validate|validation|shape)(?:\b|[A-Z_])/i, authentication: /\b(?:authenticate|authentication|login|identity|credential|token)(?:\b|[A-Z_])/i, authorization: /\b(?:authorize|authorization|permission|entitlement|access)(?:\b|[A-Z_])/i, policy: /\b(?:policy|governance|guard|allowlist|denylist)(?:\b|[A-Z_])/i, approval: /\b(?:approval|approve|consent|human[_ -]?in[_ -]?the[_ -]?loop)(?:\b|[A-Z_])/i, integrity_verification: /\b(?:integrity|hash|digest|signature|verify)(?:\b|[A-Z_])/i, risk_validation: /\b(?:risk|dangerous|safety|capability)(?:\b|[A-Z_])/i, input_normalization: /\b(?:normalize|canonical|sanitize|redact)(?:\b|[A-Z_])/i, timeout: /\b(?:timeout|deadline|abort)(?:\b|[A-Z_])/i, cancellation: /\b(?:cancel|cancellation|abort|signal)(?:\b|[A-Z_])/i, audit: /\b(?:audit|telemetry|log(?:ging)?|trace)(?:\b|[A-Z_])/i, redaction: /\b(?:redact|redaction|mask|secret)(?:\b|[A-Z_])/i });
function semanticMetadata(text, tree, file, sourceHash) {
  const result = { execution_phase: "unknown", lifecycle_semantics: [], control_flow: [], state_transitions: [], continuation_edges: [], security_boundaries: [], dynamic_capabilities: [], side_effects: [] };
  const ev = offset => evidence(file, sourceHash, text, offset);
  const add = (list, item, key = stable) => addUnique(list, item, key);
  for (const marker of tree.control_flow || []) add(result.control_flow, { kind: marker.kind, from: marker.from || null, evidence: ev(marker.start_byte), provenance: { ast_node: marker.ast_node, rule: "tree-sitter-control-node" } }, x => `${x.kind}:${x.from}:${x.provenance.ast_node}`);
  const ranges = (tree.symbols || []).map(s => ({ ...s, body: text.slice(s.start_byte, Math.min(text.length, s.end_byte)) }));
  const classify = (name, body, offset) => {
    const lower = `${name} ${body}`;
    const phase = Object.entries(PHASE_WORDS).find(([, re]) => re.test(name));
    const lifecycle = LIFECYCLE_WORDS.filter(word => new RegExp(`\\b${word}(?:\\b|[A-Z_])`, "i").test(lower));
    const security = Object.entries(SECURITY_WORDS).filter(([, re]) => re.test(lower)).map(([kind]) => ({ kind, confidence: /authorize|approval|policy|schema|integrity|timeout|cancel|audit|redact/i.test(lower) ? "structural_name_and_context" : "name_only", evidence: ev(offset), provenance: { rule: "bounded-identifier-and-body-pattern", source: "symbol" } }));
    const sideEffects = [];
    if (/\b(?:write|insert|update|delete|save|persist|store|queue|park|claim|commit)\b/i.test(body)) sideEffects.push("durable_state");
    if (/\b(?:fetch|http|socket|request|send|publish)\b/i.test(body)) sideEffects.push("network");
    if (/\b(?:writeFile|readFile|open|mkdir|unlink|rename)\b/i.test(body)) sideEffects.push("filesystem");
    if (/\b(?:load|require|import)/i.test(body) && /(?:module|plugin|package|entry)/i.test(`${name} ${body}`)) add(result.dynamic_capabilities, { kind: "module_load", symbol: name, evidence: ev(offset), provenance: { rule: "module-load-structural-pattern" } });
    if (/\b(?:resolve|descriptor|capability|tool)/i.test(body) && /\b(?:dynamic|generated|persist|runtime|fallback)/i.test(body)) add(result.dynamic_capabilities, { kind: "generated_runtime_descriptor", symbol: name, evidence: ev(offset), provenance: { rule: "runtime-descriptor-structural-pattern" } });
    return { execution_phase: phase ? phase[0] : "unknown", lifecycle_semantics: lifecycle, security_boundaries: security, side_effects: [...new Set(sideEffects)] };
  };
  for (const symbol of ranges) {
    const metadata = classify(symbol.name, symbol.body, symbol.start_byte);
    symbol.semantic = metadata;
    for (const boundary of metadata.security_boundaries) add(result.security_boundaries, boundary, x => x.kind);
    for (const lifecycle of metadata.lifecycle_semantics) add(result.lifecycle_semantics, { kind: lifecycle, symbol: symbol.name, evidence: ev(symbol.start_byte), provenance: { rule: "lifecycle-identifier-and-body-pattern" } }, x => `${x.kind}:${x.symbol}`);
    if (metadata.execution_phase !== "unknown" && result.execution_phase === "unknown") result.execution_phase = metadata.execution_phase;
  }
  const assignments = /\b((?:[A-Za-z_$][\w$]*?(?:state|status|phase|lifecycle|approval|authorization|operation)|state|status|phase|lifecycle|approval|authorization|operation))\s*(?:=|:|=>)\s*["']?([A-Za-z_$][\w$ -]{1,64})["']?/gi;
  regexMatches(text, assignments, m => { const value = clean(m[2], 64).toLowerCase().replace(/\s+/g, "_"); if (!value || value.length > 48 || /bearer|token|secret|api[_-]?key|password|eyj|^[a-f0-9]{24,}$/.test(value) || /^return$|^function$/.test(value)) return; add(result.state_transitions, { state: clean(m[1], 120), to: value, evidence: ev(m.index), provenance: { rule: "state-assignment" } }, x => `${x.state}:${x.to}:${x.evidence.line}`); });
  for (const symbol of ranges) {
    const durable = /\b(?:persist|save|store|queue|park|enqueue|claim|resume|continue|retry|requeue)\w*\b/i.test(symbol.body);
    const asynchronous = /\b(?:await|Promise|callback|event|on[A-Z]\w*)\b/.test(symbol.body);
    if (durable && asynchronous) add(result.continuation_edges, { kind: "persisted_continuation", from: symbol.name, to: null, evidence: ev(symbol.start_byte), provenance: { rule: "durable-and-asynchronous-structural-pattern" } }, x => `${x.kind}:${x.from}`);
  }
  return result;
}
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
  out.semantic_hash = semanticIdentity({ ...out, language });
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
  const sourceFiles = Array.isArray(options.sourceFiles) ? options.sourceFiles : null;
  const configHash = configurationHash(root, limits, sourceFiles);
  const found = sourceFiles ? { files: sourceFiles.slice(0, limits.maxFiles).map(item => ({ path: item.path, language: item.language, size: Buffer.byteLength(String(item.content || "")), content: item.content })), bytes: sourceFiles.reduce((total, item) => total + Buffer.byteLength(String(item.content || "")), 0), truncated: sourceFiles.length > limits.maxFiles, skipped: [] } : discover(root, limits);
  let previous = sourceFiles ? null : (memoryCache.get(root) || readCache(cacheFile(root)));
  if (previous && previous.config_hash !== configHash) previous = null;
  const warnings = [...found.skipped];
  if (previous && !verify(previous)) { previous = null; warnings.push({ code: "cache_integrity_failed", message: "Cached semantic data was not reused; rebuilding." }); }
  const files = []; let cacheHits = 0; let parsed = 0; let units = 0;
  for (const item of found.files) {
    const full = path.join(root, item.path); let buf; let fd = null;
    if (sourceFiles) {
      buf = Buffer.isBuffer(item.content) ? item.content : Buffer.from(String(item.content || ""));
      if (buf.length > limits.maxFileBytes) { warnings.push({ code: "file_size_limit", path: item.path, limit: limits.maxFileBytes }); continue; }
    } else {
      try { fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.size > limits.maxFileBytes) { warnings.push({ code: "file_size_limit", path: item.path, limit: limits.maxFileBytes }); fs.closeSync(fd); continue; } buf = fs.readFileSync(fd); fs.closeSync(fd); } catch { if (fd !== null) try { fs.closeSync(fd); } catch {} warnings.push({ code: "unavailable", path: item.path }); continue; }
    }
    if (buf.includes(0)) { warnings.push({ code: "binary_skipped", path: item.path }); continue; }
    const sourceHash = sha256("sidekick.semantic.source.v1", buf);
    const old = previous?.files?.find(x => x.path === item.path && x.source_hash === sourceHash && x.analyzer_version === ANALYZER_VERSION && x.ir_version === IR_VERSION);
    let unit;
    if (old) { unit = old.unit; cacheHits++; } else {
      const text = decodeUtf8(buf); if (text === null) { warnings.push({ code: "encoding_failed", path: item.path }); continue; }
      try {
        unit = parseSource(item.language, item.path, text, sourceHash);
        try {
          const tree = await ast.parse(item.language, text, { maxNodes: limits.maxAstNodes });
          unit.parser = tree.parser; unit.parser_version = tree.parser_version; unit.parse_errors = tree.parse_errors; unit.ast_root = tree.root_type; unit.ast_nodes = tree.visited_nodes;
          for (const symbol of tree.symbols) addUnique(unit.symbols, { name: clean(symbol.name, 200), kind: symbol.kind, parent: symbol.parent || null, certainty: "parsed", evidence: evidence(item.path, sourceHash, text, symbol.start_byte) }, x => `${x.name}:${x.kind}:${x.evidence.line}`);
          for (const relation of tree.relationships) addUnique(unit.relationships, { kind: relation.kind, from: relation.from, to: relation.to, certainty: relation.certainty, evidence: evidence(item.path, sourceHash, text, relation.start_byte) }, x => x.kind === "calls" ? `${x.kind}:${x.from}:${x.to}` : `${x.kind}:${x.from}:${x.to}:${x.evidence.line}`);
          for (const flow of tree.control_flow || []) addUnique(unit.relationships, { kind: flow.kind, from: flow.from || null, to: null, certainty: "parsed", evidence: evidence(item.path, sourceHash, text, flow.start_byte), provenance: { ast_node: flow.ast_node, rule: "tree-sitter-control-node" } }, x => `${x.kind}:${x.from}:${x.provenance?.ast_node || ""}`);
          for (const entry of tree.imports) addUnique(unit.imports, { name: clean(entry.text, 240), certainty: "parsed", evidence: evidence(item.path, sourceHash, text, entry.start_byte) }, x => x.name);
          for (const entry of tree.exports) addUnique(unit.exports, { name: clean(entry.text, 240), certainty: "parsed", evidence: evidence(item.path, sourceHash, text, entry.start_byte) }, x => x.name);
          const metadata = semanticMetadata(text, tree, item.path, sourceHash);
          Object.assign(unit, metadata);
          for (const symbol of tree.symbols || []) {
            const target = unit.symbols.find(x => x.name === clean(symbol.name, 200) && x.evidence.line === symbol.start_line) || unit.symbols.find(x => x.name === clean(symbol.name, 200));
            if (!target) continue;
            const body = text.slice(symbol.start_byte, Math.min(text.length, symbol.end_byte));
            const phase = Object.entries(PHASE_WORDS).find(([, re]) => re.test(symbol.name));
            target.execution_phase = phase ? phase[0] : "unknown";
            target.lifecycle_semantics = LIFECYCLE_WORDS.filter(word => new RegExp(`\\b${word}(?:\\b|[A-Z_])`, "i").test(`${symbol.name} ${body}`));
            target.security_boundaries = Object.entries(SECURITY_WORDS).filter(([, re]) => re.test(`${symbol.name} ${body}`)).map(([kind]) => ({ kind, confidence: "structural_name_and_context", evidence: target.evidence, provenance: { rule: "bounded-identifier-and-body-pattern", source: "symbol" } }));
            target.side_effects = /\b(?:write|insert|update|delete|save|persist|store|queue|park|claim|commit)\b/i.test(body) ? ["durable_state"] : [];
          }
          // Keep the symbol contract total even when a grammar's byte range
          // differs from the lexical adapter's range. Unknown is explicit;
          // missing metadata must not be mistaken for an inferred phase.
          for (const target of unit.symbols) {
            if (target.execution_phase === undefined) {
              const phase = Object.entries(PHASE_WORDS).find(([, re]) => re.test(target.name));
              target.execution_phase = phase ? phase[0] : "unknown";
            }
            if (target.lifecycle_semantics === undefined) target.lifecycle_semantics = LIFECYCLE_WORDS.filter(word => new RegExp(`\\b${word}(?:\\b|[A-Z_])`, "i").test(target.name));
            if (target.security_boundaries === undefined) target.security_boundaries = Object.entries(SECURITY_WORDS).filter(([, re]) => re.test(target.name)).map(([kind]) => ({ kind, confidence: "name_only", evidence: target.evidence, provenance: { rule: "bounded-identifier-pattern", source: "symbol" } }));
            if (target.side_effects === undefined) target.side_effects = [];
          }
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
    const protectedNames = new Map((file.unit.symbols || []).filter(s => (s.security_boundaries || []).some(b => ["authorization", "approval", "policy"].includes(b.kind))).map(s => [s.name, new Set(s.security_boundaries.map(b => b.kind))]));
    for (const relation of [...(file.unit.relationships || [])]) if (relation.kind === "calls" && protectedNames.has(relation.from) && /(?:dispatch|execute|invoke|handler|perform|call)/i.test(String(relation.to || ""))) {
      const boundary = [...protectedNames.get(relation.from)].sort()[0];
      addUnique(file.unit.relationships, { kind: "authorization", from: relation.from, to: relation.to, boundary, certainty: "derived", evidence: relation.evidence, provenance: { rule: "governance-symbol-before-execution-call" } }, x => `${x.kind}:${x.from}:${x.to}:${x.boundary}`);
    }
    file.unit.semantic_hash = semanticIdentity({ ...file.unit, language: file.language });
  }
  // A convergence marker is emitted only when independently observed call
  // edges reach the same symbol. It is a relationship, not a guessed route.
  const incoming = new Map();
  for (const file of files) for (const relation of file.unit.relationships || []) if (relation.kind === "calls" && relation.to) {
    const key = String(relation.to); if (!incoming.has(key)) incoming.set(key, []); incoming.get(key).push({ file, relation });
  }
  for (const [to, edges] of incoming) if (new Set(edges.map(x => x.relation.from)).size > 1) {
    const evidenceItem = edges.slice().sort((a, b) => a.file.path.localeCompare(b.file.path) || a.relation.evidence.line - b.relation.evidence.line)[0];
    addUnique(evidenceItem.file.unit.relationships, { kind: "convergence", from: null, to, certainty: "derived", evidence: evidenceItem.relation.evidence, provenance: { rule: "multiple-observed-callers" } }, x => `${x.kind}:${x.to}`);
    evidenceItem.file.unit.semantic_hash = semanticIdentity({ ...evidenceItem.file.unit, language: evidenceItem.file.language });
  }
  const aggregate = { ir_version: IR_VERSION, analyzer_version: ANALYZER_VERSION, config_hash: configHash, files: files.map(x => ({ path: x.path, language: x.language, source_hash: x.source_hash, analyzer_version: x.analyzer_version, ir_version: x.ir_version, unit: x.unit })) };
  const indexRootHash = sha256("sidekick.semantic.index.v2", stable(aggregate));
  if (found.truncated) warnings.push({ code: "discovery_truncated", limit: limits.maxFiles });
  const result = { ok: true, schema: IR_VERSION, analyzer_version: ANALYZER_VERSION, config_hash: configHash, repository: { name: path.basename(root), path: root, state: options.state || { kind: "working_tree" } }, files, changes: semanticChanges(previous?.files || [], files), stats: { discovered: found.files.length, parsed, cache_hits: cacheHits, skipped: found.files.length - files.length, bytes: found.bytes, symbols: units, relationships: files.reduce((n, f) => n + (f.unit.relationships || []).length, 0), semantic_bytes: 0, truncated: found.truncated }, warnings, index_root_hash: indexRootHash, generated_from_source: true };
  result.stats.semantic_bytes = Buffer.byteLength(stable(result), "utf8");
  if (!sourceFiles) { memoryCache.delete(root); memoryCache.set(root, result); while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) memoryCache.delete(memoryCache.keys().next().value); writeCache(cacheFile(root), result); }
  return result;
}

function compareIndexes(before, after, states = {}) {
  return { before: states.before || before?.repository?.state || null, after: states.after || after?.repository?.state || null, changes: semanticChanges(before?.files || [], after?.files || []) };
}

function project(index, { query = "", level = 0, max_chars = 12000, limit = 40 } = {}) {
  const q = clean(query, 500).toLowerCase(); const tokens = q.split(/[^a-z0-9_:$.-]+/).filter(x => x.length > 1);
  const relationMode = /\b(?:callee|callees|what does .* call|dependencies|imports?|depends?)\b/.test(q) ? "outgoing" : /\b(?:caller|callers|who calls|calls|references|dependents?)\b/.test(q) ? "incoming" : null;
  const all = index.files.flatMap(f => f.unit.symbols.map(s => ({ ...s, path: f.path, language: f.language, source_hash: f.source_hash })));
  const score = item => tokens.reduce((n, t) => n + (String(item.name).toLowerCase().includes(t) || String(item.kind).toLowerCase().includes(t) || item.path.toLowerCase().includes(t) ? 1 : 0), 0);
  const relationWords = new Set(["what", "does", "do", "call", "calls", "caller", "callers", "callee", "callees", "who", "references", "depend", "depends", "dependency", "dependencies", "import", "imports", "module", "modules"]);
  const targetTokens = tokens.filter(token => !relationWords.has(token));
  const targetNames = new Set(all.filter(item => targetTokens.some(t => String(item.name).toLowerCase().includes(t))).map(item => item.name));
  const allRelationships = index.files.flatMap(f => f.unit.relationships.map(r => ({ ...r, path: f.path })));
  const relevantRelationships = allRelationships.filter(relation => {
    if (!relationMode) return false;
    const endpoint = relationMode === "incoming" ? relation.to : relation.from;
    return targetNames.has(endpoint) || targetTokens.some(token => String(endpoint || "").toLowerCase().includes(token));
  });
  const relatedNames = new Set(relevantRelationships.flatMap(relation => [relation.from, relation.to]));
  const symbols = all
    .sort((a, b) => (relatedNames.has(b.name) ? 1 : 0) - (relatedNames.has(a.name) ? 1 : 0) || score(b) - score(a) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
    .slice(0, Math.min(200, Math.max(limit, relevantRelationships.length + 1)));
  const overview = { schema: index.schema, index_root_hash: index.index_root_hash, repository: index.repository, stats: index.stats, warnings: index.warnings.slice(0, 20), languages: [...new Set(index.files.map(x => x.language))].sort(), modules: index.files.flatMap(f => f.unit.modules.map(m => ({ ...m, path: f.path }))).slice(0, limit), entry_points: index.files.flatMap(f => f.unit.entry_points).slice(0, limit), signals: index.files.flatMap(f => f.unit.signals.map(s => ({ ...s, path: f.path }))).slice(0, limit), lifecycle: index.files.flatMap(f => (f.unit.lifecycle_semantics || []).map(s => ({ ...s, path: f.path }))).slice(0, limit), security_boundaries: index.files.flatMap(f => (f.unit.security_boundaries || []).map(s => ({ ...s, path: f.path }))).slice(0, limit), state_transitions: index.files.flatMap(f => (f.unit.state_transitions || []).map(s => ({ ...s, path: f.path }))).slice(0, limit), continuation_edges: index.files.flatMap(f => (f.unit.continuation_edges || []).map(s => ({ ...s, path: f.path }))).slice(0, limit), dynamic_capabilities: index.files.flatMap(f => (f.unit.dynamic_capabilities || []).map(s => ({ ...s, path: f.path }))).slice(0, limit), changes: (index.changes || []).slice(0, limit) };
  if (q || level > 0) {
    const projectedSymbols = symbols.map(s => level > 1 ? s : ({ name: s.name, kind: s.kind, path: s.path, language: s.language, evidence: s.evidence }));
    // Query relevance must survive the context bound. Put requested evidence
    // before broad repository decoration so truncation never returns a large
    // overview while silently dropping the answer to the query.
    Object.assign(overview, { symbols: projectedSymbols });
    const ordered = { schema: overview.schema, index_root_hash: overview.index_root_hash, repository: overview.repository, symbols: overview.symbols, languages: overview.languages, modules: overview.modules, entry_points: overview.entry_points, lifecycle: overview.lifecycle, security_boundaries: overview.security_boundaries, state_transitions: overview.state_transitions, continuation_edges: overview.continuation_edges, dynamic_capabilities: overview.dynamic_capabilities, signals: overview.signals, changes: overview.changes, stats: overview.stats, warnings: overview.warnings };
    if (level > 1 || relationMode) ordered.relationships = (relationMode ? relevantRelationships : allRelationships).slice(0, limit);
    let orderedText = JSON.stringify(ordered, null, 2); if (orderedText.length > max_chars) orderedText = orderedText.slice(0, Math.max(0, max_chars - 40)) + "\n[semantic projection truncated]";
    return { ...ordered, projection: orderedText, projection_chars: orderedText.length, trust: "untrusted repository-derived data; evidence locations require governed source reads" };
  }
  if (level > 1) overview.relationships = allRelationships.slice(0, limit);
  let text = JSON.stringify(overview, null, 2); if (text.length > max_chars) text = text.slice(0, Math.max(0, max_chars - 40)) + "\n[semantic projection truncated]";
  return { ...overview, projection: text, projection_chars: text.length, trust: "untrusted repository-derived data; evidence locations require governed source reads" };
}

function verify(index) {
  if (!index || !Array.isArray(index.files)) return false;
  const wrappersValid = index.files.every(x => x && x.unit && x.path === x.unit.path && x.language === x.unit.language && x.source_hash === x.unit.source_hash && x.analyzer_version === x.unit.analyzer_version && x.ir_version === x.unit.ir_version);
  if (!wrappersValid) return false;
  return sha256("sidekick.semantic.index.v2", stable({ ir_version: index.schema, analyzer_version: index.analyzer_version, config_hash: index.config_hash, files: index.files.map(x => ({ path: x.path, language: x.language, source_hash: x.source_hash, analyzer_version: x.analyzer_version, ir_version: x.ir_version, unit: x.unit })) })) === index.index_root_hash;
}
function clearMemory(root) { if (root) memoryCache.delete(root); else memoryCache.clear(); }
module.exports = { IR_VERSION, ANALYZER_VERSION, DEFAULT_LIMITS, languageForPath, discover, indexRepository, compareIndexes, project, verify, stable, sha256, cacheFile, clearMemory };
