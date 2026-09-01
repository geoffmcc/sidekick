"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { generateManifest } = require("../scripts/generate-release-manifest");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-release-manifest-"));
const worker = path.join(root, "worker");
fs.mkdirSync(worker, { recursive: true });
const packageJson = {
  name: "sidekick",
  version: "2.1.0",
  license: "GPL-3.0-only",
  engines: { node: ">=22.0.0" },
  files: ["src", "README.md"],
  bin: { sidekick: "src/cli.js" },
};
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: packageJson.name, version: packageJson.version }));
fs.mkdirSync(path.join(root, "src"));
fs.writeFileSync(path.join(root, "src", "cli.js"), "#!/usr/bin/env node\n");
fs.writeFileSync(path.join(root, "README.md"), "release fixture\n");
const workerPackage = { name: "sidekick-compute-worker", version: packageJson.version, private: false };
fs.writeFileSync(path.join(worker, "package.json"), JSON.stringify(workerPackage));
fs.writeFileSync(path.join(worker, "worker-agent.js"), "version\n");
const hash = crypto.createHash("sha256").update("version\n").digest("hex");
fs.writeFileSync(path.join(worker, "SHA256SUMS"), `${hash}  worker-agent.js\n`);

const manifest = generateManifest({ repoRoot: root, workerPackage: worker });
assert.strictEqual(manifest.schema, "sidekick.release-certification.v1");
assert.strictEqual(manifest.release.version, "2.1.0");
assert.strictEqual(manifest.worker_package.file_count, 1);
assert.strictEqual(manifest.worker_package.files[0].sha256, hash);
assert.deepStrictEqual(manifest.release.install_surface, {
  files: ["src", "README.md"],
  bin: { sidekick: "src/cli.js" },
});
assert.deepStrictEqual(manifest.certification.commands, ["npm run certify", "node test/invariants-doctor.test.js", "sha256sum -c SHA256SUMS", "npm run sbom:release"]);

fs.rmSync(path.join(root, "src", "cli.js"));
assert.throws(() => generateManifest({ repoRoot: root, workerPackage: worker }), /package install surface is missing: src\/cli\.js/);

fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: packageJson.name, version: "2.0.0" }));
assert.throws(() => generateManifest({ repoRoot: root, workerPackage: worker }), /do not match/);
console.log("Passed: bounded release certification manifest");
