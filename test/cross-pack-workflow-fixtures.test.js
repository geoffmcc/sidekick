"use strict";

// Safe cross-pack composition through canonical dispatch. The fixture uses only
// repository-local read/verification operations and explicitly checks denied or
// unavailable paths rather than substituting fake provider success.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-cross-pack-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "cross-pack-fixture-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
require("../src/db").runPendingMigrations();
const bundled = require("../src/packs/bundled");
const { callInternalTool } = require("../src/tools/dispatcher");
const root = path.join(__dirname, "..");

function body(result) {
  assert.ok(result && Array.isArray(result.content));
  if (result.isError) throw new Error(`canonical dispatch failed (${result.code || "unknown"}): ${result.content[0]?.text || ""}`);
  return JSON.parse(result.content[0].text);
}

(async () => {
  for (const name of ["developer", "testing-quality-engineering", "change-impact", "skeptical-verifier", "api-engineering"]) {
    bundled.installBundledPack(name, { enable: true });
  }

  const profile = body(await callInternalTool("dev_repo_profile", { path: root, include_git: true, include_semantic: false }));
  assert.ok(profile.repository && profile.repository.head, "developer discovery should return repository evidence");

  const impact = body(await callInternalTool("change_impact", { path: root, base: "HEAD" }));
  assert.strictEqual(impact.ok, true, "developer + change-impact composition should return structured evidence");

  const denied = await callInternalTool("skeptical_verify", { path: root, max_files: 0 });
  assert.strictEqual(denied.isError, true);
  assert.strictEqual(denied.code, "validation_failed");

  const unavailable = await callInternalTool("api_contract_check", { url: "https://fixture.invalid/health", assertions: [{ kind: "url_contains", value: "health" }] });
  assert.strictEqual(unavailable.isError, true);
  assert.strictEqual(unavailable.code, "validation_failed");
  console.log("Cross-pack canonical workflow fixtures passed: success, denied evidence, and unavailable scope paths");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true }), 0));
