"use strict";

const { z } = require("zod");
const dbStore = require("../../db");

async function sidekick_sync_identity({ action, user_id }) {
  if (action === "get") {
    const machineId = dbStore.getMachineId();
    const userId = dbStore.getUserId();
    return { content: [{ type: "text", text: JSON.stringify({ machine_id: machineId, user_id: userId }) }] };
  }

  if (action === "set_user") {
    if (!user_id) {
      return { content: [{ type: "text", text: "user_id required" }], isError: true };
    }
    dbStore.setUserId(user_id);
    return { content: [{ type: "text", text: `User ID set to: ${user_id}` }] };
  }

  return { content: [{ type: "text", text: "Invalid action. Use 'get' or 'set_user'" }], isError: true };
}

async function sidekick_sync_export({ project, since, include_disabled }) {
  const options = {};
  if (project) options.project = project;
  if (since) options.since = since;
  if (include_disabled === false) options.includeDisabled = false;

  const data = dbStore.exportForSync(options);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function sidekick_sync_import({ data, strategy, preserve_ids }) {
  let parsed;
  try {
    parsed = typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    return { content: [{ type: "text", text: "Invalid JSON: " + e.message }], isError: true };
  }

  const options = {
    strategy: strategy || "newest",
    preserveIds: preserve_ids === true,
  };

  const result = dbStore.importFromSync(parsed, options);
  const summary = `Sync complete: ${result.imported} imported, ${result.conflicts} conflicts resolved, ${result.skipped} skipped`;
  const errors = result.errors?.length ? `\nErrors: ${result.errors.join(", ")}` : "";
  return { content: [{ type: "text", text: summary + errors }] };
}

async function sidekick_sync_diff({ since }) {
  if (!since) {
    return { content: [{ type: "text", text: "since parameter required (ISO timestamp)" }], isError: true };
  }

  const diff = dbStore.getSyncDiff(since);
  return { content: [{ type: "text", text: JSON.stringify(diff, null, 2) }] };
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "sync_identity",
    description: "Manage machine and user identity for cross-machine sync. Get or set machine_id and user_id.",
    schema: z.object({
      action: z.enum(["get", "set_user"]).describe("Action: get (show identity) or set_user (set user ID)"),
      user_id: z.string().optional().describe("User ID to set (required for set_user action)"),
    }),
    args: { action: "string (get|set_user)", user_id: "string (required for set_user action)" },
    risk: "low",
    category: "Context & Learning",
    source: "builtin",
    family: "memory-sync",
    handler: sidekick_sync_identity,
  }),
  Object.freeze({
    name: "sync_export",
    description: "Export memories for cross-machine sync. Includes origin tracking and sync metadata.",
    schema: z.object({
      project: z.string().optional().describe("Filter by project name"),
      since: z.string().optional().describe("ISO timestamp - only export memories updated after this time"),
      include_disabled: z.boolean().optional().describe("Include disabled memories (default: true)"),
    }),
    args: { project: "string (optional, filter by project)", since: "string (optional, ISO timestamp - only export memories updated after this time)", include_disabled: "boolean (optional, include disabled memories - default true)" },
    risk: "low",
    category: "Context & Learning",
    source: "builtin",
    family: "memory-sync",
    handler: sidekick_sync_export,
  }),
  Object.freeze({
    name: "sync_import",
    description: "Import memories from another machine's sync export. Supports conflict resolution strategies.",
    schema: z.object({
      data: z.string().describe("Sync export data from another machine (JSON string or object)"),
      strategy: z.enum(["newest", "highest_confidence", "most_confirmed", "merge", "skip"]).optional().describe("Conflict resolution strategy (default: newest)"),
      preserve_ids: z.boolean().optional().describe("Preserve original memory IDs (default: false)"),
    }),
    args: { data: "string|object (sync export data)", strategy: "string (optional, newest|highest_confidence|most_confirmed|merge|skip - default newest)", preserve_ids: "boolean (optional, preserve original IDs - default false)" },
    risk: "medium",
    category: "Context & Learning",
    source: "builtin",
    family: "memory-sync",
    handler: sidekick_sync_import,
  }),
  Object.freeze({
    name: "sync_diff",
    description: "Get list of memories changed since a given timestamp. Useful for incremental sync.",
    schema: z.object({ since: z.string().describe("ISO timestamp - get changes after this time") }),
    args: { since: "string (ISO timestamp - get changes after this time)" },
    risk: "low",
    category: "Context & Learning",
    source: "builtin",
    family: "memory-sync",
    handler: sidekick_sync_diff,
  }),
]);

module.exports = { descriptors, sidekick_sync_identity, sidekick_sync_export, sidekick_sync_import, sidekick_sync_diff };
