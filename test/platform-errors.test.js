const assert = require("assert");
const { PlatformError, asPlatformError } = require("../src/core/errors");

const error = new PlatformError("policy_denied", "Denied", { subsystem: "dashboard", correlationId: "req-1", details: { reason: "restricted" } });
assert.deepStrictEqual(error.toJSON(), { code: "policy_denied", message: "Denied", retryable: false, http_status: 403, subsystem: "dashboard", correlation_id: "req-1", details: { reason: "restricted" }, audit_classification: "policy_denied" });
assert.strictEqual(asPlatformError(new Error("secret token"), "provider_failed").message, "The operation could not be completed");
assert.strictEqual(asPlatformError(new Error("x"), "provider_failed").httpStatus, 502);
console.log("Platform error taxonomy checks passed");
