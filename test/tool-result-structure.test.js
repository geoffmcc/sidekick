"use strict";

const assert = require("assert");
const { normalizeResult } = require("../src/tools/result");

const result = normalizeResult({
  schema: { pattern: "^secret=[REDACTED]\n" },
  credential_ref: "secret:fixture",
});
const parsed = JSON.parse(result.content[0].text);
assert.strictEqual(parsed.credential_ref, "[REDACTED]");
assert.strictEqual(parsed.schema.pattern, "^secret=[REDACTED]\n");
console.log("Structured result redaction preserves valid JSON");
