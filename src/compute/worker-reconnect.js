// Worker reconnection policy (Phase 6).
//
// Pure, dependency-free helpers that classify request outcomes and compute
// backoff delays so the worker can ride out server outages/restarts without
// dying, while stopping cleanly on genuinely terminal conditions.
//
// Classification:
//   ok        — success (2xx); reset backoff.
//   transient — retryable (network error/timeout, 408/429, any 5xx, and
//               unexpected 4xx we don't recognize): keep retrying with backoff.
//   permanent — terminal for an enrolled worker (401/403 = credential revoked or
//               invalid; 426 = protocol incompatible): stop, do not spin.

const OK = "ok";
const TRANSIENT = "transient";
const PERMANENT = "permanent";

// Classify an HTTP status. `enrolled` distinguishes an auth rejection during the
// run loop (terminal — our credential is bad) from one during enrollment
// (retryable — the token exchange may just be racing a slow server).
function classifyStatus(status, { enrolled = true } = {}) {
  if (status >= 200 && status < 300) return OK;
  if (status === 426) return PERMANENT;
  if ((status === 401 || status === 403) && enrolled) return PERMANENT;
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return TRANSIENT;
  // Unexpected 4xx (400/404/409, ...): stay conservative and keep retrying.
  return TRANSIENT;
}

// Thrown request errors (ECONNREFUSED, timeouts, DNS, socket resets) are always
// transient — the server may simply be down or restarting.
function classifyError() {
  return TRANSIENT;
}

// Exponential backoff with jitter, capped at maxMs. Deterministic bounds:
// the returned delay is always in [min(maxMs, baseMs*factor^attempt),
// min(maxMs, baseMs*factor^attempt*(1+jitterRatio))].
function nextBackoff(attempt, { baseMs = 2000, maxMs = 30000, factor = 2, jitterRatio = 0.2 } = {}) {
  const safeAttempt = Math.max(0, Math.trunc(attempt) || 0);
  const base = Math.min(maxMs, baseMs * Math.pow(factor, safeAttempt));
  const jitter = Math.floor(base * jitterRatio * Math.random());
  return Math.min(maxMs, base + jitter);
}

module.exports = { OK, TRANSIENT, PERMANENT, classifyStatus, classifyError, nextBackoff };
