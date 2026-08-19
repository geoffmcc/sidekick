"use strict";

// Process-local authentication throttling. Credentials are still verified by
// the identity/authentication layers; this is defense in depth against online
// guessing and intentionally stores only a bounded key and timestamps.
class AuthRateLimiter {
  constructor({ maxFailures = 5, windowMs = 15 * 60 * 1000, maxKeys = 10_000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.failures = new Map();
  }

  _prune(now = Date.now()) {
    for (const [key, timestamps] of this.failures) {
      const recent = timestamps.filter(timestamp => now - timestamp < this.windowMs);
      if (recent.length) this.failures.set(key, recent);
      else this.failures.delete(key);
    }
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next().value;
      this.failures.delete(oldest);
    }
  }

  check(key, now = Date.now()) {
    const normalized = String(key || "unknown");
    this._prune(now);
    const recent = (this.failures.get(normalized) || []).filter(timestamp => now - timestamp < this.windowMs);
    if (!recent.length) this.failures.delete(normalized);
    else this.failures.set(normalized, recent);
    if (recent.length < this.maxFailures) return { allowed: true, retryAfterMs: 0 };
    return { allowed: false, retryAfterMs: Math.max(1, this.windowMs - (now - recent[0])) };
  }

  recordFailure(key, now = Date.now()) {
    const normalized = String(key || "unknown");
    this._prune(now);
    const recent = (this.failures.get(normalized) || []).filter(timestamp => now - timestamp < this.windowMs);
    recent.push(now);
    this.failures.set(normalized, recent);
    this._prune(now);
    return this.check(normalized, now);
  }

  clear(key) {
    this.failures.delete(String(key || "unknown"));
  }
}

module.exports = { AuthRateLimiter };
