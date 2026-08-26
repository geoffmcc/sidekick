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

const IR_VERSION = "sidekick.semantic-ir.v4";
const ANALYZER_VERSION = "sidekick.semantic-analyzer.v5.0-bounded-provenance-perl";
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 4000, maxBytes: 64 * 1024 * 1024, maxFileBytes: 512 * 1024,
  maxUnits: 30000, maxEntries: 20000, maxAstNodes: 50000,
  maxResultChars: 18000, maxResultItems: 40, maxMatchesPerFile: 80,
  maxFilesRepresented: 40, maxRelationships: 10000, maxTraversalDepth: 32,
  maxSnippets: 80, maxSnippetChars: 280, maxWorkItems: 20000,
});
const CURSOR_VERSION = 1;
const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_SECRET = process.env.SIDEKICK_SEMANTIC_CURSOR_SECRET || crypto.randomBytes(32);
const EXTENSIONS = Object.freeze({
  ".ts": "typescript", ".tsx": "typescript_tsx", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript_jsx", ".mjs": "javascript", ".cjs": "javascript",
  ".rb": "ruby", ".java": "java", ".go": "go", ".pl": "perl", ".pm": "perl", ".t": "perl",
  ".rs": "rust",
});
const SKIP = new Set([".git", "node_modules", "vendor", "third_party", "bundles", "target", "dist", "build", "out", "coverage", ".cache", ".next", ".gradle", ".venv", "venv", "__pycache__", "generated"]);
const INCOMPLETE_WARNING_CODES = new Set(["discovery_truncated", "entry_limit", "repository_bytes_limit", "file_size_limit", "unavailable", "binary_skipped", "encoding_failed", "parse_incomplete", "parser_unavailable", "parser_failed", "semantic_units_limit", "ast_nodes_limit", "cache_integrity_failed"]);
function languageForPath(file) { return EXTENSIONS[path.extname(String(file || "")).toLowerCase()] || null; }

function normalizeFilters(filters = {}) {
  const normalize = values => (Array.isArray(values) ? values : [])
    .slice(0, 64)
    .map(value => String(value || "").replace(/\\/g, "/").trim())
    .filter(value => value && value.length <= 200 && !value.startsWith("/") && !value.split("/").includes("..") && !/[\u0000-\u001f\u007f]/.test(value));
  return { include: [...new Set(normalize(filters.include))].sort(), exclude: [...new Set(normalize(filters.exclude))].sort() };
}

function globRegex(pattern) {
  let output = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index++;
      if (pattern[index + 1] === "/") { index++; output += "(?:.*/)?"; }
      else output += ".*";
    } else if (char === "*") output += "[^/]*";
    else if (char === "?") output += "[^/]";
    else output += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${output}$`);
}

function matchesFilters(relativePath, filters = {}) {
  const normalized = normalizeFilters(filters);
  if (normalized.exclude.some(pattern => globRegex(pattern).test(relativePath))) return false;
  return !normalized.include.length || normalized.include.some(pattern => globRegex(pattern).test(relativePath));
}

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
function evidence(file, sourceHash, text, offset, endOffset = offset) {
  const start = Math.max(0, Number(offset) || 0); const end = Math.max(start, Number(endOffset) || start);
  return { path: file, source_hash: sourceHash || null, line: loc(text, start).line, column: loc(text, start).column, byte_start: Buffer.byteLength(String(text || "").slice(0, start), "utf8"), byte_end: Buffer.byteLength(String(text || "").slice(0, end), "utf8") };
}
function charOffsetAtByte(text, byteOffset) { const buffer = Buffer.from(String(text || ""), "utf8"); return buffer.subarray(0, Math.max(0, Math.min(buffer.length, Number(byteOffset) || 0))).toString("utf8").length; }
function evidenceBytes(file, sourceHash, text, byteOffset, byteEnd = byteOffset) { return evidence(file, sourceHash, text, charOffsetAtByte(text, byteOffset), charOffsetAtByte(text, byteEnd)); }
function boundedNumber(value, fallback, min, max) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isSafeInteger(Math.trunc(number))) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
function normalizeLimits(input = {}) {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const max = key === "maxBytes" ? 512 * 1024 * 1024 : key === "maxFileBytes" ? 8 * 1024 * 1024 : key === "maxResultChars" ? 60000 : key === "maxAstNodes" ? 100000 : key === "maxFiles" ? 20000 : key === "maxEntries" ? 100000 : key === "maxUnits" ? 100000 : key === "maxRelationships" || key === "maxWorkItems" ? 100000 : 20000;
    const min = key === "maxResultChars" ? 64 : 1;
    limits[key] = boundedNumber(input[key] === undefined ? fallback : input[key], fallback, min, max);
  }
  return limits;
}
function queryHash(query) { return sha256("sidekick.semantic.query.v1", clean(query, 500).toLowerCase()); }
function cursorEncode(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", CURSOR_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function cursorDecode(value, expected = {}) {
  if (typeof value !== "string" || value.length < 20 || value.length > 2048) throw new Error("invalid semantic continuation cursor");
  const [body, signature] = value.split(".");
  if (!body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw new Error("malformed semantic continuation cursor");
  const actual = crypto.createHmac("sha256", CURSOR_SECRET).update(body).digest("base64url");
  if (signature.length !== actual.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(actual))) throw new Error("invalid semantic continuation cursor");
  let payload; try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new Error("malformed semantic continuation cursor"); }
  if (payload.v !== CURSOR_VERSION || !Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.expires_at < Date.now()) throw new Error("expired semantic continuation cursor");
  for (const key of ["index_root_hash", "query_hash", "ordering", "projection_version"]) if (String(payload[key] || "") !== String(expected[key] || "")) throw new Error("semantic continuation cursor does not match this snapshot or query");
  if (payload.limit !== expected.limit) throw new Error("semantic continuation cursor does not match the requested limit");
  return payload;
}
function addUnique(list, item, key = stable) { if (!list.some(x => key(x) === key(item))) list.push(item); }
function parameterNames(raw) { return clean(raw, 500).split(",").map(part => part.trim().replace(/^\.\.\./, "").split(/[=:]/, 1)[0].replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 64); }
function maskPerl(text) {
  const chars = [...String(text || "")]; let quote = null; let escaped = false; let comment = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (comment) { if (ch === "\n") comment = false; else chars[i] = " "; continue; }
    if (quote) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === quote) quote = null; else if (ch !== "\n") chars[i] = " "; continue; }
    if (ch === "#") { comment = true; chars[i] = " "; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; chars[i] = " "; continue; }
  }
  return chars.join("");
}
function matchingBrace(text, start) { let depth = 0; for (let i = start; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) return i + 1; } return text.length; }
function perlPackageAt(packages, offset) { let current = null; for (const item of packages) { if (item.offset > offset) break; current = item.name; } return current; }
function perlQualifiedName(packageName, name) { return packageName && name && !name.includes("::") ? `${packageName}::${name}` : name; }
function extractPerl(text, file, sourceHash) {
  const masked = maskPerl(text); const out = { packages: [], lexical_declarations: [], anonymous_subroutines: [], symbols: [], relationships: [], imports: [], import_bindings: [], modules: [], warnings: [], perl_fidelity: "partial", perl_extractor: "bounded-structural" };
  const add = (list, item, key = stable) => addUnique(list, item, key);
  const packages = []; let match;
  const packageRe = /\bpackage\s+([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*)\s*(?:v[0-9][^;]*)?;/g;
  while ((match = packageRe.exec(masked))) { const item = { name: match[1], offset: match.index, evidence: evidence(file, sourceHash, text, match.index, packageRe.lastIndex) }; packages.push(item); add(out.packages, item, x => x.name + ":" + x.evidence.byte_start); add(out.modules, { name: item.name, kind: "package", evidence: item.evidence }, x => x.name); }
  const subRe = /\bsub\s+([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)?)\s*(\([^{};\n]{0,500}\))?/g;
  while ((match = subRe.exec(masked))) {
    const open = masked.indexOf("{", subRe.lastIndex); const newline = masked.indexOf("\n", subRe.lastIndex); const hasBody = open >= 0 && (newline < 0 || open < newline + 1000) && masked.slice(subRe.lastIndex, open).indexOf(";") < 0;
    const end = hasBody ? matchingBrace(masked, open) : subRe.lastIndex; const packageName = perlPackageAt(packages, match.index); const name = match[1];
    const symbol = { name, kind: "subroutine", package: packageName, parent: packageName, parameters: parameterNames(match[2] ? match[2].slice(1, -1) : ""), prototype: match[2] ? clean(match[2].slice(1, -1), 240) : null, forward: !hasBody, certainty: "partial", fidelity: "bounded_structural", evidence: evidence(file, sourceHash, text, match.index, Math.max(end, subRe.lastIndex)) };
    add(out.symbols, symbol, x => `${x.name}:${x.package || ""}:${x.evidence.byte_start}`);
    if (!hasBody) out.warnings.push({ code: "perl_forward_declaration", path: file, evidence: symbol.evidence });
    const bodyStart = hasBody ? open : subRe.lastIndex; const body = masked.slice(bodyStart, end); const qualifiedSelf = perlQualifiedName(packageName, name);
    const callRe = /(?<![\w$])([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)?)\s*\(/g; let call;
    while ((call = callRe.exec(body))) { const called = call[1]; if (/^(?:if|unless|while|for|foreach|return|map|grep|sort|defined|blessed|shift|push|pop|keys|values|scalar|sub|package|use|require)$/.test(called)) continue; const at = bodyStart + call.index; add(out.relationships, { kind: "calls", from: qualifiedSelf, to: perlQualifiedName(packageName, called), certainty: "partial", resolution: called.includes("::") ? "candidate" : "unresolved", reason: "Perl static call scope may be changed at runtime", evidence: evidence(file, sourceHash, text, at, at + call[0].length), provenance: { extractor: "bounded-structural", rule: "perl-call" } }, x => `${x.kind}:${x.from}:${x.to}:${x.evidence.byte_start}`); }
    const methodRe = /([A-Za-z_][\w:]*|\$[A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*[!?]?)\s*\(/g; let method;
    while ((method = methodRe.exec(body))) { const at = bodyStart + method.index; const dynamic = method[1].startsWith("$"); add(out.relationships, { kind: "calls", from: qualifiedSelf, to: dynamic ? method[2] : `${method[1]}::${method[2]}`, certainty: "partial", resolution: dynamic ? "dynamic" : "candidate", reason: dynamic ? "receiver is computed at runtime" : "method dispatch may be overridden at runtime", evidence: evidence(file, sourceHash, text, at, at + method[0].length), provenance: { extractor: "bounded-structural", rule: "perl-method-call" } }, x => `${x.kind}:${x.from}:${x.to}:${x.evidence.byte_start}`); }
    if (/\bAUTOLOAD\b/.test(body)) out.warnings.push({ code: "perl_dynamic_autoload", path: file, evidence: evidence(file, sourceHash, text, bodyStart) });
    if (/\beval\b|\*\w+\s*=|\$\w+\s*->\s*\$/.test(body)) out.warnings.push({ code: "perl_dynamic_resolution", path: file, evidence: evidence(file, sourceHash, text, bodyStart) });
  }
  const anonRe = /\bsub\s*(?:\([^{};\n]{0,500}\))?\s*\{/g; while ((match = anonRe.exec(masked))) add(out.anonymous_subroutines, { kind: "anonymous_subroutine", evidence: evidence(file, sourceHash, text, match.index, matchingBrace(masked, masked.indexOf("{", match.index))) }, x => String(x.evidence.byte_start));
  const declRe = /\b(my|our|state|local)\s+((?:\$|@|%)[A-Za-z_]\w*)/g; while ((match = declRe.exec(masked))) add(out.lexical_declarations, { kind: match[1], name: match[2], package: perlPackageAt(packages, match.index), evidence: evidence(file, sourceHash, text, match.index, declRe.lastIndex) }, x => `${x.kind}:${x.name}:${x.evidence.byte_start}`);
  const importRe = /\b(use|require)\s+(?:(?:v?\d[\w.]*)\s+)?([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*)([^;]*);/g; while ((match = importRe.exec(masked))) { const imported = { name: match[2], kind: match[1], evidence: evidence(file, sourceHash, text, match.index, importRe.lastIndex), certainty: "partial" }; const importText = text.slice(match.index, importRe.lastIndex); add(out.imports, imported, x => `${x.kind}:${x.name}`); const exportedNames = importText.match(/\b([A-Za-z_]\w*)\b/g) || []; for (const local of exportedNames.slice(0, 32)) if (!/^(?:use|require|qw|parent|base|fields|as)$/.test(local) && local !== match[2]) add(out.import_bindings, { local, imported: local, namespace: false, specifier: match[2], evidence: imported.evidence, certainty: "partial" }, x => `${x.local}:${x.specifier}`); if (/^(?:parent|base)$/.test(match[2])) { const from = perlPackageAt(packages, match.index); const bases = importText.match(/[A-Za-z_][\w:]*/g) || []; for (const base of bases.slice(0, 16)) if (!/^(?:use|parent|base|qw|fields|as)$/.test(base) && base !== match[2]) add(out.relationships, { kind: "inherits", from, to: base, certainty: "partial", resolution: "candidate", reason: "Perl can alter @ISA at runtime", evidence: imported.evidence, provenance: { extractor: "bounded-structural", rule: "perl-parent-base" } }, x => `${x.kind}:${x.from}:${x.to}`); } }
  const dynamicCall = /\$[A-Za-z_]\w*\s*(?:\([^)]*\)|->\s*\$[A-Za-z_]\w*)/g; while ((match = dynamicCall.exec(masked))) add(out.relationships, { kind: "calls", from: null, to: null, certainty: "partial", resolution: "dynamic", reason: "computed Perl call target cannot be resolved statically", evidence: evidence(file, sourceHash, text, match.index, dynamicCall.lastIndex), provenance: { extractor: "bounded-structural", rule: "perl-computed-call" } }, x => `${x.kind}:dynamic:${x.evidence.byte_start}`);
  out.fidelity = out.warnings.length ? "partial_with_dynamic_warnings" : "partial"; return out;
}
function semanticIdentity(unit) { return sha256("sidekick.semantic.unit.v3", stable({ language: unit.language, modules: canonicalSet(unit.modules), imports: canonicalSet(unit.imports.map(x => x.name || x.text)), import_bindings: canonicalSet((unit.import_bindings || []).map(x => ({ local: x.local, imported: x.imported || null, namespace: x.namespace || null, specifier: x.specifier, target_path: x.target_path || null }))), exports: canonicalSet(unit.exports.map(x => x.name || x.text)), symbols: unit.symbols.map(x => ({ id: x.id || null, name: x.name, kind: x.kind, parameters: x.parameters || [], parent: x.parent || null, execution_phase: x.execution_phase || "unknown", lifecycle_semantics: canonicalSet(x.lifecycle_semantics || []), security_boundaries: canonicalSet((x.security_boundaries || []).map(y => ({ kind: y.kind, confidence: y.confidence }))), side_effects: x.side_effects || [] })), relationships: canonicalSet(unit.relationships.map(x => ({ kind: x.kind, from: x.from, to: x.to, from_id: x.from_id || null, to_id: x.to_id || null, from_candidates: x.from_candidates || [], to_candidates: x.to_candidates || [], resolution: x.resolution || null, certainty: x.certainty, phase: x.phase || null, boundary: x.boundary || null }))), control_flow: canonicalSet((unit.control_flow || []).map(x => ({ kind: x.kind, from: x.from || null, ast_node: x.provenance?.ast_node || null }))), state_transitions: canonicalSet((unit.state_transitions || []).map(x => ({ state: x.state, to: x.to }))), continuation_edges: canonicalSet((unit.continuation_edges || []).map(x => ({ kind: x.kind, from: x.from || null, to: x.to || null }))), lifecycle_semantics: canonicalSet((unit.lifecycle_semantics || []).map(x => ({ kind: x.kind, symbol: x.symbol || null }))), security_boundaries: canonicalSet((unit.security_boundaries || []).map(x => ({ kind: x.kind, confidence: x.confidence }))), execution_phase: unit.execution_phase || "unknown", dynamic_capabilities: canonicalSet((unit.dynamic_capabilities || []).map(x => ({ kind: x.kind, symbol: x.symbol || null }))), signals: canonicalSet(unit.signals.map(x => x.kind)) })); }
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
function configurationHash(root, limits, sourceFiles, filters = {}) {
  let ignoreBytes = "";
  if (!sourceFiles) { try { ignoreBytes = fs.readFileSync(path.join(root, ".gitignore")); } catch {} }
  return sha256("sidekick.semantic.config.v2", stable({ limits, filters: normalizeFilters(filters), gitignore: ignoreBytes.toString("base64") }));
}

function discover(root, limits, filters = {}) {
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
      if (!matchesFilters(relativeEntry, filters)) continue;
      const language = EXTENSIONS[path.extname(entry.name).toLowerCase()];
       if (!language) continue;
       if (files.length >= limits.maxFiles) { truncated = true; return; }
      let stat; try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > limits.maxFileBytes) { skipped.push({ code: "file_size_limit", path: path.relative(root, full).split(path.sep).join("/"), limit: limits.maxFileBytes }); continue; }
      if (bytes + stat.size > limits.maxBytes) { skipped.push({ code: "repository_bytes_limit", path: path.relative(root, full).split(path.sep).join("/"), limit: limits.maxBytes }); truncated = true; continue; }
      const relative = path.relative(root, full).split(path.sep).join("/");
       files.push({ path: relative, language, size: stat.size }); bytes += stat.size;
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
  const ev = offset => evidenceBytes(file, sourceHash, text, offset);
  const add = (list, item, key = stable) => addUnique(list, item, key);
  for (const marker of tree.control_flow || []) add(result.control_flow, { kind: marker.kind, from: marker.from || null, evidence: ev(marker.start_byte), provenance: { ast_node: marker.ast_node, rule: "tree-sitter-control-node" } }, x => `${x.kind}:${x.from}:${x.provenance.ast_node}`);
  const ranges = (tree.symbols || []).map(s => ({ ...s, body: text.slice(charOffsetAtByte(text, s.start_byte), charOffsetAtByte(text, s.end_byte)) }));
  const classify = (name, body, offset) => {
    const lower = `${name} ${body}`;
    const phase = Object.entries(PHASE_WORDS).find(([, re]) => re.test(name));
    const lifecycle = LIFECYCLE_WORDS.filter(word => new RegExp(`\\b${word}(?:\\b|[A-Z_])`, "i").test(lower));
    const security = Object.entries(SECURITY_WORDS).filter(([, re]) => re.test(lower)).map(([kind]) => ({ kind, confidence: /authorize|approval|policy|schema|integrity|timeout|cancel|audit|redact/i.test(lower) ? "structural_name_and_context" : "name_only", evidence: ev(offset), provenance: { rule: "bounded-identifier-and-body-pattern", source: "symbol" } }));
    const sideEffects = [];
    if (/\b(?:write|insert|update|delete|save|persist|store|queue|park|claim|commit)(?:\b|[A-Z_])/i.test(body)) sideEffects.push("durable_state");
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
  const out = { modules: [], imports: [], import_bindings: [], exports: [], symbols: [], relationships: [], signals: [], tests: [], entry_points: [], warnings: [] };
  if (language === "perl") Object.assign(out, extractPerl(text, file, sourceHash));
  const addSymbol = (name, kind, m, extra = {}) => {
    if (!name || out.symbols.length >= 10000) return;
    const symbol = { name: clean(name, 200), kind, ...extra, evidence: evidence(file, sourceHash, text, m.index) };
    addUnique(out.symbols, symbol, x => `${x.name}:${x.kind}:${x.evidence.line}:${x.evidence.column}`);
    if (/test|spec/i.test(file) || /^(test|spec|describe|it|beforeEach)$/.test(name)) addUnique(out.tests, { name: symbol.name, kind: symbol.kind, evidence: symbol.evidence }, x => stable(x));
    return symbol;
  };
  const addImport = (name, m, extra = {}) => addUnique(out.imports, { name: clean(name, 240), ...extra, evidence: evidence(file, sourceHash, text, m.index) }, x => x.name);
  const addBinding = (local, specifier, m, extra = {}) => {
    if (!local || !specifier) return;
    addUnique(out.import_bindings, { local: clean(local, 200), specifier: clean(specifier, 240), ...extra, evidence: evidence(file, sourceHash, text, m.index) }, x => `${x.local}:${x.imported || ""}:${x.namespace || ""}:${x.specifier}`);
  };
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
  if (language === "javascript" || language === "javascript_jsx" || language.startsWith("typescript")) {
    regexMatches(text, /\bimport\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g, m => m[1].split(",").forEach(part => {
      const bits = part.trim().split(/\s+as\s+/i).map(value => clean(value, 200)).filter(Boolean); if (bits[0]) addBinding(bits[1] || bits[0], m[2], m, { imported: bits[0] });
    }));
    regexMatches(text, /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g, m => addBinding(m[1], m[2], m, { namespace: true }));
    regexMatches(text, /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g, m => addBinding(m[1], m[2], m, { imported: "default" }));
    regexMatches(text, /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g, m => m[1].split(",").forEach(part => {
      const bits = part.trim().split(/\s*:\s*/).map(value => clean(value, 200)).filter(Boolean); if (bits[0]) addBinding(bits[1] || bits[0], m[2], m, { imported: bits[0] });
    }));
    regexMatches(text, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g, m => addBinding(m[1], m[2], m, { namespace: true }));
  }

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

// Symbols are scoped by repository-relative path, lexical parent, kind, name,
// and a canonical source location.  The location is used only as a
// deterministic disambiguator for legal same-scope duplicates; it is never an
// absolute path or an incidental traversal index.  Ambiguous relationship
// endpoints remain explicitly unresolved instead of being assigned to the
// last symbol with a matching display name.
function assignScopedSymbolIdentities(files) {
  const byName = new Map();
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const file of files) {
    const symbols = (file.unit.symbols || []).slice().sort((a, b) =>
      (a.evidence?.line || 0) - (b.evidence?.line || 0) ||
      (a.evidence?.column || 0) - (b.evidence?.column || 0) ||
      String(a.parent || "").localeCompare(String(b.parent || "")) ||
      String(a.kind || "").localeCompare(String(b.kind || "")) ||
      String(a.name || "").localeCompare(String(b.name || ""))
    );
    const local = new Map();
    for (const symbol of symbols) {
      const base = { path: file.path, parent: symbol.parent || null, kind: symbol.kind, name: symbol.name };
      const key = stable(base);
      const occurrence = (local.get(key) || 0) + 1;
      local.set(key, occurrence);
      // Occurrence is canonical: symbols are sorted by normalized source
      // location and then structural fields before it is assigned.  Omitting
      // the location from the digest keeps formatting-only edits from
      // changing an otherwise identical symbol identity.
      symbol.id = `sym:v1:${sha256("sidekick.semantic.symbol.v1", stable({ ...base, occurrence })).slice(0, 40)}`;
      const names = byName.get(symbol.name) || [];
      names.push({ file, symbol });
      byName.set(symbol.name, names);
    }
  }
  for (const entries of byName.values()) entries.sort((a, b) => a.file.path.localeCompare(b.file.path, "en") || (a.symbol.evidence?.line || 0) - (b.symbol.evidence?.line || 0) || a.symbol.id.localeCompare(b.symbol.id));

  const resolve = (file, name, preferLocal) => {
    if (!name) return { id: null, candidates: [] };
    const raw = String(name); const qualified = raw.match(/^(.+)::([^:]+)$/);
    const candidates = (byName.get(qualified ? qualified[2] : raw) || []).filter(item => {
      if (preferLocal && item.file.path !== file.path) return false;
      return !qualified || String(item.symbol.package || item.symbol.parent || "") === qualified[1];
    });
    const ids = candidates.map(item => item.symbol.id).sort();
    return { id: ids.length === 1 ? ids[0] : null, candidates: ids };
  };
  const resolveBound = (file, name) => {
    const raw = String(name || "");
    const direct = (file.unit.import_bindings || []).find(binding => binding.local === raw);
    const qualified = raw.match(/^([^.$]+)\.([A-Za-z_$][\w$]*)$/);
    const namespace = qualified && (file.unit.import_bindings || []).find(binding => binding.namespace && binding.local === qualified[1]);
    const binding = direct || namespace;
    if (!binding || !binding.target_path) return { id: null, candidates: [] };
    const target = byPath.get(binding.target_path);
    if (!target) return { id: null, candidates: [] };
    const exported = binding.namespace ? (qualified ? qualified[2] : null) : (binding.imported === "default" ? "default" : binding.imported);
    const exportNames = new Set((target.unit.exports || []).map(item => String(item.name || item.text || "")));
    const candidates = (target.unit.symbols || []).filter(symbol => {
      if (symbol.name !== exported && !(exported === "default" && symbol.visibility === "public")) return false;
      // Explicit export data is authoritative for ES/TS imports. CommonJS
      // namespace bindings may not expose a lexical export list, so they stay
      // conservative by requiring a unique structurally bound symbol.
      return binding.namespace || exportNames.size === 0 || exportNames.has(symbol.name) || exported === "default";
    });
    const ids = candidates.map(symbol => symbol.id).sort();
    return { id: ids.length === 1 ? ids[0] : null, candidates: ids };
  };
  for (const file of files) {
    for (const relation of file.unit.relationships || []) {
      if (!relation.from_id && relation.kind !== "imports") {
        const resolved = resolve(file, relation.from, true);
        if (resolved.id) { relation.from_id = resolved.id; relation.resolution = relation.resolution || "definite"; }
        else if (resolved.candidates.length) { relation.from_candidates = resolved.candidates; relation.resolution = relation.resolution || "candidate"; }
      }
      if (!relation.to_id && relation.kind !== "imports") {
        const local = resolve(file, relation.to, true);
        const bound = local.id ? local : resolveBound(file, relation.to);
        if (bound.id) { relation.to_id = bound.id; relation.resolution = "definite"; }
        else {
          const candidates = bound.candidates.length ? bound : resolve(file, relation.to, false);
           if (candidates.candidates.length) relation.to_candidates = candidates.candidates;
           relation.resolution = ["dynamic", "candidate"].includes(relation.resolution) ? relation.resolution : (candidates.candidates.length ? "candidate" : "unresolved");
        }
      }
    }
    file.unit.semantic_hash = semanticIdentity({ ...file.unit, language: file.language });
  }
  return byName;
}

async function indexRepository(root, options = {}) {
  const limits = normalizeLimits(options.limits || {});
  const sourceFiles = Array.isArray(options.sourceFiles) ? options.sourceFiles : null;
  const filters = normalizeFilters(options.filters);
  const configHash = configurationHash(root, limits, sourceFiles, filters);
  const found = sourceFiles ? (() => {
    const files = []; const skipped = []; let bytes = 0; let truncated = false;
    for (const item of sourceFiles.slice().sort((a, b) => String(a.path).localeCompare(String(b.path), "en"))) {
      if (files.length >= limits.maxFiles) { truncated = true; break; }
      const relativePath = String(item.path || "").replace(/\\/g, "/");
      if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..") || path.posix.normalize(relativePath) !== relativePath) { skipped.push({ code: "invalid_source_path", path: clean(relativePath, 240) }); continue; }
      if (!matchesFilters(relativePath, filters)) continue;
      if (!EXTENSIONS[path.posix.extname(relativePath).toLowerCase()]) { skipped.push({ code: "unsupported_source_language", path: relativePath }); continue; }
      const size = Buffer.byteLength(String(item.content || ""));
      if (size > limits.maxFileBytes) { skipped.push({ code: "file_size_limit", path: item.path, limit: limits.maxFileBytes }); continue; }
      if (bytes + size > limits.maxBytes) { skipped.push({ code: "repository_bytes_limit", path: item.path, limit: limits.maxBytes }); truncated = true; break; }
      files.push({ path: relativePath, language: EXTENSIONS[path.posix.extname(relativePath).toLowerCase()] || item.language, size, content: item.content }); bytes += size;
    }
    return { files, bytes, truncated, skipped };
  })() : discover(root, limits, filters);
  // Source-provided fixtures and callers may enumerate files in any order;
  // canonical path ordering is part of the IR contract.
  found.files.sort((a, b) => String(a.path).localeCompare(String(b.path), "en"));
  let previous = sourceFiles ? null : (memoryCache.get(root) || readCache(cacheFile(root)));
  if (previous && previous.config_hash !== configHash) previous = null;
  const warnings = [...found.skipped];
  if (previous && !verify(previous)) { previous = null; warnings.push({ code: "cache_integrity_failed", message: "Cached semantic data was not reused; rebuilding." }); }
  const previousByPath = new Map((previous?.files || []).map(file => [file.path, file]));
  const files = []; let cacheHits = 0; let parsed = 0; let units = 0; let parseFailures = 0;
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
    const oldCandidate = previousByPath.get(item.path);
    const old = oldCandidate && oldCandidate.source_hash === sourceHash && oldCandidate.analyzer_version === ANALYZER_VERSION && oldCandidate.ir_version === IR_VERSION ? oldCandidate : null;
    let unit;
    if (old) { unit = old.unit; cacheHits++; } else {
      const text = decodeUtf8(buf); if (text === null) { warnings.push({ code: "encoding_failed", path: item.path }); continue; }
      try {
        unit = parseSource(item.language, item.path, text, sourceHash);
        try {
          const tree = await ast.parse(item.language, text, { maxNodes: limits.maxAstNodes });
           unit.parser = tree.parser; unit.parser_version = tree.parser_version; unit.parse_errors = tree.parse_errors; unit.ast_root = tree.root_type; unit.ast_nodes = tree.visited_nodes;
           unit.fidelity = tree.parse_errors ? "partial_parse" : (item.language === "perl" ? "ast+bounded_structural" : (unit.perl_fidelity || "ast"));
           if (tree.parse_errors) warnings.push({ code: "parse_incomplete", path: item.path, language: item.language, reason: "Tree-sitter reported syntax errors; extracted facts are partial." });
           if (tree.visited_nodes >= limits.maxAstNodes) warnings.push({ code: "ast_nodes_limit", path: item.path, limit: limits.maxAstNodes, reason: "AST traversal stopped at the configured node bound." });
           for (const symbol of tree.symbols) addUnique(unit.symbols, { name: clean(symbol.name, 200), kind: symbol.kind, parent: symbol.parent || null, certainty: "parsed", evidence: evidenceBytes(item.path, sourceHash, text, symbol.start_byte, symbol.end_byte) }, x => `${x.name}:${x.kind}:${x.evidence.line}:${x.evidence.column}`);
           for (const relation of tree.relationships) addUnique(unit.relationships, { kind: relation.kind, from: relation.from, to: relation.to, certainty: relation.certainty, evidence: evidenceBytes(item.path, sourceHash, text, relation.start_byte, relation.end_byte) }, x => x.kind === "calls" ? `${x.kind}:${x.from}:${x.to}` : `${x.kind}:${x.from}:${x.to}:${x.evidence.line}`);
           for (const flow of tree.control_flow || []) addUnique(unit.relationships, { kind: flow.kind, from: flow.from || null, to: null, certainty: "parsed", evidence: evidenceBytes(item.path, sourceHash, text, flow.start_byte), provenance: { ast_node: flow.ast_node, rule: "tree-sitter-control-node" } }, x => `${x.kind}:${x.from}:${x.provenance?.ast_node || ""}`);
           for (const entry of tree.imports) addUnique(unit.imports, { name: clean(entry.text, 240), certainty: "parsed", evidence: evidenceBytes(item.path, sourceHash, text, entry.start_byte) }, x => x.name);
           for (const entry of tree.exports) addUnique(unit.exports, { name: clean(entry.text, 240), certainty: "parsed", evidence: evidenceBytes(item.path, sourceHash, text, entry.start_byte) }, x => x.name);
          const metadata = semanticMetadata(text, tree, item.path, sourceHash);
          Object.assign(unit, metadata);
          for (const symbol of tree.symbols || []) {
            const target = unit.symbols.find(x => x.name === clean(symbol.name, 200) && x.evidence.line === symbol.start_line && x.evidence.column === symbol.start_column) || unit.symbols.find(x => x.name === clean(symbol.name, 200) && x.evidence.line === symbol.start_line);
            if (!target) continue;
            const body = text.slice(charOffsetAtByte(text, symbol.start_byte), charOffsetAtByte(text, symbol.end_byte));
            const phase = Object.entries(PHASE_WORDS).find(([, re]) => re.test(symbol.name));
            target.execution_phase = phase ? phase[0] : "unknown";
            target.lifecycle_semantics = LIFECYCLE_WORDS.filter(word => new RegExp(`\\b${word}(?:\\b|[A-Z_])`, "i").test(`${symbol.name} ${body}`));
            target.security_boundaries = Object.entries(SECURITY_WORDS).filter(([, re]) => re.test(`${symbol.name} ${body}`)).map(([kind]) => ({ kind, confidence: "structural_name_and_context", evidence: target.evidence, provenance: { rule: "bounded-identifier-and-body-pattern", source: "symbol" } }));
            target.side_effects = /\b(?:write|insert|update|delete|save|persist|store|queue|park|claim|commit)(?:\b|[A-Z_])/i.test(body) ? ["durable_state"] : [];
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
        } catch (error) { unit.parser = "lexical-fallback"; unit.parser_error = clean(error.message, 240); unit.fidelity = item.language === "perl" ? "partial_structural_fallback" : "lexical_fallback"; warnings.push({ code: "parser_unavailable", path: item.path, language: item.language, reason: "Structured parser was unavailable; lexical facts are not authoritative." }); }
        unit.semantic_hash = semanticIdentity({ ...unit, language: item.language }); parsed++;
      } catch (error) { parseFailures++; warnings.push({ code: "parser_failed", path: item.path, language: item.language, reason: clean(error.message, 240) }); continue; }
    }
    unit.path = item.path; unit.language = item.language; unit.source_hash = sourceHash; unit.analyzer_version = ANALYZER_VERSION; unit.ir_version = IR_VERSION; files.push({ path: item.path, language: item.language, source_hash: sourceHash, analyzer_version: ANALYZER_VERSION, ir_version: IR_VERSION, unit }); units += unit.symbols.length;
     if (units >= limits.maxUnits) { warnings.push({ code: "semantic_units_limit", limit: limits.maxUnits, reason: "Indexing stopped before all discovered files were represented." }); break; }
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
    for (const binding of file.unit.import_bindings || []) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), binding.specifier));
      binding.target_path = [base, ...[".ts", ".tsx", ".js", ".jsx", ".rb", ".java", ".go", ".pl", ".pm", ".rs"].map(ext => `${base}${ext}`), `${base}/index.ts`, `${base}/index.js`].find(candidate => knownPaths.has(candidate)) || null;
    }
  }
  assignScopedSymbolIdentities(files);
  for (const file of files) {
    file.unit.semantic_hash = semanticIdentity({ ...file.unit, language: file.language });
    const protectedSymbols = new Map((file.unit.symbols || []).filter(s => s.id && (s.security_boundaries || []).some(b => ["authorization", "approval", "policy"].includes(b.kind))).map(s => [s.id, new Set(s.security_boundaries.map(b => b.kind))]));
    for (const relation of [...(file.unit.relationships || [])]) if (relation.kind === "calls" && relation.from_id && protectedSymbols.has(relation.from_id) && /(?:dispatch|execute|invoke|handler|perform|call)/i.test(String(relation.to || ""))) {
      const boundary = [...protectedSymbols.get(relation.from_id)].sort()[0];
      addUnique(file.unit.relationships, { kind: "authorization", from: relation.from, to: relation.to, boundary, certainty: "derived", evidence: relation.evidence, provenance: { rule: "governance-symbol-before-execution-call" } }, x => `${x.kind}:${x.from}:${x.to}:${x.boundary}`);
    }
    file.unit.semantic_hash = semanticIdentity({ ...file.unit, language: file.language });
  }
  // A convergence marker is emitted only when independently observed call
  // edges reach the same symbol. It is a relationship, not a guessed route.
  const incoming = new Map();
  for (const file of files) for (const relation of file.unit.relationships || []) if (relation.kind === "calls" && relation.from_id && relation.to_id) {
    const key = String(relation.to_id); if (!incoming.has(key)) incoming.set(key, []); incoming.get(key).push({ file, relation });
  }
  for (const [toId, edges] of incoming) if (new Set(edges.map(x => x.relation.from_id)).size > 1) {
    const evidenceItem = edges.slice().sort((a, b) => a.file.path.localeCompare(b.file.path) || a.relation.evidence.line - b.relation.evidence.line)[0];
    addUnique(evidenceItem.file.unit.relationships, { kind: "convergence", from: null, to: evidenceItem.relation.to, to_id: toId, certainty: "derived", evidence: evidenceItem.relation.evidence, provenance: { rule: "multiple-observed-callers" } }, x => `${x.kind}:${x.to_id}`);
    evidenceItem.file.unit.semantic_hash = semanticIdentity({ ...evidenceItem.file.unit, language: evidenceItem.file.language });
  }
  // Derived governance/convergence edges are assigned the same scoped
  // identities as parser-produced edges before hashing and persistence.
  assignScopedSymbolIdentities(files);
  const aggregate = { ir_version: IR_VERSION, analyzer_version: ANALYZER_VERSION, config_hash: configHash, files: files.map(x => ({ path: x.path, language: x.language, source_hash: x.source_hash, analyzer_version: x.analyzer_version, ir_version: x.ir_version, unit: x.unit })) };
  const indexRootHash = sha256("sidekick.semantic.index.v4", stable(aggregate));
  if (found.truncated) warnings.push({ code: "discovery_truncated", limit: limits.maxFiles, reason: "The configured discovery budget stopped indexing before the complete source set." });
  const incomplete = Boolean(found.truncated || warnings.some(warning => INCOMPLETE_WARNING_CODES.has(warning.code)));
  const result = { ok: true, schema: IR_VERSION, analyzer_version: ANALYZER_VERSION, config_hash: configHash, repository: { name: path.basename(root), path: root, state: options.state || { kind: "working_tree" } }, provenance: { schema: "sidekick.semantic-provenance.v1", repository_identity: sha256("sidekick.semantic.repository.v1", path.resolve(root)), index_root_hash: indexRootHash, index_created_at: new Date().toISOString(), source_snapshot: options.state || { kind: "working_tree" }, parser_versions: [...new Set(files.map(file => file.unit.parser_version).filter(Boolean))].sort(), warnings: warnings.map(warning => warning.code).slice(0, 64), completeness: incomplete ? "partial" : "complete" }, files, changes: semanticChanges(previous?.files || [], files), stats: { discovered: found.files.length, parsed, parsed_items: parsed, cache_hits: cacheHits, cached_items: cacheHits, cache_misses: Math.max(0, found.files.length - cacheHits), parse_failures: parseFailures, files_emitted: files.length, files_skipped: Math.max(0, found.files.length - files.length), skipped: found.files.length - files.length, bytes: found.bytes, symbols: units, relationships: files.reduce((n, f) => n + (f.unit.relationships || []).length, 0), semantic_bytes: 0, truncated: incomplete, completeness: incomplete ? "partial" : "complete", parse_accounting: { newly_parsed: parsed, reused_from_cache: cacheHits, total_emitted: files.length }, filters: normalizeFilters(filters), limits: limits, excluded_directories: [...SKIP].sort() }, warnings, index_root_hash: indexRootHash, generated_from_source: true };
  result.stats.semantic_bytes = Buffer.byteLength(stable(result), "utf8");
  if (!sourceFiles) { memoryCache.delete(root); memoryCache.set(root, result); while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) memoryCache.delete(memoryCache.keys().next().value); writeCache(cacheFile(root), result); }
  return result;
}

function compareIndexes(before, after, states = {}) {
  return { before: states.before || before?.repository?.state || null, after: states.after || after?.repository?.state || null, changes: semanticChanges(before?.files || [], after?.files || []) };
}

const PROJECTION_PRIORITY = Object.freeze({
  branch: 100, fallback: 100, error_path: 98, convergence: 96,
  authorization: 95, approval: 95, policy: 94, integrity_verification: 93,
  schema_validation: 92, risk_validation: 91, timeout: 89, cancellation: 89,
  persisted_continuation: 100, state_transition: 99, lifecycle_phase: 97,
  execution_authority: 96, side_effect: 90, audit: 86,
});
const RELATIONSHIP_WORDS = new Set(["what", "does", "do", "call", "calls", "caller", "callers", "callee", "callees", "who", "references", "depend", "depends", "dependency", "dependencies", "import", "imports", "module", "modules"]);

function projectionCategories(relation, symbolsById) {
  const categories = [];
  if (PROJECTION_PRIORITY[relation.kind]) categories.push(relation.kind);
  if (relation.boundary) categories.push(String(relation.boundary));
  for (const [endpoint, endpointId] of [[relation.from, relation.from_id], [relation.to, relation.to_id]]) {
    // Display names are for readability only. A unique repository-wide name
    // is still not binding evidence for a relationship endpoint.
    const symbol = endpointId ? symbolsById.get(endpointId) : null;
    for (const boundary of symbol?.security_boundaries || []) categories.push(boundary.kind);
    if (symbol?.execution_phase && symbol.execution_phase !== "unknown") categories.push(`phase:${symbol.execution_phase}`);
    if ((symbol?.side_effects || []).length) categories.push("side_effect");
  }
  if (relation.kind === "calls" && categories.some(x => ["authorization", "approval", "policy", "integrity_verification", "schema_validation", "risk_validation"].includes(x))) categories.push("governance");
  return [...new Set(categories)].sort();
}

function projectionScore(relation, categories, queryScore = 0) {
  const semantic = categories.reduce((best, category) => Math.max(best, PROJECTION_PRIORITY[category] || (category.startsWith("phase:") ? 78 : 0)), 0);
  // A direct query match is a bounded relevance boost, but semantic
  // significance still breaks ties deterministically for equally relevant
  // edges.
  return semantic + queryScore * 120;
}

function compactRelation(relation, detailed) {
  const base = { kind: relation.kind, from: relation.from || null, to: relation.to || null, from_id: relation.from_id || null, to_id: relation.to_id || null, resolution: relation.resolution || (relation.to_id ? "definite" : relation.to_candidates?.length ? "candidate" : "unresolved"), evidence: relation.evidence || null };
  if (relation.from_candidates?.length) base.from_candidates = relation.from_candidates.slice(0, 8);
  if (relation.to_candidates?.length) base.to_candidates = relation.to_candidates.slice(0, 8);
  if (relation.boundary) base.boundary = relation.boundary;
  if (relation.phase) base.phase = relation.phase;
  if (detailed && relation.provenance) base.provenance = relation.provenance;
  return base;
}

function projectLegacy(index, { query = "", level = 0, max_chars = 12000, limit = 40 } = {}) {
  const q = clean(query, 500).toLowerCase(); const tokens = q.split(/[^a-z0-9_:$.-]+/).filter(x => x.length > 1);
  const relationMode = /\b(?:callee|callees|what does .* call|dependencies|imports?|depends?)\b/.test(q) ? "outgoing" : /\b(?:caller|callers|who calls|calls|references|dependents?)\b/.test(q) ? "incoming" : null;
  const all = index.files.flatMap(f => f.unit.symbols.map(s => ({ ...s, path: f.path, language: f.language, source_hash: f.source_hash })));
  const symbolsById = new Map(all.filter(symbol => symbol.id).map(symbol => [symbol.id, symbol]));
  const score = item => tokens.reduce((n, t) => n + (String(item.name).toLowerCase().includes(t) || String(item.kind).toLowerCase().includes(t) || item.path.toLowerCase().includes(t) ? 1 : 0), 0);
  const targetTokens = tokens.filter(token => !RELATIONSHIP_WORDS.has(token));
  const targetIds = new Set(all.filter(item => targetTokens.some(t => String(item.name).toLowerCase().includes(t))).map(item => item.id).filter(Boolean));
  const allRelationships = index.files.flatMap(f => (f.unit.relationships || []).map(r => ({ ...r, path: f.path })));
  const incomingCounts = new Map();
  for (const relation of allRelationships) {
    const endpoint = relation.to_id || relation.to;
    if (endpoint) incomingCounts.set(endpoint, (incomingCounts.get(endpoint) || 0) + 1);
  }
  const relevantRelationships = allRelationships.filter(relation => {
    const endpointMatches = targetIds.has(relation.from_id) || targetIds.has(relation.to_id) || targetTokens.some(token => [relation.from, relation.to].some(endpoint => String(endpoint || "").toLowerCase().includes(token)));
    if (!relationMode) return endpointMatches;
    const endpoint = relationMode === "incoming" ? relation.to : relation.from;
    const endpointId = relationMode === "incoming" ? relation.to_id : relation.from_id;
    return targetIds.has(endpointId) || targetTokens.some(token => String(endpoint || "").toLowerCase().includes(token));
  });
  const relevantRelationshipSet = new Set(relevantRelationships);
  const relatedIds = new Set(relevantRelationships.flatMap(relation => [relation.from_id, relation.to_id]).filter(Boolean));
  const scoredRelationships = allRelationships.map(relation => {
    const categories = projectionCategories(relation, symbolsById);
    const target = relation.to_id ? symbolsById.get(relation.to_id) : null;
    if (relation.kind === "convergence" || (relation.kind === "calls" && target && ((target.side_effects || []).length || (incomingCounts.get(relation.to_id || relation.to) || 0) > 1))) categories.push("execution_authority");
    categories.sort();
    const endpointQueryMatch = targetTokens.some(token => [relation.from, relation.to].some(endpoint => String(endpoint || "").toLowerCase().includes(token)));
    const queryMatch = relevantRelationshipSet.has(relation) || endpointQueryMatch || relatedIds.has(relation.from_id) || relatedIds.has(relation.to_id);
    return { relation, categories, score: projectionScore(relation, categories, queryMatch ? 2 : 0) };
  }).sort((a, b) => b.score - a.score || a.relation.path.localeCompare(b.relation.path) || (a.relation.evidence?.line || 0) - (b.relation.evidence?.line || 0) || String(a.relation.kind).localeCompare(String(b.relation.kind)) || String(a.relation.from || "").localeCompare(String(b.relation.from || "")) || String(a.relation.to || "").localeCompare(String(b.relation.to || "")));
  const selectedRelationshipCount = Math.min(200, Math.max(limit, relevantRelationships.length + 1));
  const selectedRelationshipData = [...scoredRelationships.filter(item => relevantRelationshipSet.has(item.relation)), ...scoredRelationships.filter(item => !relevantRelationshipSet.has(item.relation))].slice(0, selectedRelationshipCount);
  const selectedRelationships = selectedRelationshipData.map(item => ({ ...compactRelation(item.relation, level > 1), significance: item.categories }));
  const symbols = all.slice().sort((a, b) => (relatedIds.has(b.id) ? 1 : 0) - (relatedIds.has(a.id) ? 1 : 0) || (b.security_boundaries?.length || 0) - (a.security_boundaries?.length || 0) || score(b) - score(a) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, selectedRelationshipCount);
  const projectedSymbols = symbols.map(s => ({ id: s.id, name: s.name, kind: s.kind, parent: s.parent || null, path: s.path, language: s.language, execution_phase: s.execution_phase || "unknown", lifecycle_semantics: [...(s.lifecycle_semantics || [])].sort(), security_boundaries: [...new Set((s.security_boundaries || []).map(x => x.kind))].sort(), side_effects: [...(s.side_effects || [])].sort(), evidence: s.evidence }));
  const querySymbols = projectedSymbols.filter(symbol => targetIds.has(symbol.id) || targetTokens.some(token => symbol.name.toLowerCase().includes(token) || symbol.path.toLowerCase().includes(token)));
  const rankMetadata = items => items.slice().sort((a, b) => {
    const aMatch = targetTokens.some(token => stable(a).toLowerCase().includes(token)) ? 1 : 0;
    const bMatch = targetTokens.some(token => stable(b).toLowerCase().includes(token)) ? 1 : 0;
    return bMatch - aMatch || stable(a).localeCompare(stable(b));
  }).slice(0, limit);
  const governance = all.flatMap(s => (s.security_boundaries || []).length || (s.side_effects || []).length ? [{ symbol: s.name, path: s.path, phase: s.execution_phase || "unknown", boundaries: [...new Set((s.security_boundaries || []).map(x => x.kind))].sort(), side_effects: [...(s.side_effects || [])].sort(), evidence: s.evidence }] : []).sort((a, b) => a.path.localeCompare(b.path) || (a.evidence?.line || 0) - (b.evidence?.line || 0) || a.symbol.localeCompare(b.symbol)).slice(0, limit);
  const overview = { schema: index.schema, index_root_hash: index.index_root_hash, repository: index.repository, symbols: (q || level > 0 || selectedRelationships.length ? projectedSymbols : projectedSymbols.filter(s => s.security_boundaries.length || s.side_effects.length).slice(0, limit)), languages: [...new Set(index.files.map(x => x.language))].sort(), modules: index.files.flatMap(f => f.unit.modules.map(m => ({ ...m, path: f.path }))).slice(0, limit), entry_points: index.files.flatMap(f => f.unit.entry_points).slice(0, limit), lifecycle: rankMetadata(index.files.flatMap(f => (f.unit.lifecycle_semantics || []).map(s => ({ ...s, path: f.path })))), governance, security_boundaries: rankMetadata(index.files.flatMap(f => (f.unit.security_boundaries || []).map(s => ({ ...s, path: f.path })))), state_transitions: rankMetadata(index.files.flatMap(f => (f.unit.state_transitions || []).map(s => ({ ...s, path: f.path })))), continuation_edges: rankMetadata(index.files.flatMap(f => (f.unit.continuation_edges || []).map(s => ({ ...s, path: f.path })))), dynamic_capabilities: rankMetadata(index.files.flatMap(f => (f.unit.dynamic_capabilities || []).map(s => ({ ...s, path: f.path })))), signals: index.files.flatMap(f => f.unit.signals.map(s => ({ ...s, path: f.path }))).slice(0, limit), changes: (index.changes || []).slice(0, limit), relationships: selectedRelationships.slice(0, limit) };
  if (level > 1 || relationMode) overview.relationships = (relationMode ? selectedRelationshipData : selectedRelationshipData).map(item => ({ ...compactRelation(item.relation, true), significance: item.categories }));
  const essential = overview.relationships.filter(r => ["branch", "fallback", "error_path", "convergence", "authorization", "approval", "persisted_continuation", "state_transition"].includes(r.kind) || (r.significance || []).some(x => ["authorization", "approval", "policy", "integrity_verification", "schema_validation", "execution_authority"].includes(x)));
  const queryRelationships = selectedRelationshipData.filter(item => relevantRelationshipSet.has(item.relation)).map(item => ({ ...compactRelation(item.relation, level > 1), significance: item.categories }));
  const compactQueryRelationships = selectedRelationshipData.filter(item => relevantRelationshipSet.has(item.relation)).map(item => ({ ...compactRelation(item.relation, false), significance: item.categories }));
  overview.policy = { retained_first: ["execution_authority", "security", "authorization", "approval", "durable_continuation", "state_transition", "branch_fallback", "lifecycle", "provenance"], essential_edge_count: essential.length, detail_level: Math.max(0, Math.min(2, Number(level) || 0)) };
  const makeDegradation = (level, omitted, provenance, security, minimum = "preserved") => ({ truncated: level !== "none", degradation_level: level, omitted: [...new Set(omitted)].sort(), provenance, security, minimum_semantics: minimum });
  const ordered = { schema: overview.schema, index_root_hash: overview.index_root_hash, repository: overview.repository, symbols: overview.symbols, governance: overview.governance, relationships: overview.relationships, lifecycle: overview.lifecycle, state_transitions: overview.state_transitions, continuation_edges: overview.continuation_edges, security_boundaries: overview.security_boundaries, dynamic_capabilities: overview.dynamic_capabilities, entry_points: overview.entry_points, languages: overview.languages, modules: overview.modules, signals: overview.signals, changes: overview.changes, policy: overview.policy, stats: index.stats, warnings: (index.warnings || []).slice(0, 20), degradation: makeDegradation("none", [], "full", "full") };
  let text = JSON.stringify(ordered);
  // Budget degradation preferentially retains architecture/security semantics,
  // but every omission is reported in-band. A compact JSON fallback is still
  // valid and truthful when the requested budget cannot retain the full view.
  if (text.length > max_chars) {
    ordered.degradation = makeDegradation("moderate", ["ordinary_symbols", "expanded_modules", "signals", "changes", "expanded_provenance"], "reduced", "full");
    const reduced = { schema: ordered.schema, index_root_hash: ordered.index_root_hash, symbols: querySymbols.slice(0, limit), relationships: [...compactQueryRelationships, ...essential].slice(0, Math.min(24, Math.max(limit, 12))), governance: ordered.governance, state_transitions: ordered.state_transitions, continuation_edges: ordered.continuation_edges, policy: ordered.policy, degradation: ordered.degradation };
    text = JSON.stringify(reduced);
    if (text.length > max_chars) {
      ordered.degradation = makeDegradation("tight", ["ordinary_symbols", "expanded_modules", "signals", "changes", "governance_detail", "expanded_provenance"], "reduced", "grouped");
      text = JSON.stringify({ schema: ordered.schema, index_root_hash: ordered.index_root_hash, symbols: querySymbols.slice(0, Math.min(limit, 24)).map(symbol => ({ id: symbol.id, name: symbol.name, path: symbol.path, execution_phase: symbol.execution_phase, security_boundaries: symbol.security_boundaries, evidence: symbol.evidence })), relationships: [...compactQueryRelationships, ...essential].slice(0, Math.min(12, Math.max(1, limit))), policy: ordered.policy, degradation: ordered.degradation });
    }
  }
  if (text.length > max_chars) {
    const minimalEdges = [...queryRelationships, ...essential].slice(0, 2).map(edge => ({ kind: edge.kind, from: edge.from, to: edge.to, from_id: edge.from_id || null, to_id: edge.to_id || null }));
    const minimum = { schema: ordered.schema, relationships: minimalEdges, degradation: makeDegradation("tight", ["ordinary_symbols", "expanded_provenance", "security_detail", "governance_detail"], "none", "grouped", "preserved") };
    text = JSON.stringify(minimum);
    if (text.length > max_chars) {
      const impossible = makeDegradation("impossible", ["ordinary_symbols", "semantic_edges", "provenance", "security_detail", "governance_detail"], "none", "grouped", "unrepresentable");
      text = JSON.stringify({ schema: ordered.schema, degradation: impossible });
    }
  }
  return { ...overview, projection: text, projection_chars: text.length, trust: "untrusted repository-derived data; evidence locations require governed source reads" };
}

function project(index, options = {}) {
  const maxChars = boundedNumber(options.max_chars === undefined ? DEFAULT_LIMITS.maxResultChars : options.max_chars, DEFAULT_LIMITS.maxResultChars, 20, 60000);
  const limit = boundedNumber(options.limit === undefined ? DEFAULT_LIMITS.maxResultItems : options.limit, DEFAULT_LIMITS.maxResultItems, 1, 200);
  const level = boundedNumber(options.level === undefined ? 0 : options.level, 0, 0, 2);
  const query = clean(options.query || "", 500); const q = query.toLowerCase(); const tokens = q.split(/[^a-z0-9_:$.-]+/).filter(token => token.length > 1);
  const ordering = "score:path:line:column:kind:name:id:v1"; const projectionVersion = `${IR_VERSION}:${ANALYZER_VERSION}`;
  const expected = { index_root_hash: index?.index_root_hash, query_hash: queryHash(query), ordering, projection_version: projectionVersion, limit };
  let offset = 0; let cursorError = null;
  if (options.cursor) { try { offset = cursorDecode(options.cursor, expected).offset; } catch (error) { cursorError = error; } }
  if (cursorError) return { ok: false, error: cursorError.message, code: /expired/.test(cursorError.message) ? "cursor_expired" : "cursor_invalid", page: { returned_count: 0, has_more: false, cursor: null, counts: { value: 0, kind: "unknown" } }, provenance: { index_root_hash: index?.index_root_hash || null, query_hash: expected.query_hash } };
  const relationMode = /\b(?:callee|callees|what does .* call|dependencies|imports?|depends?)\b/.test(q) ? "outgoing" : /\b(?:caller|callers|who calls|calls|references|dependents?)\b/.test(q) ? "incoming" : null;
  const targetTokens = tokens.filter(token => !RELATIONSHIP_WORDS.has(token)); const workLimit = Math.min(DEFAULT_LIMITS.maxWorkItems, DEFAULT_LIMITS.maxRelationships, 20000);
  const all = []; const relationships = []; let work = 0; let workTruncated = false;
  // Symbols and relationships have separate deterministic work passes. A
  // relationship-heavy repository must not starve direct symbol discovery.
  for (const file of index.files || []) {
    for (const symbol of file.unit.symbols || []) { if (++work > workLimit) { workTruncated = true; break; } all.push({ ...symbol, path: file.path, language: file.language, source_hash: file.source_hash }); }
    if (workTruncated) break;
  }
  work = 0;
  for (const file of index.files || []) {
    for (const relation of file.unit.relationships || []) { if (++work > workLimit) { workTruncated = true; break; } relationships.push({ ...relation, path: file.path }); }
    if (workTruncated) break;
  }
  const symbolsById = new Map(all.filter(symbol => symbol.id).map(symbol => [symbol.id, symbol]));
  // Agent context requests are often prose such as "Profile this repository";
  // when no repository symbol matches, treat that as a bounded overview rather
  // than returning an empty context result.
  const effectiveTargetTokens = targetTokens.length && all.some(item => targetTokens.some(token => `${item.name || ""} ${item.kind || ""} ${item.path || ""}`.toLowerCase().includes(token))) ? targetTokens : [];
  const matches = item => !effectiveTargetTokens.length || effectiveTargetTokens.some(token => `${item.name || ""} ${item.kind || ""} ${item.path || ""} ${item.from || ""} ${item.to || ""}`.toLowerCase().includes(token));
  const score = item => effectiveTargetTokens.reduce((total, token) => total + (matches({ ...item, name: item.name || item.from || "", kind: item.kind, path: item.path }) && `${item.name || item.from || ""} ${item.path || ""}`.toLowerCase().includes(token) ? 2 : 0), 0);
  const allRelations = relationships.slice(0, DEFAULT_LIMITS.maxRelationships).map(relation => ({ relation, score: score(relation) + (PROJECTION_PRIORITY[relation.kind] || 0) / 100 })).sort((a, b) => b.score - a.score || a.relation.path.localeCompare(b.relation.path, "en") || (a.relation.evidence?.byte_start || 0) - (b.relation.evidence?.byte_start || 0) || String(a.relation.kind).localeCompare(String(b.relation.kind)) || String(a.relation.from || "").localeCompare(String(b.relation.from || "")) || String(a.relation.to || "").localeCompare(String(b.relation.to || "")));
  const relatedIds = new Set(allRelations.filter(item => matches(item.relation)).flatMap(item => [item.relation.from_id, item.relation.to_id]).filter(Boolean));
  const allSymbols = all.slice(0, DEFAULT_LIMITS.maxWorkItems).filter(symbol => matches(symbol) || relatedIds.has(symbol.id)).map(symbol => ({ symbol, score: score(symbol) + (relatedIds.has(symbol.id) ? 1 : 0) })).sort((a, b) => b.score - a.score || a.symbol.path.localeCompare(b.symbol.path, "en") || (a.symbol.evidence?.byte_start || 0) - (b.symbol.evidence?.byte_start || 0) || String(a.symbol.name).localeCompare(String(b.symbol.name)) || String(a.symbol.id).localeCompare(String(b.symbol.id)));
  const relationPage = allRelations.slice(offset, offset + limit).map(item => ({ ...compactRelation(item.relation, level > 1), significance: projectionCategories(item.relation, symbolsById) }));
  const symbolPage = allSymbols.slice(offset, offset + limit).map(item => ({ id: item.symbol.id, name: item.symbol.name, kind: item.symbol.kind, parent: item.symbol.parent || null, package: item.symbol.package || null, path: item.symbol.path, language: item.symbol.language, source_hash: item.symbol.source_hash, fidelity: item.symbol.fidelity || "ast", execution_phase: item.symbol.execution_phase || "unknown", lifecycle_semantics: [...(item.symbol.lifecycle_semantics || [])].sort(), security_boundaries: [...new Set((item.symbol.security_boundaries || []).map(x => x.kind))].sort(), side_effects: [...(item.symbol.side_effects || [])].sort(), evidence: item.symbol.evidence }));
  const maxCount = Math.max(allRelations.length, allSymbols.length); const hasMore = offset + limit < maxCount || workTruncated;
   if (!Object.prototype.hasOwnProperty.call(index, "_cursor_expires_at")) Object.defineProperty(index, "_cursor_expires_at", { value: Date.now() + CURSOR_TTL_MS, writable: false, enumerable: false });
   const nextCursor = hasMore ? cursorEncode({ v: CURSOR_VERSION, offset: offset + limit, expires_at: index._cursor_expires_at, index_root_hash: expected.index_root_hash, query_hash: expected.query_hash, ordering, projection_version: projectionVersion, limit }) : null;
  const warnings = [...(index.warnings || [])].slice(0, DEFAULT_LIMITS.maxSnippets);
   const incomplete = Boolean(workTruncated || index.stats?.completeness === "partial" || index.stats?.truncated || warnings.some(warning => INCOMPLETE_WARNING_CODES.has(warning.code)));
   const provenance = { schema: "sidekick.semantic-provenance.v1", repository_identity: index.provenance?.repository_identity || null, index_root_hash: index.index_root_hash || null, index_version: projectionVersion, source_snapshot: index.repository?.state || null, query_hash: expected.query_hash, query_executed_at: null, freshness: "snapshot_bound", completeness: incomplete ? "partial" : "complete", evidence_class: "discovery_lead", trust: "untrusted_derived_source" };
  const page = { returned_count: relationPage.length + symbolPage.length, has_more: hasMore, cursor: nextCursor, offset, limit, counts: { relationships: allRelations.length, symbols: allSymbols.length, kind: workTruncated ? "lower_bound" : "exact" }, applied_limits: { max_items: limit, max_chars: maxChars, max_work_items: workLimit, max_relationships: DEFAULT_LIMITS.maxRelationships, max_snippets: DEFAULT_LIMITS.maxSnippets }, truncation_reasons: [...new Set([...(workTruncated ? ["internal_work_limit"] : []), ...(incomplete ? warnings.map(warning => warning.code) : [])])] };
  const governance = all.filter(symbol => (symbol.security_boundaries || []).length || (symbol.side_effects || []).length).slice(0, limit).map(symbol => ({ symbol: symbol.name, path: symbol.path, boundaries: [...new Set((symbol.security_boundaries || []).map(boundary => boundary.kind))].sort(), side_effects: [...(symbol.side_effects || [])].sort(), evidence: symbol.evidence }));
  const stateTransitions = (index.files || []).flatMap(file => (file.unit.state_transitions || []).map(item => ({ ...item, path: file.path }))).slice(0, limit);
  const continuationEdges = (index.files || []).flatMap(file => (file.unit.continuation_edges || []).map(item => ({ ...item, path: file.path }))).slice(0, limit);
   const overview = { schema: index.schema, index_root_hash: index.index_root_hash, repository: { name: index.repository?.name || null, identity: index.provenance?.repository_identity || null, state: index.repository?.state || null }, symbols: symbolPage, governance, relationships: relationPage, lifecycle: [], state_transitions: stateTransitions, continuation_edges: continuationEdges, security_boundaries: [], dynamic_capabilities: [], entry_points: [], languages: [...new Set((index.files || []).map(file => file.language))].sort(), modules: (index.files || []).flatMap(file => (file.unit.modules || []).map(module => ({ ...module, path: file.path, source_hash: file.source_hash }))).slice(0, limit), provenance, warnings, degradation: { truncated: incomplete, degradation_level: incomplete ? "partial" : "none", omitted: page.truncation_reasons, minimum_semantics: "preserved" }, trust: "untrusted repository-derived data; semantic matches are discovery leads and require exact source validation" };
  const essentialRelations = relationPage.filter(relation => ["branch", "fallback", "error_path", "authorization", "approval", "persisted_continuation", "state_transition"].includes(relation.kind)).slice(0, 3);
  let projection = maxChars <= 700 ? JSON.stringify({ schema: overview.schema, relationships: essentialRelations.map(relation => ({ kind: relation.kind, from: relation.from, to: relation.to })), degradation: { truncated: true, degradation_level: "tight", omitted: ["ordinary_symbols", "expanded_provenance"], minimum_semantics: "preserved" } }) : JSON.stringify(overview);
   if (maxChars > 700 && projection.length > maxChars) { const compact = { schema: overview.schema, index_root_hash: overview.index_root_hash, symbols: symbolPage.slice(0, Math.min(limit, 12)).map(symbol => ({ id: symbol.id, name: symbol.name, kind: symbol.kind, path: symbol.path, evidence: symbol.evidence && { path: symbol.evidence.path, line: symbol.evidence.line, column: symbol.evidence.column, byte_start: symbol.evidence.byte_start, byte_end: symbol.evidence.byte_end } })), relationships: relationPage.slice(0, Math.min(limit, 12)).map(relation => ({ kind: relation.kind, from: relation.from, to: relation.to, resolution: relation.resolution, evidence: relation.evidence && { path: relation.evidence.path, line: relation.evidence.line, column: relation.evidence.column } })), governance: governance.slice(0, 12), state_transitions: stateTransitions.slice(0, 12), continuation_edges: continuationEdges.slice(0, 12), provenance: { index_root_hash: provenance.index_root_hash, query_hash: provenance.query_hash, evidence_class: provenance.evidence_class, completeness: provenance.completeness }, warnings: warnings.slice(0, 4), degradation: { truncated: true, degradation_level: "tight", omitted: ["expanded_modules", "expanded_provenance", "unselected_results"], minimum_semantics: "preserved" } }; projection = JSON.stringify(compact); }
   if (maxChars > 700 && projection.length > maxChars) { projection = JSON.stringify({ schema: overview.schema, symbols: symbolPage.slice(0, 3).map(symbol => ({ id: symbol.id, name: symbol.name, path: symbol.path, evidence: symbol.evidence && { path: symbol.evidence.path, line: symbol.evidence.line, column: symbol.evidence.column } })), relationships: relationPage.slice(0, 2).map(relation => ({ kind: relation.kind, from: relation.from, to: relation.to })), provenance: { index_root_hash: provenance.index_root_hash, query_hash: provenance.query_hash, evidence_class: provenance.evidence_class, completeness: provenance.completeness }, degradation: { truncated: true, degradation_level: "impossible", omitted: ["expanded_semantic_results", "provenance_detail"], minimum_semantics: "preserved" } }); }
  if (projection.length > maxChars) projection = JSON.stringify({ schema: overview.schema, degradation: { truncated: true, degradation_level: "impossible", omitted: ["semantic_results", "provenance"], minimum_semantics: "unrepresentable" } });
  return { ...overview, page, projection, projection_chars: projection.length };
}

function relevantFiles(index, { query = "", limit = 40, cursor } = {}) {
  const boundedLimit = boundedNumber(limit, DEFAULT_LIMITS.maxResultItems, 1, 200);
  const cleanQuery = clean(query, 500);
  const tokens = cleanQuery.toLowerCase().split(/[^a-z0-9_:$.-]+/).filter(token => token.length > 1);
  const ordering = "relevant-files:score:path:v1";
  const expected = { index_root_hash: index?.index_root_hash, query_hash: queryHash(cleanQuery), ordering, projection_version: `${IR_VERSION}:${ANALYZER_VERSION}:relevant-files`, limit: boundedLimit };
  let offset = 0;
  if (cursor) offset = cursorDecode(cursor, expected).offset;
  const ranked = (index.files || []).map(file => {
    const haystack = [file.path, file.language, ...(file.unit.symbols || []).map(symbol => symbol.name), ...(file.unit.modules || []).map(module => module.name), ...(file.unit.imports || []).map(item => item.name || item.text)].join(" ").toLowerCase();
    const reasons = [];
    let score = 0;
    for (const token of tokens) if (haystack.includes(token)) { score += file.path.toLowerCase().includes(token) ? 3 : 1; reasons.push(file.path.toLowerCase().includes(token) ? "path_match" : "semantic_match"); }
    return { file, score, reasons: [...new Set(reasons)].sort() };
  }).filter(item => !tokens.length || item.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path, "en"));
  const pageFiles = ranked.slice(offset, offset + boundedLimit).map(item => ({ path: item.file.path, language: item.file.language, source_hash: item.file.source_hash, score: item.score, match_reasons: item.reasons, symbol_count: (item.file.unit.symbols || []).length, relationship_count: (item.file.unit.relationships || []).length }));
  const hasMore = offset + boundedLimit < ranked.length;
  if (!Object.prototype.hasOwnProperty.call(index, "_cursor_expires_at")) Object.defineProperty(index, "_cursor_expires_at", { value: Date.now() + CURSOR_TTL_MS, writable: false, enumerable: false });
  const nextCursor = hasMore ? cursorEncode({ v: CURSOR_VERSION, offset: offset + boundedLimit, expires_at: index._cursor_expires_at, ...expected }) : null;
  const incomplete = index.stats?.completeness === "partial" || index.stats?.truncated;
  return { files: pageFiles, page: { returned_count: pageFiles.length, has_more: hasMore, cursor: nextCursor, offset, limit: boundedLimit, total_matches: ranked.length }, provenance: { index_root_hash: index.index_root_hash, query_hash: expected.query_hash, completeness: incomplete ? "partial" : "complete", evidence_class: "discovery_lead" }, completeness: incomplete ? "partial" : "complete" };
}

function verify(index) {
  if (!index || !Array.isArray(index.files)) return false;
  const wrappersValid = index.files.every(x => x && x.unit && x.path === x.unit.path && x.language === x.unit.language && x.source_hash === x.unit.source_hash && x.analyzer_version === x.unit.analyzer_version && x.ir_version === x.unit.ir_version);
  if (!wrappersValid) return false;
  return sha256("sidekick.semantic.index.v4", stable({ ir_version: index.schema, analyzer_version: index.analyzer_version, config_hash: index.config_hash, files: index.files.map(x => ({ path: x.path, language: x.language, source_hash: x.source_hash, analyzer_version: x.analyzer_version, ir_version: x.ir_version, unit: x.unit })) })) === index.index_root_hash;
}
function clearMemory(root) { if (root) memoryCache.delete(root); else memoryCache.clear(); }
module.exports = { IR_VERSION, ANALYZER_VERSION, DEFAULT_LIMITS, languageForPath, discover, indexRepository, compareIndexes, project, relevantFiles, verify, stable, sha256, cacheFile, clearMemory, normalizeLimits, normalizeFilters, matchesFilters, cursorEncode, cursorDecode, queryHash, extractPerl };
