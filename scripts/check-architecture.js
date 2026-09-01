#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const sourceRoots = [path.join(root, "src"), path.join(root, "packs")];
const files = [];
function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(full); } }
for (const dir of sourceRoots) walk(dir);
const violations = [];
const imports = new Map();
const re = /require\(["']([^"']+)["']\)|import\s+(?:[^"']+from\s+)?["']([^"']+)["']/g;
function rel(file) { return path.relative(root, file).replaceAll(path.sep, "/"); }
function resolveImport(file, spec) { if (!spec.startsWith(".")) return null; let target = path.resolve(path.dirname(file), spec); for (const candidate of [target, `${target}.js`, `${target}.cjs`, path.join(target, "index.js")]) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; return null; }
for (const file of files) {
  const from = rel(file); const edges = [];
  for (const match of fs.readFileSync(file, "utf8").matchAll(re)) { const spec = match[1] || match[2]; const target = resolveImport(file, spec); if (!target) continue; const to = rel(target); edges.push(target);
    if (from.startsWith("packs/") && /^(src\/(?:dashboard|agent(?:\.js|\/)|db(?:\.js|\/)|tools-legacy\.js|tools\/dispatcher\.js))/.test(to)) violations.push(`${from} -> ${to}: capability packs may use public platform interfaces only`);
    if (/^(src\/db\.js|src\/db\/)/.test(from) && /^(src\/(?:dashboard|agent(?:\.js|\/)|mcp\/)|static\/)/.test(to)) violations.push(`${from} -> ${to}: repositories may not depend on transport or frontend code`);
    if (from.startsWith("src/platform/") && to.startsWith("packs/")) violations.push(`${from} -> ${to}: platform code may not import bundled capability packs`);
    if (from.startsWith("src/tools/families/") && /^(src\/dashboard|src\/agent\.js)/.test(to)) violations.push(`${from} -> ${to}: tool handlers may not import Dashboard or Agent HTTP servers`);
  }
  imports.set(file, edges);
}
const visiting = new Set(); const visited = new Set(); const cycles = [];
function visit(file, stack = []) { if (visiting.has(file)) { const start = stack.indexOf(file); cycles.push(stack.slice(start).concat(file).map(rel).join(" -> ")); return; } if (visited.has(file)) return; visiting.add(file); for (const edge of imports.get(file) || []) visit(edge, [...stack, file]); visiting.delete(file); visited.add(file); }
for (const file of files) visit(file);
// These cycles predate this checker and are transitional compatibility or
// mutually recursive domain seams. New cycles outside these known boundaries
// fail the check; the allowlist is intentionally narrow and documented.
const knownCycleBoundary = cycle => /tools-legacy|core\/identity\.js|compute\/(?:placement|capability-router)|modules\/entries\.js|modules\/(?:loader|services|entry-loader)\.js|tools\/(?:canonical-registry|registry|families\/index)\.js|src\/tools\.js/.test(cycle);
const uniqueCycles = [...new Set(cycles)].filter(cycle => !knownCycleBoundary(cycle));
if (violations.length || uniqueCycles.length) { console.error(JSON.stringify({ violations: [...new Set(violations)], cycles: uniqueCycles }, null, 2)); process.exitCode = 1; } else console.log(`Architecture boundaries OK (${files.length} files checked)`);
module.exports = { resolveImport };
