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
    return { content: [{ type: "text", text: "Unknown action: " + action + ". Valid: list, get, events" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "connector error: " + e.message }], isError: true };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "connector",
    description: "Inspect the platform connector authority: list registered connectors (GitHub, ...), get one by id, or read recent lifecycle events. Read-only; credential references are never exposed (only has_secret_ref)",
    schema: z.object({
      action: z.enum(["list", "get", "events"]).optional().default("list").describe("Connector action"),
      connector_id: z.string().optional().describe("Connector id (required for get/events)"),
      type: z.string().optional().describe("Filter by connector type (list)"),
      state: z.string().optional().describe("Filter by lifecycle state (list)"),
      limit: z.number().int().optional().describe("Max rows/events"),
    }),
    args: {
      action: "string (list|get|events - default list)",
      connector_id: "string (required for get/events)",
      type: "string (optional, filter by type for list)",
      state: "string (optional, filter by state for list)",
      limit: "number (optional, max rows/events)",
    },
    risk: "low",
    category: "Services",
    source: "builtin",
    family: "connectors",
    handler: sidekick_connector,
  }),
]);

module.exports = { descriptors, sidekick_connector };
