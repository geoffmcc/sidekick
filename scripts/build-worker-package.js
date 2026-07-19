#!/usr/bin/env node
// Build a standalone, dependency-free Sidekick Compute Worker package.
//
// Statically walks worker-agent.js's relative-require graph (including lazy
// require("./openvino-executor")), copies EXACTLY those modules — failing loudly
// if the graph ever reaches outside src/compute (i.e. into server-only code) —
// plus the OpenVINO helper, the OS service definitions, and license/readme, then
// emits a minimal package.json (zero dependencies) and a SHA256SUMS manifest.
// Also bundles a pinned, SHA-256-verified winsw release as
// sidekick-compute-worker.exe so install-windows.ps1 works offline with no
// -WinswUrl; the binary lives only in the built artifact, never in git.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..");
const COMPUTE = path.join(REPO, "src", "compute");
const rootPkg = require(path.join(REPO, "package.json"));
const VERSION = rootPkg.version;
const OUT = path.join(REPO, "dist", `sidekick-compute-worker-${VERSION}`);
const ENTRY = path.join(COMPUTE, "worker-agent.js");

// winsw (MIT) — Windows service wrapper, bundled as sidekick-compute-worker.exe.
// NET461 build: 640 KiB, runs on the .NET Framework preinstalled on Win10+.
const WINSW = {
  version: "v2.12.0",
  url: "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe",
  sha256: "b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f",
  cache: path.join(REPO, "dist", ".cache", "winsw-v2.12.0-net461.exe"),
};

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

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Return the verified winsw binary, from the local cache when its hash still
// matches, otherwise downloaded from the pinned release URL. Any hash mismatch
// is fatal — never package an unverified binary.
async function fetchWinsw() {
  if (fs.existsSync(WINSW.cache)) {
    const cached = fs.readFileSync(WINSW.cache);
    if (sha256(cached) === WINSW.sha256) return cached;
    fs.rmSync(WINSW.cache);
  }
  const res = await fetch(WINSW.url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`winsw download failed: HTTP ${res.status} for ${WINSW.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error(`winsw download oversized: ${buf.length} bytes (expected ~640 KiB)`);
  const actual = sha256(buf);
  if (actual !== WINSW.sha256) {
    throw new Error(`winsw ${WINSW.version} SHA-256 mismatch: expected ${WINSW.sha256}, got ${actual}. Refusing to package an unverified binary.`);
  }
  fs.mkdirSync(path.dirname(WINSW.cache), { recursive: true });
  fs.writeFileSync(WINSW.cache, buf);
  return buf;
}

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
  "Windows: winsw is bundled as `sidekick-compute-worker.exe`, so `install-windows.ps1` needs no `-WinswUrl`.\n" +
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

// 5. Bundle winsw at the package root: install-windows.ps1 copies the package
//    root into InstallDir and expects sidekick-compute-worker.exe there, next
//    to the service XML it places.
// 6. SHA256SUMS over every packaged file (excluding the manifest itself).
function listFiles(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}
(async () => {
  fs.writeFileSync(path.join(OUT, "sidekick-compute-worker.exe"), await fetchWinsw());

  const files = listFiles(OUT).filter(f => f !== "SHA256SUMS").sort();
  const sums = files.map(rel => `${sha256(fs.readFileSync(path.join(OUT, rel)))}  ${rel}`).join("\n") + "\n";
  fs.writeFileSync(path.join(OUT, "SHA256SUMS"), sums);

  // 7. Summary.
  const totalBytes = files.reduce((n, rel) => n + fs.statSync(path.join(OUT, rel)).size, 0);
  console.log(`Built ${path.relative(REPO, OUT)}`);
  console.log(`  worker modules: ${[...modules].map(f => path.basename(f)).sort().join(", ")}`);
  console.log(`  winsw: ${WINSW.version} (${WINSW.sha256.slice(0, 12)}…) as sidekick-compute-worker.exe`);
  console.log(`  files: ${files.length}, total: ${(totalBytes / 1024).toFixed(1)} KiB, dependencies: ${Object.keys(outPkg.dependencies || {}).length}`);
})().catch(err => {
  // Never leave a partial, unmanifested package behind.
  fs.rmSync(OUT, { recursive: true, force: true });
  console.error(`build-worker-package: ${err.message}`);
  process.exit(1);
});
