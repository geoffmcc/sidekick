"use strict";

// Connector tool family: connector (read-only operator visibility).
//
// Surfaces the platform connector authority (platform_connectors + the kernel
// connector API) so an operator can see registered connectors, their state,
// endpoint, capabilities, health, and recent lifecycle events without editing
// source or reading the database. Read-only by design: registration/config/
// enable/disable stay on the governed dashboard + kernel path (a mutating
// connector tool is a deliberate future step, not part of this surface).
//
// Credential references are never exposed: a connector's secret_ref is reduced
// to `has_secret_ref` (boolean), mirroring how compute providers expose only
// `hasAuth`.

const { z } = require("zod");
const platformKernel = require("../../platform/kernel");
const { probeConnector } = require("../../connectors/health");

let kernel = null;
try { kernel = require("../../platform/kernel"); } catch { kernel = null; }

// Safe projection: drop the raw secret_ref; report only whether one is set.
function safeConnector(connector) {
  if (!connector) return null;
  const { secret_ref, secret_ref: _omit, ...rest } = connector;
  return {
    ...rest,
    has_secret_ref: Boolean(secret_ref),
  };
}

async function sidekick_connector({ action = "list", connector_id, type, state, limit }) {
  if (!kernel || typeof kernel.listConnectors !== "function") {
    return { content: [{ type: "text", text: "Connector authority unavailable" }], isError: true };
  }
  try {
    if (action === "list") {
      const connectors = kernel.listConnectors({
        ...(type ? { type } : {}),
        ...(state ? { state } : {}),
        ...(Number.isInteger(limit) ? { limit } : {}),
      }).map(safeConnector);
      return { content: [{ type: "text", text: JSON.stringify({ connectors }, null, 2) }] };
    }
    if (action === "get") {
      if (!connector_id) return { content: [{ type: "text", text: "connector_id required" }], isError: true };
      const connector = kernel.getConnector(connector_id);
      if (!connector) return { content: [{ type: "text", text: "Connector not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(safeConnector(connector), null, 2) }] };
    }
    if (action === "events") {
      if (!connector_id) return { content: [{ type: "text", text: "connector_id required" }], isError: true };
      const events = kernel.listConnectorEvents(connector_id, Number.isInteger(limit) ? limit : 20);
      return { content: [{ type: "text", text: JSON.stringify({ events }, null, 2) }] };
    }
    if (action === "health") {
      if (!connector_id) return { content: [{ type: "text", text: "connector_id required" }], isError: true };
      const connector = kernel.getConnector(connector_id);
      if (!connector) return { content: [{ type: "text", text: "Connector not found" }], isError: true };
      const health = await probeConnector(connector);
      const recorded = platformKernel.recordConnectorHealth(connector.connector_id, health);
      return { content: [{ type: "text", text: JSON.stringify({ connector: safeConnector(recorded.connector), health: recorded.health }, null, 2) }], isError: !recorded.ok };
    }
    return { content: [{ type: "text", text: "Unknown action: " + action + ". Valid: list, get, events, health" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "connector error: " + e.message }], isError: true };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "connector",
    description: "Inspect and health-check the platform connector authority: list registered connectors, get one, run a bounded provider health probe, or read lifecycle events. Credential references are never exposed (only has_secret_ref)",
    schema: z.object({
      action: z.enum(["list", "get", "events", "health"]).optional().default("list").describe("Connector action"),
      connector_id: z.string().optional().describe("Connector id (required for get/events)"),
      type: z.string().optional().describe("Filter by connector type (list)"),
      state: z.string().optional().describe("Filter by lifecycle state (list)"),
      limit: z.number().int().optional().describe("Max rows/events"),
    }),
    args: {
      action: "string (list|get|events|health - default list)",
      connector_id: "string (required for get/events/health)",
      type: "string (optional, filter by type for list)",
      state: "string (optional, filter by state for list)",
      limit: "number (optional, max rows/events)",
    },
    risk: "medium",
    category: "Services",
    source: "builtin",
    family: "connectors",
    handler: sidekick_connector,
  }),
]);

module.exports = { descriptors, sidekick_connector };
