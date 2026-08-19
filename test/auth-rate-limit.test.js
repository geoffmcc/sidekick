"use strict";

const assert = require("assert");
const { AuthRateLimiter } = require("../src/core/auth-rate-limit");

const limiter = new AuthRateLimiter({ maxFailures: 2, windowMs: 1_000, maxKeys: 2 });
assert.deepStrictEqual(limiter.check("ip|user", 0).allowed, true);
limiter.recordFailure("ip|user", 0);
assert.strictEqual(limiter.check("ip|user", 500).allowed, true);
limiter.recordFailure("ip|user", 500);
const blocked = limiter.check("ip|user", 600);
assert.strictEqual(blocked.allowed, false);
assert.ok(blocked.retryAfterMs > 0);
assert.strictEqual(limiter.check("ip|other", 600).allowed, true, "rate limits must be keyed per identity");
limiter.clear("ip|user");
assert.strictEqual(limiter.check("ip|user", 600).allowed, true, "successful authentication must clear failures");
assert.strictEqual(limiter.check("ip|user", 1_100).allowed, true, "failures expire after the window");
console.log("Authentication rate-limit checks passed.");
