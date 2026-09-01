"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-certification-isolation-"));
const operatorData = path.join(fixture, "operator-data");

try {
  const result = spawnSync(process.execPath, [path.join(root, "src/cli.js"), "certify", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SIDEKICK_DATA_DIR: operatorData, SIDEKICK_CERTIFICATION_DATA_DIR: "" },
    timeout: 120000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.certification_level, "required_hermetic");
  assert.strictEqual(report.verdict, "passed");
  assert.strictEqual(fs.existsSync(operatorData), false, "certification must not initialize operator data");
  console.log("Certification isolation tests passed");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
