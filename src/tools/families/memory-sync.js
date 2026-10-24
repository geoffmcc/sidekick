"use strict";

const { z } = require("zod");
const { getStaticToolRisk } = require("../metadata");
const dbStore = require("../../db");
const { scopedProject } = require("./memory-scope");
const { requireCanonicalInvocation } = require("../read-authorization");

async function sidekick_sync_identity({ action, user_id }) {
  const denied = requireCanonicalInvocation("sync_identity");
  if (denied) return denied;
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
  const denied = requireCanonicalInvocation("sync_export");
  if (denied) return denied;
  let effectiveProject; try { effectiveProject = scopedProject(project, "read"); } catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  const options = {};
  if (effectiveProject) options.project = effectiveProject;
  if (since) options.since = since;
  if (include_disabled === false) options.includeDisabled = false;

  const data = dbStore.exportForSync(options);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function sidekick_sync_import({ data, strategy, preserve_ids, project }) {
  const denied = requireCanonicalInvocation("sync_import");
  if (denied) return denied;
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
  try { options.projectScope = scopedProject(project, "write"); } catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }

  const result = dbStore.importFromSync(parsed, options);
  const summary = `Sync complete: ${result.imported} imported as pending, ${result.conflicts} conflicts kept local, ${result.skipped} skipped`;
  const errors = result.errors?.length ? `\nErrors: ${result.errors.join(", ")}` : "";
  return { content: [{ type: "text", text: summary + errors }] };
}

async function sidekick_sync_diff({ since, project }) {
  const denied = requireCanonicalInvocation("sync_diff");
  if (denied) return denied;
  if (!since) {
    return { content: [{ type: "text", text: "since parameter required (ISO timestamp)" }], isError: true };
  }

  let effectiveProject;
  try { effectiveProject = scopedProject(project, "read"); }
  catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  const diff = dbStore.getSyncDiff(since, effectiveProject ? { project: effectiveProject } : {});
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
    risk: getStaticToolRisk("sync_identity"),
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
    risk: getStaticToolRisk("sync_export"),
    category: "Context & Learning",
    source: "builtin",
    family: "memory-sync",
    handler: sidekick_sync_export,
  }),
  Object.freeze({
    name: "sync_import",
    description: "Import memories from another machine's sync export. Imported records remain pending until explicitly confirmed; conflicts never overwrite local content or trust state.",
    schema: z.object({
      project: z.string().optional().describe("Project scope for imported memories"),
      data: z.string().describe("Sync export data from another machine (JSON string or object)"),
      strategy: z.enum(["newest", "highest_confidence", "most_confirmed", "merge", "skip"]).optional().describe("Legacy compatibility option. Conflicting local rows are always left unchanged."),
      preserve_ids: z.boolean().optional().describe("Preserve original memory IDs (default: false)"),
    }),
    args: { project: "string (optional project scope)", data: "string|object (sync export data)", strategy: "string (legacy conflict option; existing rows are never overwritten)", preserve_ids: "boolean (optional, preserve original IDs - default false)" },
    risk: "medium",
    category: "Context & Learning",
    source: "builtin",
    family: "memory-sync",
    handler: sidekick_sync_import,
  }),
  Object.freeze({
    name: "sync_diff",
    description: "Get list of memories changed since a given timestamp. Useful for incremental sync.",
    schema: z.object({ project: z.string().optional().describe("Project scope for changes"), since: z.string().describe("ISO timestamp - get changes after this time") }),
    args: { project: "string (optional project scope)", since: "string (ISO timestamp - get changes after this time)" },
    risk: getStaticToolRisk("sync_diff"),
    category: "Context & Learning",
    source: "builtin",
    family: "memory-sync",
    handler: sidekick_sync_diff,
  }),
]);

module.exports = { descriptors, sidekick_sync_identity, sidekick_sync_export, sidekick_sync_import, sidekick_sync_diff };
