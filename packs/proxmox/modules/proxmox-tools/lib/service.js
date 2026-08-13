"use strict";

/**
 * Session and task-lifecycle helpers shared by every Proxmox operation.
 *
 * `openSession` is the one place a profile, its credential and a bound client
 * come together; a handler never touches the secret store or the raw client
 * construction directly. `pollTask` implements Proxmox's asynchronous task
 * model correctly: an operation is not "done" because the API accepted it —
 * it is done when its UPID reaches a terminal state, and the outcome comes from
 * `exitstatus`, not from the request returning 200.
 */

const { createClient } = require("./client");
const { ProxmoxError } = require("./errors");
const profiles = require("./profiles");
const normalize = require("./normalize");

/** Resolve a profile + credential and return a bound client. */
function openSession(config, name, signal) {
  const resolved = profiles.resolveProfile(config, name);
  if (!resolved.ok) return resolved;
  const cred = profiles.resolveCredential(resolved.profile);
  if (!cred.ok) return cred;
  const profile = { ...resolved.profile, ca_pem: cred.ca_pem };
  const client = createClient({ profile, token: cred.token, signal });
  return { ok: true, client, profile };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new ProxmoxError("network_timeout", "cancelled"));
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new ProxmoxError("network_timeout", "cancelled"));
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll a task UPID until it reaches a terminal state or the time budget runs
 * out. Auth/permission failures during polling are TERMINAL, not transient:
 * if the token was revoked mid-operation the task may still complete
 * server-side, but the client cannot know that, so it must stop rather than
 * loop on a permanent 401/403.
 */
async function pollTask(client, node, upid, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const intervalMs = options.intervalMs || 1000;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;
  let last = null;

  // Monotonic wall-clock is intentional: task waits are real elapsed time.
  while (Date.now() < deadline) {
    let status;
    try {
      status = await client.get(["nodes", node, "tasks", upid, "status"]);
    } catch (error) {
      if (error instanceof ProxmoxError && (error.code === "auth_failed" || error.code === "permission_denied")) {
        throw error; // terminal
      }
      // transient read failure: brief backoff, then retry within the budget
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
      continue;
    }
    last = normalize.taskOutcome(status);
    if (!last.running) {
      return {
        terminal: true,
        ok: last.ok,
        exit_status: last.exitstatus,
        upid,
        node,
      };
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
  }
  throw new ProxmoxError("task_timeout", `Task did not reach a terminal state within ${timeoutMs}ms`, {
    upid,
    node,
    last_status: last ? last.exitstatus : null,
  });
}

/**
 * Recognize a Proxmox API error that actually means "this optional feature is
 * not installed/configured on the cluster", as opposed to a real failure.
 * Verified against live hardware: Ceph without packages returns a 500 with
 * "binary not installed: /usr/bin/ceph-mon"; a guest without the agent returns
 * "No QEMU guest agent configured".
 */
function isFeatureAbsent(error) {
  if (!(error instanceof ProxmoxError)) return false;
  if (error.code === "resource_missing") return true;
  const message = String(error.message || "");
  return /binary not installed|not installed|no such file|not configured|no .* configured|unable to (load|find)/i.test(message);
}

module.exports = { openSession, pollTask, isFeatureAbsent, sleep };
