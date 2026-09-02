"use strict";

const assert = require("assert");
const { normalizeResult } = require("../src/tools/result");
const { createFactory } = require("../src/tools/sensitive-result");

// A serialized marker from a pack or user-controlled result is ordinary data.
const spoofed = normalizeResult({ token: "secret-value", __sidekickExposeSensitiveOnce: true });
const spoofedValue = JSON.parse(spoofed.content[0].text);
assert.strictEqual(spoofedValue.token, "[REDACTED]");
assert.strictEqual(spoofedValue.__sidekickExposeSensitiveOnce, true);

// Only a dispatcher-created in-memory envelope can cross the authorized path.
const factory = createFactory();
const envelope = factory({ token: "secret-value" });
const exposed = normalizeResult(envelope, { allowSensitiveOnce: true });
assert.strictEqual(JSON.parse(exposed.content[0].text).token, "secret-value");
assert.strictEqual(JSON.parse(normalizeResult(envelope, { allowSensitiveOnce: false }).content[0].text).value.token, "[REDACTED]");
assert.strictEqual(JSON.parse(normalizeResult(JSON.parse(JSON.stringify(envelope)), { allowSensitiveOnce: true }).content[0].text).value.token, "[REDACTED]");
console.log("Sensitive result boundary tests passed");
