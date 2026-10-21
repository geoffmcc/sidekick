"use strict";

// Safe cross-pack composition through canonical dispatch. The fixture uses only
// repository-local read/verification operations and explicitly checks denied or
// unavailable paths rather than substituting fake provider success.
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-cross-pack-"));
const root = path.join(dataDir, "fixture-repository");
const gitHome = path.join(dataDir, "git-home");
fs.mkdirSync(gitHome, { recursive: true });
fs.writeFileSync(path.join(gitHome, ".gitconfig"), `[safe]\n\tdirectory = "${root.replace(/\\/g, "/")}"\n`);
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "src.js"), "module.exports = () => 'fixture';\n");
execFileSync("git", ["init", "--quiet", root]);
execFileSync("git", ["-C", root, "config", "user.name", "Sidekick Test"]);
execFileSync("git", ["-C", root, "config", "user.email", "sidekick-test@example.invalid"]);
execFileSync("git", ["-C", root, "add", "src.js"]);
execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture baseline"]);
process.env.NODE_ENV = "test";
process.env.HOME = gitHome;
process.env.USERPROFILE = gitHome;
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_INTERNAL_ALLOWED_PATHS = root;
process.env.SIDEKICK_SECRET_KEY = "cross-pack-fixture-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
require("../src/db").runPendingMigrations();
const bundled = require("../src/packs/bundled");
const { callInternalTool } = require("../src/tools/dispatcher");
const serviceContext = require("./helpers/authorized-context").createServiceContext({ role: "operator", source: "internal", project: "demo_project" });
const call = (name, args) => callInternalTool(name, args, serviceContext);

function body(result) {
  assert.ok(result && Array.isArray(result.content));
  if (result.isError) throw new Error(`canonical dispatch failed (${result.code || "unknown"}): ${result.content[0]?.text || ""}`);
  return JSON.parse(result.content[0].text);
}

(async () => {
  for (const name of ["developer", "testing-quality-engineering", "change-impact", "skeptical-verifier", "api-engineering"]) {
    bundled.installBundledPack(name, { enable: true });
  }

  const profile = body(await call("dev_repo_profile", { path: root, max_files: 100, include_git: true, include_semantic: false }));
  assert.ok(profile.repository && profile.repository.head, "developer discovery should return repository evidence");

  const impact = body(await call("change_impact", { path: root, base: "HEAD" }));
  assert.strictEqual(impact.ok, true, "developer + change-impact composition should return structured evidence");

  const denied = await call("skeptical_verify", { path: root, max_files: 0 });
  assert.strictEqual(denied.isError, true);
  assert.strictEqual(denied.code, "validation_failed");

  const unavailable = await call("api_contract_check", { url: "https://fixture.invalid/health", assertions: [{ kind: "url_contains", value: "health" }] });
  assert.strictEqual(unavailable.isError, true);
  assert.strictEqual(unavailable.code, "validation_failed");
  const malformed = await call("dev_repo_profile", { path: root, include_git: "yes" });
  assert.strictEqual(malformed.isError, true);
  assert.strictEqual(malformed.code, "validation_failed");
  const nestedFailure = await call("quality_gate", { path: root, dry_run: true, intents: ["unsupported"] });
  assert.strictEqual(nestedFailure.isError, true);
  assert.strictEqual(nestedFailure.code, "validation_failed");
  const staleEvidence = await call("change_impact", { path: root, base: "missing-base-ref" });
  assert.strictEqual(staleEvidence.isError, true);
  assert.strictEqual(JSON.parse(staleEvidence.content[0].text).ok, false, "stale evidence path must remain an unsuccessful structured result");
  console.log("Cross-pack canonical workflow fixtures passed: success, denied, unavailable, malformed, nested-failure, and stale-evidence paths");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => {
    try { require("../src/db").closeDatabase(); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
