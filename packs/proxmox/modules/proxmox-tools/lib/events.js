"use strict";

/**
 * Domain events for consequential Proxmox operations.
 *
 * The authoritative provenance marker lives ON the guest (tags + description,
 * see lib/provenance.js), so it survives regardless of Sidekick's own state.
 * On top of that, each consequential operation emits ONE platform event through
 * the same kernel the server uses, giving Sidekick a durable, queryable record
 * of what it created, changed or removed — correlated to the run that did it.
 *
 * This is deliberately additive to the dispatcher's automatic tool_logs audit
 * (which records the call, redacted): tool_logs is operational telemetry with a
 * bounded summary, not a resource registry. The event carries the structured
 * resource identity (vmid@profile, node, marker, run) that a later cleanup or
 * audit needs.
 *
 * Emission is best-effort: a resource operation that succeeded must not be
 * reported as failed because the event sink was unavailable. Events never carry
 * secrets — only resource facts.
 */

const { requireSidekickSrc } = require("./deps");

let kernel = null;
function getKernel() {
  if (kernel === null) {
    try {
      kernel = requireSidekickSrc("src/platform/kernel.js");
    } catch {
      kernel = false; // resolved-but-unavailable
    }
  }
  return kernel || null;
}

/**
 * Emit a proxmox.* domain event. `context` is the handler's runtime context
 * (source, correlationId, executionId, project, actor). Returns
 * { recorded, event_id? } and never throws.
 */
function recordResourceEvent(context, { type, profile, node, vmid, kind, name, marker, run, result, severity = "info", extra = {} }) {
  const k = getKernel();
  if (!k || typeof k.appendEvent !== "function") return { recorded: false };
  const ctx = context || {};
  try {
    const event = k.appendEvent({
      event_type: `proxmox.${type}`,
      source: "proxmox-pack",
      actor_id: ctx.actor || ctx.source || null,
      subject_type: "proxmox_guest",
      subject_id: vmid != null && profile ? `${vmid}@${profile}` : profile || null,
      project_id: ctx.project || null,
      execution_id: ctx.executionId || null,
      correlation_id: ctx.correlationId || run || null,
      severity,
      payload: {
        profile: profile || null,
        node: node || null,
        vmid: vmid != null ? vmid : null,
        kind: kind || null,
        name: name || null,
        marker: marker || null,
        run: run || ctx.correlationId || null,
        result: result || null,
        ...extra,
      },
    });
    return { recorded: true, event_id: event && (event.id || event.event_id) ? event.id || event.event_id : null };
  } catch {
    return { recorded: false };
  }
}

module.exports = { recordResourceEvent };
