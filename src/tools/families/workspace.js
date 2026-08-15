"use strict";

// Workspace tool family: workspace.
//
// First invocation surface for the platform project-workspace store and its
// encrypted secrets (the audit's "production-complete impl, foundation-only
// deployment" row): createProjectWorkspace/getProjectWorkspace/
// updateProjectWorkspace/setWorkspaceSecret/deleteWorkspaceSecret/
// backfillWorkspaceSecrets previously had zero production callers. Modeled on
// src/tools/families/project-registry.js: reads are plain lookups, writes are
// operator actions routed through the dispatcher's policy/approval layer, and
// the secrets backfill defaults to dry_run and requires confirm:true to write.
//
// Secret VALUES never leave the kernel through this surface: get/list expose
// secret NAMES only (normalizeWorkspace strips envelopes and legacy
// plaintext), and there is deliberately no get_secret action. Secret writes
// fail closed without SIDEKICK_SECRET_KEY — the kernel throws and this tool
// surfaces that error honestly instead of downgrading to plaintext.
// Never imports tools-legacy.js.

const { z } = require("zod");
const platformKernel = require("../../platform/kernel");
const { getExecutionContext, getExecutionSource } = require("../context");

function canonicalProject(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

function scopedProject() {
  const project = getExecutionContext().project;
  return project ? canonicalProject(project) : null;
}

function assertProjectAccess(row, requestedProject) {
  const current = scopedProject();
  const requested = requestedProject ? canonicalProject(requestedProject) : null;
  if (current && requested && requested !== current) throw new Error(`Workspace project ${requested} is outside the execution project ${current}`);
  if (current && row && row.project_id !== current) throw new Error(`Workspace project ${row.project_id} is outside the execution project ${current}`);
  return current;
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function sidekick_workspace({ action, workspace_id, project, name, config, environment, resource_limits, metadata, secret_name, secret_value, state, limit, confirm, dry_run }) {
  try {
    switch (action) {
      case "list": {
        const current = assertProjectAccess(null, project);
        const workspaces = platformKernel.listProjectWorkspaces({ state, project_id: current || project, limit });
        return textResult(JSON.stringify({ count: workspaces.length, workspaces }, null, 2));
      }
      case "get": {
        if (!workspace_id && !project) return errorResult("workspace_id or project required for get");
        const row = workspace_id
          ? platformKernel.getProjectWorkspace(workspace_id)
          : platformKernel.getWorkspaceByProject(scopedProject() || project);
        if (!row) return errorResult(`Workspace not found: ${workspace_id || project}`);
        assertProjectAccess(row, project);
        // row carries secret NAMES only (secret_names); values are not
        // retrievable through this tool.
        return textResult(JSON.stringify(row, null, 2));
      }
      case "create": {
        if (!project) return errorResult("project required for create");
        assertProjectAccess(null, project);
        const row = platformKernel.createProjectWorkspace({
          project_id: project,
          name,
          config,
          environment,
          resource_limits,
          metadata,
          owner_id: getExecutionSource() || "system",
          source: getExecutionSource(),
        });
        return textResult(JSON.stringify(row, null, 2));
      }
      case "update": {
        if (!workspace_id) return errorResult("workspace_id required for update");
        const existing = platformKernel.getProjectWorkspace(workspace_id);
        if (!existing) return errorResult(`Workspace not found: ${workspace_id}`);
        assertProjectAccess(existing);
        const updates = { source: getExecutionSource() };
        if (config !== undefined) updates.config = config;
        if (environment !== undefined) updates.environment = environment;
        if (resource_limits !== undefined) updates.resource_limits = resource_limits;
        if (metadata !== undefined) updates.metadata = metadata;
        const row = platformKernel.updateProjectWorkspace(workspace_id, updates);
        return textResult(JSON.stringify(row, null, 2));
      }
      case "set_secret": {
        if (!workspace_id) return errorResult("workspace_id required for set_secret");
        const existing = platformKernel.getProjectWorkspace(workspace_id);
        if (!existing) return errorResult(`Workspace not found: ${workspace_id}`);
        assertProjectAccess(existing);
        if (!secret_name) return errorResult("secret_name required for set_secret");
        if (secret_value == null || secret_value === "") return errorResult("secret_value required for set_secret");
        // Fails closed without SIDEKICK_SECRET_KEY (kernel throws; surfaced
        // below). The returned workspace exposes secret NAMES only.
        const row = platformKernel.setWorkspaceSecret(workspace_id, secret_name, secret_value, { source: getExecutionSource() });
        return textResult(JSON.stringify(row, null, 2));
      }
      case "delete_secret": {
        if (!workspace_id) return errorResult("workspace_id required for delete_secret");
        if (!secret_name) return errorResult("secret_name required for delete_secret");
        const existing = platformKernel.getProjectWorkspace(workspace_id);
        if (!existing) return errorResult(`Workspace not found: ${workspace_id}`);
        assertProjectAccess(existing);
        const result = platformKernel.deleteWorkspaceSecret(workspace_id, secret_name, { source: getExecutionSource() });
        if (!result.deleted) return errorResult(`Secret not found on workspace ${workspace_id}: ${secret_name}`);
        return textResult(JSON.stringify(result, null, 2));
      }
      case "backfill_secrets": {
        // Writes are opt-in twice over, exactly like project_registry
        // backfill: dry_run defaults to true, and a real run additionally
        // requires confirm:true so a bare call can never migrate or clear
        // legacy plaintext. confirm attests to the operation, not to a
        // specific reviewed row set — the real run re-scans the workspaces.
        const dryRun = dry_run !== false;
        if (!dryRun && confirm !== true) {
          return errorResult("backfill_secrets with dry_run=false requires confirm:true (run the default dry_run first and review the counts)");
        }
        const result = platformKernel.backfillWorkspaceSecrets({ source: getExecutionSource(), dry_run: dryRun });
        const label = dryRun ? "Dry run (no writes)" : "Secrets backfill complete";
        return textResult(`${label}: ${result.secrets_migrated} secret(s)${dryRun ? " would be" : ""} migrated across ${result.workspaces_migrated} workspace(s)\n${JSON.stringify(result, null, 2)}`);
      }
      default:
        return errorResult("Unknown action. Use: list, get, create, update, set_secret, delete_secret, backfill_secrets");
    }
  } catch (e) {
    return errorResult("Error: " + e.message);
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "workspace",
    description: "Project workspaces with encrypted secrets: list, inspect, create, and update workspaces; set or delete encrypted workspace secrets (names only are ever exposed); backfill legacy plaintext secrets into encrypted envelopes (dry-run by default). Secret writes require SIDEKICK_SECRET_KEY and fail closed without it",
    schema: z.object({
      action: z.enum(["list", "get", "create", "update", "set_secret", "delete_secret", "backfill_secrets"]).describe("Workspace action"),
      workspace_id: z.string().optional().describe("Workspace id (required for update/set_secret/delete_secret; get accepts it or project)"),
      project: z.string().optional().describe("Project id (required for create; canonicalized; get/list may filter by it)"),
      name: z.string().max(200).optional().describe("Workspace name (create; defaults to the canonical project id)"),
      config: z.record(z.any()).optional().describe("Workspace configuration object (create/update)"),
      environment: z.string().max(100).optional().describe("Workspace environment label (create/update; default 'default')"),
      resource_limits: z.record(z.any()).optional().describe("Resource limits object (create/update)"),
      metadata: z.record(z.any()).optional().describe("Metadata object (create/update)"),
      secret_name: z.string().max(200).optional().describe("Secret name (set_secret/delete_secret)"),
      secret_value: z.string().optional().describe("Secret value (set_secret only; stored encrypted, never returned by any action)"),
      state: z.enum(["active", "archived"]).optional().describe("Filter by state (list)"),
      limit: z.number().int().positive().max(200).optional().describe("Max results (list)"),
      confirm: z.boolean().optional().describe("Required true for backfill_secrets with dry_run=false"),
      dry_run: z.boolean().optional().describe("backfill_secrets only reports counts without writing (default true)"),
    }),
    args: { action: "string (list|get|create|update|set_secret|delete_secret|backfill_secrets)", workspace_id: "string (workspace id; required for update/set_secret/delete_secret)", project: "string (project id; required for create, optional for get/list)", name: "string (optional, for create)", config: "object (optional, for create/update)", environment: "string (optional, for create/update)", resource_limits: "object (optional, for create/update)", metadata: "object (optional, for create/update)", secret_name: "string (for set_secret/delete_secret)", secret_value: "string (for set_secret; stored encrypted, never returned)", state: "string (optional, filter by state for list: active|archived)", limit: "number (optional, max results for list)", confirm: "boolean (required true for backfill_secrets with dry_run=false)", dry_run: "boolean (optional, for backfill_secrets - default true, report without writing)" },
    risk: "high",
    category: "Storage",
    source: "builtin",
    family: "workspace",
    handler: sidekick_workspace,
  }),
]);

module.exports = { descriptors, sidekick_workspace };
