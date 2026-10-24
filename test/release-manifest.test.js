"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { generateManifest } = require("../scripts/generate-release-manifest");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-release-manifest-"));
  const worker = path.join(root, "worker");
  fs.mkdirSync(worker, { recursive: true });
  const packageJson = {
    name: "sidekick", version: "2.1.0", license: "GPL-3.0-only",
    engines: { node: ">=22.0.0" }, files: ["src", "README.md"],
    bin: { sidekick: "src/cli.js" },
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: packageJson.name, version: packageJson.version }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "cli.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(root, "README.md"), "release fixture\n");
  fs.writeFileSync(path.join(worker, "package.json"), JSON.stringify({ name: "sidekick-compute-worker", version: packageJson.version, private: false }));
  const content = "version\n";
  fs.writeFileSync(path.join(worker, "worker-agent.js"), content);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  fs.writeFileSync(path.join(worker, "SHA256SUMS"), `${hash}  worker-agent.js\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, worker, packageJson, hash };
}

test("generates bounded release certification evidence and validates package identity", t => {
  const { root, worker, hash } = fixture(t);
  const manifest = generateManifest({ repoRoot: root, workerPackage: worker });
  assert.equal(manifest.schema, "sidekick.release-certification.v1");
  assert.equal(manifest.release.version, "2.1.0");
  assert.equal(manifest.worker_package.file_count, 1);
  assert.equal(manifest.worker_package.files[0].sha256, hash);
  assert.deepEqual(manifest.release.install_surface, {
    files: ["src", "README.md"], bin: { sidekick: "src/cli.js" },
  });
  assert.deepEqual(manifest.certification.commands, ["npm run certify", "node test/invariants-doctor.test.js", "sha256sum -c SHA256SUMS", "npm run sbom:release"]);

  fs.rmSync(path.join(root, "src", "cli.js"));
  assert.throws(() => generateManifest({ repoRoot: root, workerPackage: worker }), /package install surface is missing: src\/cli\.js/);
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "sidekick", version: "2.0.0" }));
  assert.throws(() => generateManifest({ repoRoot: root, workerPackage: worker }), /do not match/);
});

test("rejects symlink escapes in declared release paths", t => {
  const { root, worker, packageJson, hash } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-release-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "payload.txt"), "outside\n");

  packageJson.files = ["escaped"];
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
  try {
    fs.symlinkSync(outside, path.join(root, "escaped"), "junction");
    assert.throws(() => generateManifest({ repoRoot: root, workerPackage: worker }), /symbolic link/);
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
    t.skip("symlink creation is unavailable on this Windows host");
  }

  fs.rmSync(path.join(root, "escaped"), { recursive: true, force: true });
  packageJson.files = ["README.md"];
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(worker, "SHA256SUMS"), `${hash}  escaped.txt\n`);
  try {
    fs.symlinkSync(path.join(outside, "payload.txt"), path.join(worker, "escaped.txt"), "file");
    assert.throws(() => generateManifest({ repoRoot: root, workerPackage: worker }), /symbolic link/);
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
    t.skip("symlink creation is unavailable on this Windows host");
  }
});
