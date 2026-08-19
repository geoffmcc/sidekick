"use strict";

const assert = require("assert");
const db = require("../src/db");
const { sidekick_debug_tool } = require("../src/tools/families/meta");
const { sidekick_store, sidekick_get } = require("../src/tools/families/storage");

function text(result) {
  return result?.content?.[0]?.text || "";
}

(async () => {
  const service = "phase7-redaction-test";
  const stored = await sidekick_debug_tool({
    action: "store",
    service,
    issue: "mandatory redaction",
    value: "password=generic-secret-value",
    redact: false,
  });
  assert.strictEqual(stored.isError, undefined, "debug finding should be stored");
  const key = `debug:${service}:mandatory_redaction_${new Date().toISOString().slice(0, 10)}`;
  const raw = db.getKV(key);
  assert.strictEqual(raw?.value, "password=[REDACTED]", "debug storage must ignore redact=false");
  db.deleteKV(key);

  const rejected = await sidekick_store({ key: "api_key", value: "arbitrary-secret" });
  assert.strictEqual(rejected.isError, true, "ordinary KV must reject sensitive-looking keys");
  assert.match(text(rejected), /encrypted secret store/);

  const legacyKey = `api_key_phase7_${Date.now()}`;
  db.setKV(legacyKey, "arbitrary-legacy-secret", "phase7", "test", "test");
  const safe = await sidekick_get({ key: legacyKey });
  assert.strictEqual(safe.isError, true, "legacy sensitive-looking KV keys must fail closed on read");
  assert.doesNotMatch(text(safe), /arbitrary-legacy-secret/);
  db.deleteKV(legacyKey);

  console.log("Phase 7 secrets and redaction tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
