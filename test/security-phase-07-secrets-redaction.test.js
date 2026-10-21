"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-phase7-redaction-"));
process.env.SIDEKICK_DATA_DIR = testDataDir;
process.env.SIDEKICK_DB_FILE = path.join(testDataDir, "sidekick.db");
const db = require("../src/db");
const { createOwnerContext } = require("./helpers/authorized-context");
const { dispatchTool } = require("../src/tools/dispatcher");
const ownerContext = createOwnerContext({ source: "test" });

function text(result) {
  return result?.content?.[0]?.text || "";
}

(async () => {
  const service = "phase7-redaction-test";
  const stored = await dispatchTool({ name: "debug_tool", args: {
    action: "store",
    service,
    issue: "mandatory redaction",
    value: "password=generic-secret-value",
    redact: false,
  }, context: ownerContext });
  assert.strictEqual(stored.isError, undefined, "debug finding should be stored");
  const key = `debug:${service}:mandatory_redaction_${new Date().toISOString().slice(0, 10)}`;
  const scopedKey = `__sidekick_debug_v1:${encodeURIComponent(ownerContext.authIdentity.principal_id)}:global:${key}`;
  const raw = db.getKV(scopedKey);
  assert.strictEqual(raw?.value, "password=[REDACTED]", "debug storage must ignore redact=false");
  db.deleteKV(scopedKey);

  const rejected = await dispatchTool({ name: "store", args: { key: "api_key", value: "arbitrary-secret" }, context: ownerContext });
  assert.strictEqual(rejected.isError, true, "ordinary KV must reject sensitive-looking keys");
  assert.match(text(rejected), /encrypted secret=.*ordinary KV/);

  const legacyKey = `api_key_phase7_${Date.now()}`;
  db.setKV(legacyKey, "arbitrary-legacy-secret", "phase7", "test", "test");
  const safe = await dispatchTool({ name: "get", args: { key: legacyKey }, context: ownerContext });
  assert.strictEqual(safe.isError, true, "legacy sensitive-looking KV keys must fail closed on read");
  assert.doesNotMatch(text(safe), /arbitrary-legacy-secret/);
  db.deleteKV(legacyKey);

  console.log("Phase 7 secrets and redaction tests passed");
  db.closeDatabase();
  fs.rmSync(testDataDir, { recursive: true, force: true });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
