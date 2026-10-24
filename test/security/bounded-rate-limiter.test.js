"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BoundedRateLimiter } = require("../../src/core/bounded-rate-limiter");

test("bounded rate limiter enforces a token bucket and calculates retry time", () => {
  const limiter = new BoundedRateLimiter({ limit: 2, windowMs: 2000, maxKeys: 4 });
  assert.deepEqual(limiter.consume("client-a", 0), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume("client-a", 0), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume("client-a", 0), { allowed: false, retryAfterMs: 1000 });
  assert.deepEqual(limiter.consume("client-a", 1000), { allowed: true, retryAfterMs: 0 });
});

test("bounded rate limiter caps client state and evicts the least recently used key", () => {
  const limiter = new BoundedRateLimiter({ limit: 3, windowMs: 1000, maxKeys: 2 });
  limiter.consume("client-a", 0);
  limiter.consume("client-b", 0);
  limiter.consume("client-a", 1);
  limiter.consume("client-c", 2);
  assert.equal(limiter.buckets.size, 2);
  assert.equal(limiter.buckets.has("client-a"), true);
  assert.equal(limiter.buckets.has("client-b"), false);
  assert.equal(limiter.buckets.has("client-c"), true);
});

test("bounded rate limiter clamps unsafe or malformed configuration", () => {
  const limiter = new BoundedRateLimiter({ limit: 1e30, windowMs: -5, maxKeys: 1e30 });
  assert.equal(limiter.limit, 100_000);
  assert.equal(limiter.windowMs, 1000);
  assert.equal(limiter.maxKeys, 100_000);
  const fallback = new BoundedRateLimiter({ limit: "not-a-number", windowMs: Infinity, maxKeys: NaN });
  assert.equal(fallback.limit, 1500);
  assert.equal(fallback.windowMs, 15 * 60 * 1000);
  assert.equal(fallback.maxKeys, 10_000);
});
