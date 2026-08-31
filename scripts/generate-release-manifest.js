#!/usr/bin/env node
"use strict";

// Produce bounded, machine-readable release evidence without executing the
// certification runner or inspecting runtime state.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeRelative(value) {
  const normalized = String(value).replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`invalid checksum path: ${value}`);
  }
  return normalized;
}

function readChecksums(workerRoot) {
  const checksumPath = path.join(workerRoot, "SHA256SUMS");
  const lines = fs.readFileSync(checksumPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_FILES) throw new Error("worker SHA256SUMS is empty or exceeds the file bound");
  const files = [];
  let totalBytes = 0;
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`invalid worker checksum entry: ${line.slice(0, 120)}`);
    const relative = safeRelative(match[2]);
    const absolute = path.resolve(workerRoot, relative);
    if (!absolute.startsWith(`${path.resolve(workerRoot)}${path.sep}`) || !fs.statSync(absolute).isFile()) {
      throw new Error(`worker checksum file is missing: ${relative}`);
    }
    const size = fs.statSync(absolute).size;
    totalBytes += size;
    if (totalBytes > MAX_BYTES) throw new Error(`worker package exceeds ${MAX_BYTES} bytes`);
    if (sha256(absolute) !== match[1]) throw new Error(`worker checksum mismatch: ${relative}`);
    files.push({ path: relative, sha256: match[1], size });
  }
  return { files, total_bytes: totalBytes, manifest_sha256: sha256(checksumPath) };
}

function generateManifest({ repoRoot = path.join(__dirname, ".."), workerPackage } = {}) {
  const packagePath = path.join(repoRoot, "package.json");
  const lockPath = path.join(repoRoot, "package-lock.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const lockJson = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (packageJson.name !== lockJson.name || packageJson.version !== lockJson.version) {
    throw new Error("package.json and package-lock.json identity/version do not match");
  }

  const workerRoot = path.resolve(workerPackage || path.join(repoRoot, "dist", `sidekick-compute-worker-${packageJson.version}`));
  const workerPackageJson = JSON.parse(fs.readFileSync(path.join(workerRoot, "package.json"), "utf8"));
  if (workerPackageJson.version !== packageJson.version) throw new Error("worker package version does not match the release version");
  const checksums = readChecksums(workerRoot);
  const manifest = {
    schema: "sidekick.release-certification.v1",
    release: {
      name: packageJson.name,
      version: packageJson.version,
      license: packageJson.license || null,
      engines: packageJson.engines || {},
      package_json_sha256: sha256(packagePath),
      package_lock_sha256: sha256(lockPath),
    },
    worker_package: {
      name: workerPackageJson.name,
      version: workerPackageJson.version,
      path: path.relative(repoRoot, workerRoot).split(path.sep).join("/"),
      files: checksums.files,
      file_count: checksums.files.length,
      total_bytes: checksums.total_bytes,
      sha256sums_sha256: checksums.manifest_sha256,
    },
    certification: {
      commands: ["npm run certify", "node test/invariants-doctor.test.js", "sha256sum -c SHA256SUMS", "npm run sbom:release"],
      scope: "release/install artifacts and read-only local diagnostics",
    },
  };
  return Object.freeze(manifest);
}

function main(argv = process.argv.slice(2)) {
  const outputIndex = argv.indexOf("--output");
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : path.join("dist", "release-certification-manifest.json");
  if (!output || output.startsWith("-")) throw new Error("--output requires a path");
  const manifest = generateManifest();
  const destination = path.resolve(output);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), destination)}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`generate-release-manifest: ${error.message}`); process.exitCode = 1; }
}

module.exports = { generateManifest, readChecksums };
