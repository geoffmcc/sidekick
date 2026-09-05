#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { discoverSuites, runSuites } = require("../test/suite-runner");

const root = path.resolve(__dirname, "..");
const sourceExtensions = ["", ".js", ".cjs", ".mjs", ".json"];

function normalize(file) { return file.split(path.sep).join("/").replace(/^\.\//, ""); }

function stripJavaScriptComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function importSpecifiers(source) {
  const clean = stripJavaScriptComments(source);
  const specs = [];
  const pattern = /(?:require\s*\(\s*|\bimport\s+(?:[^'";]*?\s+from\s+)?|\bexport\s+[^'";]*?\s+from\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;
  for (const match of clean.matchAll(pattern)) specs.push(match[1]);
  return [...new Set(specs)];
}

function resolveImport(fromFile, specifier, repositoryRoot = root) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(repositoryRoot, path.dirname(fromFile), specifier);
  for (const extension of sourceExtensions) {
    const candidate = `${base}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return normalize(path.relative(repositoryRoot, candidate));
  }
  for (const extension of sourceExtensions.slice(1)) {
    const candidate = path.join(base, `index${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return normalize(path.relative(repositoryRoot, candidate));
  }
  return null;
}

function buildDependencyGraph(suites, repositoryRoot = root) {
  const graph = new Map();
  const visit = file => {
    if (graph.has(file)) return graph.get(file);
    const dependencies = new Set();
    graph.set(file, dependencies);
    const absolute = path.join(repositoryRoot, file);
    if (!fs.existsSync(absolute) || !/\.(?:c|m)?js$/.test(file)) return dependencies;
    for (const specifier of importSpecifiers(fs.readFileSync(absolute, "utf8"))) {
      const resolved = resolveImport(file, specifier, repositoryRoot);
      if (resolved) { dependencies.add(resolved); visit(resolved); }
    }
    return dependencies;
  };
  for (const suite of suites) visit(suite.file);
  return graph;
}

function dependencyClosure(graph, start) {
  const seen = new Set();
  const visit = file => { if (seen.has(file)) return; seen.add(file); for (const dependency of graph.get(file) || []) visit(dependency); };
  visit(start);
  return seen;
}

function selectChangedTests(changed, suites, repositoryRoot = root) {
  const changedFiles = new Set(changed.flatMap(item => [item.file, item.oldFile].filter(Boolean)).map(normalize));
  const graph = buildDependencyGraph(suites, repositoryRoot);
  const selected = [];
  const reasons = {};
  for (const suite of suites) {
    const closure = dependencyClosure(graph, suite.file);
    const direct = changedFiles.has(suite.file);
    const imports = [...changedFiles].filter(file => file !== suite.file && closure.has(file));
    if (!direct && !imports.length) continue;
    selected.push(suite.file);
    reasons[suite.file] = { owner: suite.owner || suite.domain, domain: suite.domain, direct_change: direct, imported_changes: imports };
  }
  const selectedSet = new Set(selected);
  return {
    selected: selected.sort(),
    reasons,
    changed_files: [...changedFiles].sort(),
    unmatched_changes: [...changedFiles].filter(file => ![...graph.values()].some(dependencies => dependencies.has(file)) && !selectedSet.has(file)).sort(),
  };
}

function readChanges(base) {
  const output = execFileSync("git", ["diff", "--name-status", base, "--"], { cwd: root, encoding: "utf8" }).trim();
  return output ? output.split(/\r?\n/).map(line => { const [status, file, oldFile] = line.split(/\t+/); return { status, file, oldFile: oldFile || null }; }) : [];
}

if (require.main === module) {
  const base = process.env.SIDEKICK_TEST_BASE || execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
  const suites = discoverSuites(root);
  const selection = selectChangedTests(readChanges(base), suites, root);
  console.log(JSON.stringify({ version: 3, base, ...selection }, null, 2));
  if (!selection.selected.length) process.exit(0);
  runSuites({ requested: selection.selected, concurrency: 4 }).then(result => { process.exitCode = result.exitCode; });
}

module.exports = { buildDependencyGraph, dependencyClosure, importSpecifiers, normalize, resolveImport, selectChangedTests };
