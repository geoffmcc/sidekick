"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const { scopedProject } = require("./memory-scope");

async function sidekick_memory_export({ project, type, include_disabled, automatic_only }) {
  let effectiveProject; try { effectiveProject = scopedProject(project); } catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  const options = {};
  if (effectiveProject) options.project = effectiveProject;
  if (type) options.type = type;
  if (include_disabled === false) options.includeDisabled = false;
  if (automatic_only === true) options.automatic = true;

  const result = dbStore.exportMemories(options);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function sidekick_memory_import({ data, on_conflict, preserve_ids }) {
  let parsed;
  try {
    parsed = typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    return { content: [{ type: "text", text: "Invalid JSON: " + e.message }], isError: true };
  }

  const options = {
    onConflict: on_conflict || "merge",
    preserveIds: preserve_ids === true,
  };
  try { options.projectScope = scopedProject(); } catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }

  const result = dbStore.importMemories(parsed, options);
  const summary = `Import complete: ${result.imported} imported, ${result.updated || 0} updated, ${result.skipped} skipped`;
  const errors = result.errors?.length ? `\nErrors: ${result.errors.join(", ")}` : "";
  return { content: [{ type: "text", text: summary + errors }] };
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "memory_export",
    description: "Export structured memories to JSON for backup, portability, or machine-to-machine transfer.",
    schema: z.object({
      project: z.string().optional().describe("Filter by project name"),
      type: z.string().optional().describe("Filter by memory type (fact, decision, preference, etc.)"),
      include_disabled: z.boolean().optional().describe("Include disabled memories (default: true)"),
      automatic_only: z.boolean().optional().describe("Only include automatic memories (default: false)"),
    }),
    args: { project: "string (optional, filter by project)", type: "string (optional, filter by memory type)", include_disabled: "boolean (optional, include disabled memories - default true)", automatic_only: "boolean (optional, only automatic memories - default false)" },
    risk: "low",
    category: "Context & Learning",
    source: "builtin",
    family: "memory-portability",
    handler: sidekick_memory_export,
  }),
  Object.freeze({
    name: "memory_import",
    description: "Import memories from JSON export. Supports merge (update existing) or skip conflict modes.",
    schema: z.object({
      data: z.string().describe("JSON export data (string or object)"),
      on_conflict: z.enum(["merge", "skip"]).optional().describe("Conflict resolution: merge (update existing) or skip (default: merge)"),
      preserve_ids: z.boolean().optional().describe("Preserve original memory IDs (default: false)"),
    }),
    args: { data: "string|object (JSON export data or parsed object)", on_conflict: "string (optional, merge|skip - default merge)", preserve_ids: "boolean (optional, preserve original IDs - default false)" },
    risk: "medium",
    category: "Context & Learning",
    source: "builtin",
    family: "memory-portability",
    handler: sidekick_memory_import,
  }),
]);

module.exports = { descriptors, sidekick_memory_export, sidekick_memory_import };
