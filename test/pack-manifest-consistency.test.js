"use strict";

// Cross-pack manifest/dispatch consistency.
//
// The module services facade enforces manifest permissions as a deny-by-default
// allowlist (src/modules/services.js): a tool a module dispatches but does not
// declare fails at runtime with module_permission_denied — silently turning the
// feature into dead code, because nothing at install or enable time checks the
// two against each other. That is exactly how the Security Research pack's
// guarded lab retirement shipped unreachable: lib/lab.js dispatched
// proxmox_retire while the manifest declared only four other tools.
//
// This suite kills the whole defect class statically: for EVERY pack module it
// extracts each literal tool name passed to a facade dispatch in the module's
// sources and asserts the module's manifest declares a permission for it. It
// needs no database, no install, and no network — it reads the repository.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const PACKS_DIR = path.join(REPO, "packs");

let failures = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`Passed: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAILED: ${label}\n  ${error && error.stack ? error.stack : error}`);
  }
}

/** Every .js file under a module directory (entry + lib/*, shallow recursion). */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") out.push(...jsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(abs);
  }
  return out;
}

/**
 * Literal tool names passed to a facade dispatch: `services.dispatch("x", …)`
 * or a locally-bound `dispatch("x", …)`. The quote immediately after the
 * paren keeps prose in comments from matching; a dynamically computed name
 * (e.g. ansible's `(name, a, o) => services.dispatch(name, a, o)` pass-through)
 * is deliberately out of scope — its concrete call sites are literal and are
 * caught where they occur.
 */
function extractDispatchedTools(source) {
  const names = new Set();
  const re = /\bdispatch\(\s*["']([a-z][a-z0-9_]*)["']/g;
  let match;
  while ((match = re.exec(source)) !== null) names.add(match[1]);
  return names;
}

function moduleDirs() {
  const dirs = [];
  for (const pack of fs.readdirSync(PACKS_DIR, { withFileTypes: true })) {
    if (!pack.isDirectory()) continue;
    const modulesRoot = path.join(PACKS_DIR, pack.name, "modules");
    if (!fs.existsSync(modulesRoot)) continue;
    for (const mod of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
      if (mod.isDirectory()) dirs.push({ pack: pack.name, module: mod.name, dir: path.join(modulesRoot, mod.name) });
    }
  }
  return dirs;
}

const modules = moduleDirs();

test("CONS.1: every pack module has a manifest with a permissions array", () => {
  assert.ok(modules.length >= 4, `expected the bundled pack modules, found ${modules.length}`);
  for (const { pack, module, dir } of modules) {
    const manifestPath = path.join(dir, "manifest.json");
    assert.ok(fs.existsSync(manifestPath), `${pack}/${module} has no manifest.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest.permissions), `${pack}/${module} manifest.permissions must be an array (deny-by-default requires an explicit declaration)`);
  }
});

test("CONS.2: every tool a module dispatches is declared in that module's manifest permissions", () => {
  const problems = [];
  for (const { pack, module, dir } of modules) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const declared = new Set((manifest.permissions || []).map(p => p && p.tool).filter(Boolean));
    for (const file of jsFiles(dir)) {
      const dispatched = extractDispatchedTools(fs.readFileSync(file, "utf8"));
      for (const tool of dispatched) {
        if (!declared.has(tool)) {
          problems.push(`${pack}/${module}: ${path.relative(dir, file)} dispatches "${tool}" but the manifest does not declare it — the facade will return module_permission_denied at runtime`);
        }
      }
    }
  }
  assert.deepStrictEqual(problems, []);
});

test("CONS.3: the extractor actually sees the known dispatch sites (guards against a silently dead regex)", () => {
  // If the extraction pattern ever stops matching real call sites, CONS.2
  // would pass vacuously. Anchor it against dispatches that must exist.
  const expectations = [
    ["security-research", "security-research-tools", ["proxmox_provision", "proxmox_guest", "proxmox_retire", "bash", "web_fetch"]],
    ["developer", "developer-tools", ["git", "bash"]],
    ["proxmox", "proxmox-tools", ["bash"]],
  ];
  for (const [pack, module, tools] of expectations) {
    const dir = path.join(PACKS_DIR, pack, "modules", module);
    const seen = new Set();
    for (const file of jsFiles(dir)) {
      for (const tool of extractDispatchedTools(fs.readFileSync(file, "utf8"))) seen.add(tool);
    }
    for (const tool of tools) {
      assert.ok(seen.has(tool), `${pack}/${module} should be seen dispatching "${tool}" (found: ${[...seen].join(", ") || "none"})`);
    }
  }
});

if (failures > 0) {
  console.error(`\n${failures} pack manifest consistency test(s) failed.`);
  process.exit(1);
}
console.log("\nAll pack manifest consistency tests passed.");
