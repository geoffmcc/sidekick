"use strict";

const { sanitize } = require("./reports");

const TERMINAL_STATES = new Set(["completed", "partial", "failed", "cancelled", "timed_out", "blocked"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_POLL_MS = 5000;
const MAX_CANCEL_AFTER_POLLS = 1000;

function validateBaseUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("certification Agent URL is invalid"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.has(hostname) || url.username || url.password) {
    throw new Error("certification Agent URL must target a loopback host");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  url.search = "";
  url.hash = "";
  return url;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function taskIdFrom(body) {
  const id = body && (body.taskId || body.task_id || body.task?.task_id);
  if (typeof id !== "string" || !id || id.length > 180) throw new Error("Agent creation response did not contain a bounded task id");
  return id;
}

function dispatchCounts(projection) {
  const supplied = projection.dispatch_counts || projection.dispatchCounts || projection.task?.dispatch_counts;
  if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) return supplied;
  const counts = { total: 0, completed: 0, failed: 0, cancelled: 0 };
  const receipts = Array.isArray(projection.receipts) ? projection.receipts : [];
  const events = receipts.length ? [] : (Array.isArray(projection.events) ? projection.events : []);
  for (const item of [...receipts, ...events]) {
    const type = String(item.event_type || item.dispatch_state || item.outcome_state || "").toLowerCase();
    if (!receipts.length && !type.includes("dispatch")) continue;
    counts.total++;
    if (type.includes("cancel")) counts.cancelled++;
    else if (type.includes("fail")) counts.failed++;
    else if (type.includes("final") || type.includes("success") || type.includes("complete")) counts.completed++;
  }
  return counts;
}

function observation(taskId, projection, extra = {}) {
  const task = projection.task || {};
  return sanitize({
    task_id: taskId,
    state: task.state || "unknown",
    result: task.result ?? null,
    receipts: Array.isArray(projection.receipts) ? projection.receipts : [],
    events: Array.isArray(projection.events) ? projection.events : [],
    dispatch_counts: dispatchCounts(projection),
    source: projection.source || "durable_task_store",
    ...extra,
  });
}

function createLifecycleExecutor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 120000, pollMs = 250, headers = {} } = {}) {
  const root = validateBaseUrl(baseUrl);
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for certification Agent lifecycle");
  const timeout = boundedNumber(timeoutMs, 120000, 1000, MAX_TIMEOUT_MS);
  const interval = boundedNumber(pollMs, 250, 0, MAX_POLL_MS);
  const configuredHeaders = { ...headers };
  if (Object.keys(configuredHeaders).some(name => /fault|inject/i.test(name))) throw new Error("fault injection is not available to certification callers");

  async function request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(new URL(pathname, root), {
        ...options,
        signal: controller.signal,
        headers: { accept: "application/json", ...configuredHeaders, ...(options.headers || {}) },
      });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("certification Agent response exceeds the size bound");
      let body;
      try { body = JSON.parse(text); } catch { throw new Error("certification Agent returned invalid JSON"); }
      if (!response.ok) throw new Error(`certification Agent request failed with HTTP ${response.status}: ${sanitize(String(body.error || "request failed")).slice(0, 300)}`);
      return body;
    } finally { clearTimeout(timer); }
  }

  async function cancel(taskId) {
    await request(`/api/agent/run/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
    return { task_id: taskId, requested: true };
  }

  return Object.freeze({
    async available() {
      try { return (await request("/api/health")).ok === true; } catch { return false; }
    },
    cancel,
    async run(scenario, { cancelAfterPolls = null } = {}) {
      if (!scenario || typeof scenario.objective !== "string" || !scenario.objective.trim()) throw new Error("certification scenario objective is required");
      if (Object.keys(scenario).some(key => /fault|inject/i.test(key))) throw new Error("fault injection is not available to certification callers");
      const cancelAt = cancelAfterPolls == null ? null : boundedNumber(cancelAfterPolls, 1, 1, MAX_CANCEL_AFTER_POLLS);
      const created = await request("/api/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: scenario.objective,
          profile: "standard",
          project: scenario.required_initial_state?.project || null,
          workspace_ref: scenario.required_initial_state?.workspace || null,
          authority_envelope: { changes_allowed: false, external_effects_allowed: false, allowed_effects: ["read_only"], child_task_count: 0 },
        }),
      });
      const taskId = taskIdFrom(created);
      const deadline = Date.now() + timeout;
      let polls = 0;
      let cancellation = null;
      let lastProjection = null;
      while (Date.now() <= deadline) {
        lastProjection = await request(`/api/agent/tasks/${encodeURIComponent(taskId)}/control-room`);
        polls++;
        const state = lastProjection.task?.state;
        if (TERMINAL_STATES.has(state)) return observation(taskId, lastProjection, { polls, cancellation });
        if (cancelAt !== null && polls >= cancelAt && !cancellation) cancellation = await cancel(taskId);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)));
      }
      return observation(taskId, lastProjection || {}, { polls, cancellation, timeout: true });
    },
  });
}

function createLifecycleExecutorFromEnv(env = process.env) {
  if (!env.SIDEKICK_CERTIFICATION_AGENT_URL) return null;
  return createLifecycleExecutor({
    baseUrl: env.SIDEKICK_CERTIFICATION_AGENT_URL,
    headers: env.SIDEKICK_API_KEY ? { "x-api-key": env.SIDEKICK_API_KEY } : {},
    timeoutMs: env.SIDEKICK_CERTIFICATION_TIMEOUT_MS,
  });
}

async function runAgentLifecycle(options) {
  const { scenario, ...executorOptions } = options || {};
  return createLifecycleExecutor(executorOptions).run(scenario, options || {});
}

module.exports = {
  TERMINAL_STATES,
  MAX_RESPONSE_BYTES,
  createLifecycleExecutor,
  createLifecycleExecutorFromEnv,
  // Compatibility names kept inside the certification module while callers
  // migrate to the lifecycle-specific API.
  createLiveAgentExecutor: createLifecycleExecutor,
  createLiveAgentExecutorFromEnv: createLifecycleExecutorFromEnv,
  runAgentLifecycle,
};
