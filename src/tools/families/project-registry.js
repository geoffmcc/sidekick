"use strict";

// Project-registry tool family: project_registry.
//
// First invocation surface (B3-PR4) for the platform project registry that
// landed with migration 027: registerProject/getProject/listProjects/
// archiveProject/getProjectSources/backfillProjectSources previously had zero
// production callers. Read actions are plain lookups; register/archive are
// operator writes routed through the dispatcher's policy/approval layer; the
// backfill scan defaults to dry_run and requires confirm:true to write.
// Never imports tools-legacy.js.

const { z } = require("zod");
const platformKernel = require("../../platform/kernel");
const { canonicalizeProjectName } = require("../../core/project-identity");
const { getExecutionSource } = require("../context");

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function sidekick_project_registry({ action, project, state, limit, display_name, description, reason, confirm, dry_run }) {
  try {
    switch (action) {
      case "list": {
        const projects = platformKernel.listProjects({ state, limit });
        return textResult(JSON.stringify({ count: projects.length, projects }, null, 2));
      }
      case "get": {
        if (!project) return errorResult("project required for get");
        const row = platformKernel.getProject(project);
        if (!row) return errorResult(`Project not found: ${project}`);
        return textResult(JSON.stringify(row, null, 2));
      }
      case "register": {
        if (!project) return errorResult("project required for register");
        const row = platformKernel.registerProject({
          project_id: project,
          display_name,
          description,
          source: getExecutionSource(),
        });
        return textResult(JSON.stringify(row, null, 2));
      }
      case "archive": {
        if (!project) return errorResult("project required for archive");
        const row = platformKernel.archiveProject(project, { source: getExecutionSource(), reason });
        return textResult(JSON.stringify(row, null, 2));
      }
      case "sources": {
        if (!project) return errorResult("project required for sources");
        const sources = platformKernel.getProjectSources(project);
        return textResult(JSON.stringify({ project: canonicalizeProjectName(project), count: sources.length, sources }, null, 2));
      }
      case "backfill": {
        // Writes are opt-in twice over: dry_run defaults to true, and a real
        // run additionally requires confirm:true so a bare backfill call can
        // never mutate the registry. confirm attests to the operation, not to
        // a specific reviewed row set — the real run re-scans the stores.
        const dryRun = dry_run !== false;
        if (!dryRun && confirm !== true) {
          return errorResult("backfill with dry_run=false requires confirm:true (run the default dry_run first and review the counts)");
        }
        const result = platformKernel.backfillProjectSources({ source: getExecutionSource(), dry_run: dryRun });
        const label = dryRun ? "Dry run (no writes)" : "Backfill complete";
        return textResult(`${label}: ${result.written} project-source rows${dryRun ? " would be" : ""} written\n${JSON.stringify(result, null, 2)}`);
      }
      default:
        return errorResult("Unknown action. Use: list, get, register, archive, sources, backfill");
    }
  } catch (e) {
    return errorResult("Error: " + e.message);
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "project_registry",
    description: "Canonical project registry: list, inspect, register, and archive projects and their recorded data sources; backfill project sources from existing stores (dry-run by default)",
    schema: z.object({
      action: z.enum(["list", "get", "register", "archive", "sources", "backfill"]).describe("Registry action"),
      project: z.string().optional().describe("Project id (required for get/register/archive/sources; canonicalized)"),
      state: z.enum(["active", "archived"]).optional().describe("Filter by state (list)"),
      limit: z.number().int().positive().max(1000).optional().describe("Max results (list)"),
      display_name: z.string().max(200).optional().describe("Display name (register)"),
      description: z.string().max(2000).optional().describe("Description (register)"),
      reason: z.string().max(500).optional().describe("Reason (archive)"),
      confirm: z.boolean().optional().describe("Required true for backfill with dry_run=false"),
      dry_run: z.boolean().optional().describe("Backfill only reports counts without writing (default true)"),
    }),
    args: { action: "string (list|get|register|archive|sources|backfill)", project: "string (project id; required for get/register/archive/sources)", state: "string (optional, filter by state for list: active|archived)", limit: "number (optional, max results for list)", display_name: "string (optional, for register)", description: "string (optional, for register)", reason: "string (optional, for archive)", confirm: "boolean (required true for backfill with dry_run=false)", dry_run: "boolean (optional, for backfill - default true, report without writing)" },
    risk: "high",
    category: "Storage",
    source: "builtin",
    family: "project-registry",
    handler: sidekick_project_registry,
  }),
]);

module.exports = { descriptors, sidekick_project_registry };
