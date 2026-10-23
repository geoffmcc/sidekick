"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-certification-isolation-"));
const operatorData = path.join(fixture, "operator-data");
const configuredCertificationData = path.join(fixture, "configured-certification-data");
const gitHome = path.join(fixture, "git-home");
fs.mkdirSync(gitHome, { recursive: true });
fs.writeFileSync(path.join(gitHome, ".gitconfig"), `[safe]\n\tdirectory = "${root.replace(/\\/g, "/")}"\n`);

try {
  const result = spawnSync(process.execPath, [path.join(root, "src/cli.js"), "certify", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: gitHome, USERPROFILE: gitHome, SIDEKICK_DATA_DIR: operatorData, SIDEKICK_CERTIFICATION_DATA_DIR: "" },
    timeout: 120000,
  });
  assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.certification_level, "required_hermetic");
  assert.strictEqual(report.verdict, "passed");
  assert.strictEqual(fs.existsSync(operatorData), false, "certification must not initialize operator data");

  // An operator-selected persistent certification store must not receive an
  // automatically bootstrapped Owner. Only the fresh temporary mode above may
  // establish the one-time local certification authority.
  const configured = spawnSync(process.execPath, [path.join(root, "src/cli.js"), "certify", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: gitHome,
      USERPROFILE: gitHome,
      SIDEKICK_DATA_DIR: operatorData,
      SIDEKICK_CERTIFICATION_DATA_DIR: configuredCertificationData,
    },
    timeout: 120000,
  });
  assert.notStrictEqual(configured.status, 0, "configured certification store without an Owner must fail closed");
  assert.match(configured.stderr, /An enabled Owner is required/);
  assert.strictEqual(fs.existsSync(operatorData), false, "configured certification must not initialize operator data");
  const ownerCount = spawnSync(process.execPath, ["-e", "const db=require('./src/db');db.runPendingMigrations();const i=require('./src/core/identity');console.log(i.listPrincipals({type:'human'}).filter(p=>p.enabled&&p.roles.includes('owner')).length);db.closeDatabase();"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SIDEKICK_DATA_DIR: configuredCertificationData },
    timeout: 10000,
  });
  assert.strictEqual(ownerCount.status, 0, ownerCount.stderr);
  assert.strictEqual(ownerCount.stdout.trim(), "0", "configured certification store must remain without an Owner");
  console.log("Certification isolation tests passed");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
