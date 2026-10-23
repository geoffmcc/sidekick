"use strict";

const MAX_KEYS_HARD_LIMIT = 100_000;
const MAX_LIMIT_HARD_LIMIT = 100_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

class BoundedRateLimiter {
  constructor({ limit = 1500, windowMs = 15 * 60 * 1000, maxKeys = 10_000 } = {}) {
    this.limit = boundedInteger(limit, 1500, 1, MAX_LIMIT_HARD_LIMIT);
    this.windowMs = boundedInteger(windowMs, 15 * 60 * 1000, 1000, MAX_WINDOW_MS);
    this.maxKeys = boundedInteger(maxKeys, 10_000, 1, MAX_KEYS_HARD_LIMIT);
    this.refillPerMs = this.limit / this.windowMs;
    this.buckets = new Map();
  }

  consume(key, now = Date.now()) {
    const normalized = String(key || "unknown").slice(0, 256);
    let bucket = this.buckets.get(normalized);
    if (bucket) {
      this.buckets.delete(normalized);
      const elapsedMs = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(this.limit, bucket.tokens + elapsedMs * this.refillPerMs);
      bucket.updatedAt = Math.max(now, bucket.updatedAt);
    } else {
      if (this.buckets.size >= this.maxKeys) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
      bucket = { tokens: this.limit, updatedAt: now };
    }

    if (bucket.tokens < 1) {
      this.buckets.set(normalized, bucket);
      return {
        allowed: false,
        retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs)),
      };
    }

    bucket.tokens -= 1;
    this.buckets.set(normalized, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }
}

module.exports = { BoundedRateLimiter, MAX_KEYS_HARD_LIMIT, MAX_LIMIT_HARD_LIMIT, MAX_WINDOW_MS };
