#!/usr/bin/env node
// Build a standalone, dependency-free Sidekick Compute Worker package.
//
// Statically walks worker-agent.js's relative-require graph (including lazy
// require("./openvino-executor")), copies EXACTLY those modules — failing loudly
// if the graph ever reaches outside src/compute (i.e. into server-only code) —
// plus the OpenVINO helper, the OS service definitions, and license/readme, then
// emits a minimal package.json (zero dependencies) and a SHA256SUMS manifest.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..");
const COMPUTE = path.join(REPO, "src", "compute");
const rootPkg = require(path.join(REPO, "package.json"));
const VERSION = rootPkg.version;
const OUT = path.join(REPO, "dist", `sidekick-compute-worker-${VERSION}`);
const ENTRY = path.join(COMPUTE, "worker-agent.js");

const REQUIRE_RE = /require\(\s*["'](\.[^"']+)["']\s*\)/g;

function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + ".js", path.join(base, "index.js")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

// 1. Resolve the transitive module graph from the worker entry.
const modules = new Set();
function walk(file) {
  if (modules.has(file)) return;
  modules.add(file);
  const src = fs.readFileSync(file, "utf8");
  let m;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(src))) {
    const resolved = resolveRel(file, m[1]);
    if (!resolved) continue;
    if (path.basename(resolved) === "package.json") continue; // version only; we generate our own
    if (!resolved.startsWith(COMPUTE + path.sep)) {
      throw new Error(`Worker graph reaches server-only code: ${path.relative(REPO, file)} -> ${m[1]} (${path.relative(REPO, resolved)}). The worker must not depend on it.`);
    }
    walk(resolved);
  }
}
walk(ENTRY);

// 2. Fresh output dir.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyFile(srcAbs, destRel) {
  const dest = path.join(OUT, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcAbs, dest);
}
function copyDir(srcDir, destRel) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    if (entry.isDirectory()) copyDir(s, path.join(destRel, entry.name));
    else copyFile(s, path.join(destRel, entry.name));
  }
}

// 3. Copy worker modules flat (they require ./siblings) + the OpenVINO helper
//    (located via __dirname/openvino/helper.py) + service files + docs.
for (const file of modules) copyFile(file, path.basename(file));
copyDir(path.join(COMPUTE, "openvino"), "openvino");
copyFile(path.join(REPO, "systemd", "sidekick-compute-worker.service"), path.join("systemd", "sidekick-compute-worker.service"));
copyDir(path.join(REPO, "packaging", "compute-worker"), path.join("packaging", "compute-worker"));
copyFile(path.join(REPO, "LICENSE"), "LICENSE");
copyFile(path.join(REPO, "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md");

// 4. README + minimal package.json (dependency-free).
fs.writeFileSync(path.join(OUT, "README.md"),
  `# Sidekick Compute Worker ${VERSION}\n\nStandalone, dependency-free distributed compute worker.\n\n` +
  "```\nnode worker-agent.js version\nnode worker-agent.js enroll --service --token <token>\nnode worker-agent.js run\nnode worker-agent.js doctor\n```\n\n" +
  "OS service installers are under `packaging/compute-worker/` (see its README).\n" +
  "Verify integrity with `sha256sum -c SHA256SUMS`.\n");
const outPkg = {
  name: "sidekick-compute-worker",
  version: VERSION,
  description: "Sidekick distributed compute worker (standalone).",
  bin: { "sidekick-compute-worker": "worker-agent.js" },
  main: "worker-agent.js",
  engines: { node: rootPkg.engines && rootPkg.engines.node ? rootPkg.engines.node : ">=22.0.0" },
  license: rootPkg.license || "UNLICENSED",
  private: false,
};
fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify(outPkg, null, 2) + "\n");

// 5. SHA256SUMS over every packaged file (excluding the manifest itself).
function listFiles(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}
const files = listFiles(OUT).filter(f => f !== "SHA256SUMS").sort();
const sums = files.map(rel => {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(OUT, rel))).digest("hex");
  return `${hash}  ${rel}`;
}).join("\n") + "\n";
fs.writeFileSync(path.join(OUT, "SHA256SUMS"), sums);

// 6. Summary.
const totalBytes = files.reduce((n, rel) => n + fs.statSync(path.join(OUT, rel)).size, 0);
console.log(`Built ${path.relative(REPO, OUT)}`);
console.log(`  worker modules: ${[...modules].map(f => path.basename(f)).sort().join(", ")}`);
console.log(`  files: ${files.length}, total: ${(totalBytes / 1024).toFixed(1)} KiB, dependencies: ${Object.keys(outPkg.dependencies || {}).length}`);
