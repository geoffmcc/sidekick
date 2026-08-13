"use strict";

/**
 * Guest lifecycle write operations: start, graceful shutdown, reboot.
 *
 * The deliberately small, controlled set. Each operation:
 *
 *  1. Checks that the profile permits lifecycle changes at all
 *     (`allow_lifecycle`), so an admin can configure a read-only profile.
 *  2. Resolves the guest and inspects CURRENT state, so an already-running
 *     start or an already-stopped shutdown returns a meaningful no-op rather
 *     than a confusing API failure (idempotency).
 *  3. Submits the operation, obtains the UPID, and MONITORS the task to a
 *     terminal state — success is derived from the task's exitstatus, never
 *     from the submit call returning 200.
 *  4. NEVER replays a mutation after an ambiguous failure. The POST path in the
 *     client does not retry; a timed-out submit surfaces as an ambiguous error
 *     the caller must resolve by inspecting state.
 *
 * Not included in this release, by design: hard stop, reset, suspend, delete,
 * clone, migrate, snapshot, and any configuration mutation. Absence is safer
 * than unverified breadth.
 */

const { ProxmoxError } = require("./errors");
const { pollTask } = require("./service");
const operations = require("./operations");
const normalize = require("./normalize");

const ACTIONS = Object.freeze({
  start: { path: "start", verb: "start" },
  shutdown: { path: "shutdown", verb: "shut down" },
  reboot: { path: "reboot", verb: "reboot" },
});

async function currentState(client, node, kind, vmid) {
  const status = await client.get(["nodes", node, kind, vmid, "status", "current"]);
  return { status: normalize.str(status.status), template: normalize.bool(status.template) };
}

/**
 * Perform a lifecycle action. Returns a structured result describing the
 * decision made (no-op vs submitted), the task, and the final state.
 */
async function performAction(client, profile, { action, vmid, wait }) {
  const spec = ACTIONS[action];
  if (!spec) throw new ProxmoxError("unsupported_operation", `Unsupported lifecycle action "${action}"`);
  if (!profile.allow_lifecycle) {
    throw new ProxmoxError("lifecycle_disabled", `Profile "${profile.name}" does not permit lifecycle operations. An administrator must set allow_lifecycle: true on this profile to enable start/shutdown/reboot.`);
  }

  const located = await operations.findGuest(client, vmid);
  const { node } = located;
  const kind = located.type;
  const state = await currentState(client, node, kind, vmid);

  if (state.template) {
    throw new ProxmoxError("unsupported_operation", `VMID ${vmid} is a template; lifecycle operations do not apply to templates.`, { vmid, node });
  }

  // Idempotency / state guards.
  if (action === "start" && state.status === "running") {
    return { action, vmid, node, type: kind, outcome: "already_running", changed: false, task: null, final_status: "running" };
  }
  if (action === "shutdown" && state.status === "stopped") {
    return { action, vmid, node, type: kind, outcome: "already_stopped", changed: false, task: null, final_status: "stopped" };
  }
  if (action === "reboot" && state.status !== "running") {
    throw new ProxmoxError("guest_not_running", `Cannot reboot VMID ${vmid}: it is ${state.status}, not running.`, { vmid, node, status: state.status });
  }

  // Submit the task. POSTs never auto-retry (see client): after an ambiguous
  // failure we must not replay a power operation.
  const upid = await client.post(["nodes", node, kind, vmid, "status", spec.path]);
  if (typeof upid !== "string" || !upid.startsWith("UPID:")) {
    throw new ProxmoxError("api_error", `Proxmox did not return a task id for the ${spec.verb} operation.`, { vmid, node });
  }

  const base = { action, vmid, node, type: kind, outcome: "submitted", changed: true, task: { upid } };
  if (wait === false) {
    return { ...base, outcome: "submitted", monitored: false, note: "Operation submitted; not waited on. Use the read tool's task_status action with this upid to confirm completion." };
  }

  // Monitor to terminal state. Graceful shutdown/reboot depend on the guest
  // ACPI/agent responding; a guest without it will not complete and surfaces
  // as task_timeout, which is the correct, honest outcome — not a false success.
  try {
    const terminal = await pollTask(client, node, upid, { timeoutMs: profile.task_timeout_ms, intervalMs: profile.task_poll_interval_ms });
    const finalState = await currentState(client, node, kind, vmid).catch(() => ({ status: null }));
    return {
      ...base,
      monitored: true,
      task: { upid, ok: terminal.ok, exit_status: terminal.exit_status },
      outcome: terminal.ok ? "completed" : "task_failed",
      final_status: finalState.status,
    };
  } catch (error) {
    if (error instanceof ProxmoxError && error.code === "task_timeout") {
      return {
        ...base,
        monitored: true,
        outcome: "task_timeout",
        task: { upid, ok: null },
        note: action === "start"
          ? "The start task did not reach a terminal state within the timeout."
          : `A graceful ${spec.verb} requires the guest OS (ACPI) or QEMU guest agent to respond. If the guest lacks these, the task will not complete; this is not a hard power-off.`,
      };
    }
    throw error;
  }
}

module.exports = { performAction, ACTIONS };
