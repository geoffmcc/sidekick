"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const toolContext = require("../context");
const { scopedProject } = require("./memory-scope");

function response(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

async function sidekick_memory_maintenance({ action, project, run_id, max_candidates, handoff_retention_days, purge_handoff_versions, purge_approved, max_execution_ms }) {
  try {
    if (action === "preview") {
      const effectiveProject = scopedProject(project);
      if (!effectiveProject) return response({ ok: false, error: "memory maintenance requires an explicit project" }, true);
      return response({ ok: true, action, ...dbStore.memoryMaintenancePreview({ project: effectiveProject, maxCandidates: max_candidates, handoffRetentionDays: handoff_retention_days }) });
    }
    if (!run_id) return response({ ok: false, error: `${action} requires run_id` }, true);
    const run = dbStore.getMemoryMaintenanceRun(run_id);
    if (!run) return response({ ok: false, error: "maintenance run not found" }, true);
    const effectiveProject = scopedProject(project || run.project);
    if (!effectiveProject || effectiveProject !== run.project) return response({ ok: false, error: "memory project scope denied" }, true);
    if (action === "status") return response({ ok: true, action, run });
    if (action === "cancel") return response({ ok: true, action, run: dbStore.cancelMemoryMaintenance(run_id) });
    if (action === "apply" || action === "resume") {
      const result = dbStore.applyMemoryMaintenance(run_id, {
        purgeHandoffVersions: purge_handoff_versions === true,
        purgeApproved: purge_approved === true,
        maxExecutionMs: max_execution_ms,
        actor: toolContext.getExecutionContext().authIdentity?.principal_id || toolContext.getExecutionSource() || "system",
      });
      return response({ ok: true, action, result });
    }
    return response({ ok: false, error: "Invalid action. Use preview, apply, status, cancel, or resume" }, true);
  } catch (error) {
    return response({ ok: false, error: String(error.message || error) }, true);
  }
}

const descriptors = Object.freeze([Object.freeze({
  name: "memory_maintenance",
  description: "Governed project-scoped bulk memory hygiene. Preview deterministically identifies exact active-memory duplicates and redundant historical handoff versions; apply soft-deletes only unprotected memory duplicates in one bounded transaction. Historical handoff purge requires explicit approval.",
  schema: z.object({
    action: z.enum(["preview", "apply", "status", "cancel", "resume"]),
    project: z.string().optional().describe("Required project scope for preview; must match the run for other actions"),
    run_id: z.string().optional().describe("Preview run id for apply, status, cancel, or resume"),
    max_candidates: z.number().int().min(1).max(500).optional(),
    handoff_retention_days: z.number().int().min(0).max(3650).optional(),
    purge_handoff_versions: z.boolean().optional().describe("Irreversibly purge previewed redundant historical handoff versions"),
    purge_approved: z.boolean().optional().describe("Explicit approval acknowledgement required with purge_handoff_versions"),
    max_execution_ms: z.number().int().min(1).max(30000).optional(),
  }).strict(),
  args: { action: "string (preview|apply|status|cancel|resume)", project: "string (explicit project scope)", run_id: "string (maintenance run id)", max_candidates: "number (1-500)", handoff_retention_days: "number", purge_handoff_versions: "boolean (irreversible)", purge_approved: "boolean (explicit approval)", max_execution_ms: "number (1-30000)" },
  risk: "critical",
  category: "Context & Learning",
  source: "builtin",
  family: "memory-maintenance",
  handler: sidekick_memory_maintenance,
})]);

module.exports = { descriptors, sidekick_memory_maintenance };
