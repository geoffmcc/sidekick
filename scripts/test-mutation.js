#!/usr/bin/env node
"use strict";

// Deterministic mutation runner. Inventory entries describe AST-located source
// regions, not arbitrary file-wide substitutions. Mutants and test runs live in
// disposable copies; the authoritative checkout is never modified.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");

const root = path.resolve(__dirname, "..");
const reportDir = path.join(root, "artifacts");
const policyPath = path.join(root, "docs", "mutation-policy.json");
const parser = new Parser();
parser.setLanguage(JavaScript);

// This is the maintained inventory. Each operator is resolved against a
// concrete syntax node and an exact node/parent expression before editing.
const targetedSpecs = [
  { id: "project-identity", group: "identity", file: "src/core/project-identity.js", tests: ["test/project-identity.test.js", "test/identity-authorization.test.js"], pattern: [
    { id: "canonical-case-change", name: "canonical-case-change", category: "normalization", kind: "region", expression: "String(name == null ? \"\" : name)", contains: "String(name == null ? \"\" : name)", within: ".toLowerCase()", replacement: ".toUpperCase()", security: true },
    { id: "separator-validation-removal", name: "separator-validation-removal", category: "normalization", kind: "region", expression: ".replace(/[^a-z0-9_]+/g, \"_\")", contains: ".replace(/[^a-z0-9_]+/g, \"_\")", within: "\"_\"", replacement: "\"\"", security: true },
  ] },
  { id: "path-policy", group: "path-policy", file: "src/tools/path-policy.js", tests: ["test/path-policy.test.cjs"], pattern: [
    { id: "allowlist-gate-removal", name: "allowlist-gate-removal", category: "authorization", kind: "condition", expression: "allowedEntries.length > 0", replacement: "false", security: true },
  ] },
  { id: "result-contract", group: "result-contract", file: "src/tools/result.js", tests: ["test/tool-result-structure.test.js", "test/sensitive-result-boundary.test.js"], pattern: [
    { id: "partial-status-removal", name: "partial-status-removal", category: "boolean", kind: "operator", expression: "status === \"succeeded\" || status === \"partial\"", operator: "||", replacement: "&&", security: true },
    { id: "result-bound-change", name: "result-bound-change", category: "collection-bound", kind: "literal", expression: "50", parent: "value.warnings.slice(0, 50)", replacement: "51", security: true },
  ] },
  { id: "pack-maturity", group: "maturity", file: "src/packs/maturity.js", tests: ["test/pack-maturity.test.js"], pattern: [
    { id: "freshness-negation", name: "freshness-negation", category: "comparison", kind: "operator", expression: "now - observed > MAX_EVIDENCE_AGE_MS", operator: ">", replacement: "<=", security: false },
    { id: "health-gate-removal", name: "health-gate-removal", category: "boolean", kind: "operator", expression: "record.state === \"enabled\" && health.ok === true && health.status === \"healthy\"", operator: "&&", replacement: "||", security: false },
    { id: "freshness-identity-bypass", name: "freshness-identity-bypass", category: "evidence-freshness", kind: "operator", expression: "entry.pack_version !== record.version", operator: "!==", replacement: "===", security: true },
  ] },
  { id: "proving-runner", group: "proving", file: "src/proving/runner.js", tests: ["test/proving-runner.test.js"], pattern: [
    { id: "proving-not-evaluated-gate", name: "proving-not-evaluated-gate", category: "fail-closed", kind: "condition", expression: "cases.length === 0", replacement: "false", security: true },
  ] },
  { id: "pack-repository", group: "pack-repository", file: "src/packs/repository.js", tests: ["test/pack-proving-evidence.test.js", "test/pack-contract.test.js"], pattern: [
    { id: "evidence-reference-gate-removal", name: "evidence-reference-gate-removal", category: "provenance", kind: "operator", expression: "reasons.length === 0 && refs.length > 0", operator: "&&", replacement: "||", security: true },
  ] },
  { id: "pack-lifecycle", group: "pack-lifecycle", file: "src/packs/lifecycle.js", tests: ["test/capability-packs.test.js", "test/pack-maturity.test.js"], pattern: [
    { id: "enabled-pack-disable-removal", name: "enabled-pack-disable-removal", category: "lifecycle", kind: "condition", expression: "record.state === \"enabled\"", replacement: "false", security: false },
  ] },
];

const fullSpecs = [
  { id: "authorization", group: "authorization", file: "src/core/authorization.js", tests: ["test/identity-authorization.test.js", "test/security-phase-03-auth-authorization.test.js"], pattern: [
    { id: "disabled-principal-gate-removal", name: "disabled-principal-gate-removal", category: "authorization", kind: "condition", expression: "!principal.enabled", replacement: "false", security: true },
    { id: "credential-scope-operator", name: "credential-scope-operator", category: "authorization", kind: "operator", expression: "!scopes.has(\"*\") && !scopes.has(permission)", operator: "&&", replacement: "||", security: true },
  ] },
  { id: "path-policy-boundaries", group: "path-policy", file: "src/tools/path-policy.js", tests: ["test/path-policy.test.cjs"], pattern: [
    { id: "path-open-gate", name: "path-open-gate", category: "authorization", kind: "operator", expression: "deniedEntries.length === 0 && allowedEntries.length === 0", operator: "&&", replacement: "||", security: true },
    { id: "canonical-resolution-fail-open", name: "canonical-resolution-fail-open", category: "fail-closed", kind: "condition", expression: "canonicalTarget.error", replacement: "false", security: true },
  ] },
  { id: "result-contract-boundaries", group: "result-contract", file: "src/tools/result.js", tests: ["test/tool-result-structure.test.js", "test/sensitive-result-boundary.test.js"], pattern: [
    { id: "evidence-bound-change", name: "evidence-bound-change", category: "collection-bound", kind: "literal", expression: "100", parent: "metadata.evidence_refs.slice(0, 100)", replacement: "101", security: true },
    { id: "limitations-bound-change", name: "limitations-bound-change", category: "collection-bound", kind: "literal", expression: "50", parent: "metadata.limitations.slice(0, 50)", replacement: "51", security: true },
  ] },
  { id: "maturity-expiry", group: "maturity", file: "src/packs/maturity.js", tests: ["test/pack-maturity.test.js"], pattern: [
    { id: "expiry-comparison", name: "expiry-comparison", category: "comparison", kind: "operator", expression: "hasExpiry && now > expires", operator: "&&", replacement: "||", security: false },
    { id: "evidence-state-mismatch", name: "evidence-state-mismatch", category: "evidence-freshness", kind: "operator", expression: "entry.config_fingerprint !== configFingerprint(record)", operator: "!==", replacement: "===", security: false },
    { id: "operational-state-gate", name: "operational-state-gate", category: "lifecycle", kind: "operator", expression: "record.state === \"enabled\" && health.ok === true && health.status === \"healthy\"", operator: "&&", replacement: "||", security: false },
  ] },
  { id: "proving-runner", group: "proving", file: "src/proving/runner.js", tests: ["test/proving-runner.test.js"], pattern: [
    { id: "phase-case-mutation-allowed", name: "phase-case-mutation-allowed", category: "authorization", kind: "operator", expression: "typeof item.tool === \"string\"", operator: "===", replacement: "!==", security: true },
    { id: "phase-unavailable-classification", name: "phase-unavailable-classification", category: "boolean", kind: "operator", expression: "normalized.code === \"provider_unavailable\"", operator: "===", replacement: "!==", security: true },
    { id: "not-evaluated-phase-removal", name: "not-evaluated-phase-removal", category: "fail-closed", kind: "condition", expression: "cases.length === 0", replacement: "false", security: true },
  ] },
  { id: "pack-repository", group: "pack-repository", file: "src/packs/repository.js", tests: ["test/pack-proving-evidence.test.js", "test/pack-contract.test.js"], pattern: [
    { id: "terminal-execution-gate", name: "terminal-execution-gate", category: "fail-closed", kind: "operator", expression: "reference.type === \"receipt\"", operator: "===", replacement: "!==", security: true },
    { id: "duplicate-evidence-role-gate", name: "duplicate-evidence-role-gate", category: "provenance", kind: "operator", expression: "previousRole === reference.role", operator: "===", replacement: "!==", security: true },
    { id: "owned-tool-gate", name: "owned-tool-gate", category: "authorization", kind: "operator", expression: "!allowedTools.has(String(row.capability).replace(/^sidekick_/, \"\"))", operator: "!", replacement: "", security: true },
  ] },
  { id: "pack-lifecycle", group: "pack-lifecycle", file: "src/packs/lifecycle.js", tests: ["test/capability-packs.test.js", "test/pack-manifest-lifecycle.test.js", "test/pack-contract.test.js"], pattern: [
    { id: "enable-failure-gate", name: "enable-failure-gate", category: "fail-closed", kind: "condition", expression: "failures.length", replacement: "false", security: true },
    { id: "dependency-readiness-gate", name: "dependency-readiness-gate", category: "authorization", kind: "condition", expression: "dependencyBlockers.length", replacement: "false", security: true },
    { id: "disabled-pack-health-classification", name: "disabled-pack-health-classification", category: "lifecycle", kind: "operator", expression: "!enabled && (status === HEALTH_STATUS.DEGRADED || status === HEALTH_STATUS.DISABLED)", operator: "&&", replacement: "||", security: false },
  ] },
];

function loadPolicy() {
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function getSpecs(mode = process.env.SIDEKICK_MUTATION_MODE || (process.env.SIDEKICK_MUTATION_FULL === "1" ? "full" : "targeted")) {
  return mode === "full" ? [...targetedSpecs, ...fullSpecs] : targetedSpecs;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.namedChildren || []) walk(child, visit);
}

function nodeSource(source, node) { return source.slice(node.startIndex, node.endIndex); }

function replaceOnce(source, start, end, expected, replacement) {
  const current = source.slice(start, end);
  const offset = current.indexOf(expected);
  if (offset < 0) return null;
  return { source: source.slice(0, start + offset) + replacement + source.slice(start + offset + expected.length), start: start + offset };
}

function applyMutation(source, mutation) {
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) return { status: "invalid_baseline", reason: "source does not parse" };
  const matches = [];
  walk(tree.rootNode, node => {
    const text = nodeSource(source, node);
    if (mutation.kind === "condition" && node.type === "if_statement" && node.childForFieldName("condition")) {
      const condition = node.childForFieldName("condition");
      const conditionText = nodeSource(source, condition).replace(/^\((.*)\)$/, "$1");
      if (conditionText === mutation.expression) matches.push(condition);
    }
    if (mutation.kind === "operator" && text === mutation.expression) matches.push(node);
    if (mutation.kind === "region" && mutation.contains && text.includes(mutation.contains)) matches.push(node);
    if (mutation.kind === "literal" && text === mutation.expression) {
      let parent = node.parent;
      while (parent) {
        if (nodeSource(source, parent) === mutation.parent) { matches.push(node); break; }
        parent = parent.parent;
      }
    }
  });
  if (mutation.kind === "region" && matches.length > 1) {
    const eligible = matches.filter(node => nodeSource(source, node).includes(mutation.within));
    if (eligible.length) matches.splice(0, matches.length, ...eligible);
    const shortest = Math.min(...matches.map(node => node.endIndex - node.startIndex));
    const narrowed = matches.filter(node => node.endIndex - node.startIndex === shortest);
    matches.splice(0, matches.length, ...narrowed);
  }
  if (matches.length !== 1) return { status: "missing_target", reason: `expected one AST target, found ${matches.length}` };
  const node = matches[0];
  let edit;
  if (mutation.kind === "condition") {
    const conditionText = nodeSource(source, node);
    const replacement = conditionText.startsWith("(") ? `(${mutation.replacement})` : `(${mutation.replacement})`;
    edit = { source: source.slice(0, node.startIndex) + replacement + source.slice(node.endIndex), start: node.startIndex };
  }
  else if (mutation.kind === "operator") edit = replaceOnce(source, node.startIndex, node.endIndex, mutation.operator, mutation.replacement);
  else if (mutation.kind === "region") edit = replaceOnce(source, node.startIndex, node.endIndex, mutation.within, mutation.replacement);
  else if (mutation.kind === "literal") edit = { source: source.slice(0, node.startIndex) + mutation.replacement + source.slice(node.endIndex), start: node.startIndex };
  if (!edit) return { status: "missing_target", reason: "operator target not found" };
  const mutatedTree = parser.parse(edit.source);
  if (mutatedTree.rootNode.hasError) return { status: "syntax_error", reason: "mutated source does not parse" };
  return { status: "applied", source: edit.source, line: source.slice(0, edit.start).split("\n").length };
}

function copySource(destination) {
  fs.cpSync(root, destination, { recursive: true, filter(source) {
    const relative = path.relative(root, source);
    return relative !== ".git" && relative !== "node_modules" && !relative.startsWith("artifacts") && !relative.startsWith("data") && !relative.startsWith("test/test-") && !relative.startsWith("test/spike-openvino-python");
  } });
}

function digest(text) { return crypto.createHash("sha256").update(String(text || "")).digest("hex"); }
function bounded(text, limit) { return String(text || "").slice(0, limit); }

function executeTests(tests, cwd, policy) {
  const result = spawnSync(process.execPath, ["test/run-all.js", ...tests], {
    cwd,
    env: { ...process.env, NODE_PATH: path.join(root, "node_modules"), NODE_ENV: "test", SIDEKICK_TEST_OVERALL_TIMEOUT_MS: String(policy.execution.overall_timeout_ms) },
    encoding: "utf8",
    timeout: policy.execution.process_timeout_ms,
    maxBuffer: policy.output.max_bytes,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return { result, output, output_digest: digest(output), output_excerpt: bounded(output, policy.output.max_chars) };
}

function classifyMutant(execution) {
  if (execution.result.error) return { status: "infrastructure_error", reason: execution.result.error.code || execution.result.error.message };
  if (execution.result.signal) return { status: "timeout", reason: execution.result.signal };
  if (execution.output.includes("SyntaxError") || execution.output.includes("ERR_PARSE")) return { status: "syntax_error" };
  if (execution.output.includes("ERR_MODULE_NOT_FOUND") || execution.output.includes("Could not find") || execution.output.includes("No test files found")) return { status: "infrastructure_error" };
  return { status: execution.result.status === 0 ? "survived" : "assertion_killed" };
}

function runMutant(spec, mutation, destination, policy) {
  const file = path.join(destination, spec.file);
  const original = fs.readFileSync(file, "utf8");
  const applied = applyMutation(original, mutation);
  if (applied.status !== "applied") return applied;
  fs.writeFileSync(file, applied.source);
  const execution = executeTests(spec.tests, destination, policy);
  return { ...classifyMutant(execution), line: applied.line, exit_code: execution.result.status, signal: execution.result.signal || null, output_digest: execution.output_digest, output_excerpt: execution.output_excerpt };
}

function buildReport(results, mode, policy = loadPolicy(), baselines = {}) {
  const normalized = results.map(item => ({ ...item, status: item.status === "killed" ? "assertion_killed" : item.status }));
  const total = normalized.length;
  const attempted = normalized.filter(item => ["assertion_killed", "survived", "timeout", "syntax_error", "infrastructure_error"].includes(item.status)).length;
  const killed = normalized.filter(item => item.status === "assertion_killed").length;
  const securityResults = normalized.filter(item => item.security);
  const securityAttempted = securityResults.filter(item => ["assertion_killed", "survived", "timeout", "syntax_error", "infrastructure_error"].includes(item.status)).length;
  const securityKilled = securityResults.filter(item => item.status === "assertion_killed").length;
  const score = (count, denominator) => denominator ? Number((count / denominator * 100).toFixed(2)) : 0;
  const categories = Object.fromEntries([...new Set(normalized.map(item => item.category).filter(Boolean))].map(category => [category, normalized.filter(item => item.category === category).length]));
  const groups = Object.fromEntries([...new Set(normalized.map(item => item.group).filter(Boolean))].map(group => {
    const entries = normalized.filter(item => item.group === group);
    return [group, { total: entries.length, attempted: entries.filter(item => ["assertion_killed", "survived", "timeout", "syntax_error", "infrastructure_error"].includes(item.status)).length, killed: entries.filter(item => item.status === "assertion_killed").length, score: score(entries.filter(item => item.status === "assertion_killed").length, entries.length), missing_targets: entries.filter(item => item.status === "missing_target").length, invalid_baselines: entries.filter(item => item.status === "invalid_baseline").length, survivors: entries.filter(item => item.status === "survived").length }];
  }));
  return {
    version: policy.version, mode, inventory: { targeted: targetedSpecs.reduce((n, spec) => n + spec.pattern.length, 0), full: getSpecs("full").reduce((n, spec) => n + spec.pattern.length, 0) },
    total, attempted, killed, survived: normalized.filter(item => item.status === "survived").length, timed_out: normalized.filter(item => item.status === "timeout").length,
    syntax_errors: normalized.filter(item => item.status === "syntax_error").length, infrastructure_errors: normalized.filter(item => item.status === "infrastructure_error").length,
    missing_targets: normalized.filter(item => item.status === "missing_target").length, invalid_baselines: normalized.filter(item => item.status === "invalid_baseline").length,
    mutation_score: score(killed, total), threshold: policy.thresholds.overall_percent,
    security_attempted: securityAttempted, security_killed: securityKilled, security_survived: securityResults.filter(item => item.status === "survived").length,
    security_timed_out: securityResults.filter(item => item.status === "timeout").length, security_missing_targets: securityResults.filter(item => item.status === "missing_target").length,
    security_score: score(securityKilled, securityResults.length), security_threshold: policy.thresholds.security_percent, groups, categories, baselines,
    domain_minimums: policy.thresholds.domain_minimums || {},
    surviving_mutations: normalized.filter(item => item.status === "survived"), results: normalized,
    reproduction: `SIDEKICK_MUTATION_MODE=${mode} npm run test:mutation`,
  };
}

function shouldFail(report, policy = loadPolicy()) {
  const forbidden = new Set(policy.forbidden_survivors || []);
  const minimums = report.mode === "full" ? (policy.thresholds.domain_minimums || {}) : (policy.thresholds.targeted_domain_minimums || {});
  const domainMinimumFailed = Object.entries(minimums).some(([domain, minimum]) => (report.groups?.[domain]?.total || 0) < minimum);
  const missingCategories = (policy.required_categories || []).some(category => !report.categories || !report.categories[category]);
  return !report.attempted || report.mutation_score < report.threshold || report.security_attempted < policy.thresholds.minimum_security_mutants
    || report.security_score < report.security_threshold || report.survived > 0 || report.timed_out > 0 || report.syntax_errors > 0
    || report.infrastructure_errors > 0 || report.missing_targets > 0 || report.invalid_baselines > 0
    || missingCategories || domainMinimumFailed
    || report.surviving_mutations.some(item => forbidden.has(item.mutation || item.id));
}

function main() {
  const policy = loadPolicy();
  const mode = process.env.SIDEKICK_MUTATION_MODE || (process.env.SIDEKICK_MUTATION_FULL === "1" ? "full" : "targeted");
  const selected = process.argv.includes("--mutant") ? process.argv[process.argv.indexOf("--mutant") + 1] : process.env.SIDEKICK_MUTATION_MUTANT;
  const results = [];
  const baselineByGroup = new Map();
  for (const spec of getSpecs(mode)) {
    if (!fs.existsSync(path.join(root, spec.file))) { for (const mutation of spec.pattern) results.push({ id: mutation.id, mutation: mutation.name, group: spec.group, security: Boolean(mutation.security), status: "missing_target", reason: "inventory file missing" }); continue; }
    if (!baselineByGroup.has(spec.group)) baselineByGroup.set(spec.group, executeTests(spec.tests, root, policy));
    const baseline = baselineByGroup.get(spec.group);
    for (const mutation of spec.pattern) {
      if (selected && selected !== mutation.id) continue;
      const base = { id: mutation.id, mutation: mutation.name, file: spec.file, tests: spec.tests, group: spec.group, category: mutation.category, security: Boolean(mutation.security), reproduction: `SIDEKICK_MUTATION_MODE=${mode} SIDEKICK_MUTATION_MUTANT=${mutation.id} npm run test:mutation` };
      if (baseline.result.status !== 0) { results.push({ ...base, status: "invalid_baseline", reason: "group baseline failed", baseline_output_digest: baseline.output_digest }); continue; }
      const destination = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-mutant-"));
      try { copySource(destination); results.push({ ...base, ...runMutant(spec, mutation, destination, policy) }); }
      finally { fs.rmSync(destination, { recursive: true, force: true }); }
    }
  }
  const baselines = Object.fromEntries([...baselineByGroup.entries()].map(([group, execution]) => [group, { status: execution.result.status === 0 ? "valid" : "invalid_baseline", output_digest: execution.output_digest, output_excerpt: execution.output_excerpt }]));
  const report = buildReport(results, mode, policy, baselines);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "mutation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Mutation testing: ${report.killed}/${report.attempted} killed (${report.mutation_score}%), ${report.survived} survived, ${report.missing_targets} missing, ${report.invalid_baselines} invalid baselines`);
  console.log(`Security mutants: ${report.security_killed}/${report.security_attempted} killed (${report.security_score}%), ${report.security_survived} survived`);
  if (shouldFail(report, policy)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { applyMutation, buildReport, getSpecs, loadPolicy, shouldFail };
