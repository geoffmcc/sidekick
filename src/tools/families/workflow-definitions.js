"use strict";

// Workflow-definition tool family: workflow.
//
// Discovery and execution surface for registered workflow definitions —
// Sidekick's own and those contributed by capability packs. Running a workflow
// executes governed tool calls, so the descriptor's risk reflects the highest
// thing a definition can reach: the runner dispatches every step through the
// single dispatcher, where each individual tool's own policy and approval
// still apply on top.

const { z } = require("zod");

function jsonText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function failure(message, extra = {}) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }], isError: true };
}

function summarize(record) {
  return {
    name: record.name,
    version: record.version,
    title: record.title,
    description: record.description,
    mode: record.mode,
    state: record.state,
    owner: record.owner_name ? `${record.owner_kind}:${record.owner_name}` : record.owner_kind,
    steps: (record.definition.steps || []).length,
    inputs: Object.fromEntries(
      Object.entries(record.definition.inputs || {}).map(([key, spec]) => [
        key,
        { type: spec.type, required: Boolean(spec.required), description: spec.description || null, default: spec.default },
      ])
    ),
    tags: record.definition.tags || [],
    updated_at: record.updated_at,
  };
}

async function sidekick_workflow({ action = "list", name, inputs, project, owner, run_id, include_evidence }) {
  const repository = require("../../workflows/repository");
  const runner = require("../../workflows/runner");

  try {
    if (action === "list") {
      const records = repository.listWorkflowDefinitions(owner ? { ownerKind: "pack", ownerName: owner } : {});
      return jsonText({ ok: true, action, workflows: records.map(summarize) });
    }

    if (action === "show") {
      if (!name) return failure("name is required for show", { code: "invalid_arguments" });
      const record = repository.getWorkflowDefinition(name);
      if (!record) return failure(`Workflow "${name}" is not registered`, { code: "unknown_workflow" });
      return jsonText({ ok: true, action, workflow: { ...summarize(record), definition: record.definition } });
    }

    if (action === "run" || action === "resume") {
      if (!name) return failure(`name is required for ${action}`, { code: "invalid_arguments" });
      if (action === "resume" && !run_id) return failure("run_id is required for resume", { code: "invalid_arguments" });
      const result = await runner.runWorkflowDefinition(name, inputs || {}, {
        project: project || undefined,
        resumeWorkflowId: action === "resume" ? run_id : undefined,
      });
      // Step evidence can be large; it is available on request and always
      // summarized in `steps`.
      const payload = include_evidence === true ? result : { ...result, evidence: undefined };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: result.status === "failed",
      };
    }

    return failure(`Unknown workflow action: ${action}. Use list, show, run, or resume`, { code: "unknown_action" });
  } catch (error) {
    return failure(String(error && error.message ? error.message : error), { action, code: "workflow_operation_failed" });
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "workflow",
    aliases: ["workflows"],
    description:
      "List, inspect and run registered workflow definitions, including those contributed by capability packs. Each step executes as a governed tool call through the single dispatcher with durable execution state, checkpoints, cancellation and approval continuation.",
    schema: z.object({
      action: z.enum(["list", "show", "run", "resume"]).optional().describe("Workflow action (default: list)"),
      name: z.string().optional().describe("Workflow definition name, e.g. developer/repository-recon"),
      inputs: z.record(z.any()).optional().describe("Workflow inputs, validated against the definition's declared inputs"),
      project: z.string().optional().describe("Canonical project name for execution identity"),
      run_id: z.string().optional().describe("Existing run id to resume (after satisfying an approval)"),
      owner: z.string().optional().describe("Filter the list to workflows owned by this capability pack"),
      include_evidence: z.boolean().optional().describe("Include full per-step evidence in the result (default false)"),
    }),
    args: {
      action: "string (list|show|run|resume - default list)",
      name: "string (workflow definition name)",
      inputs: "object (workflow inputs)",
      project: "string (canonical project name)",
      run_id: "string (run id for resume)",
      owner: "string (filter by owning pack)",
      include_evidence: "boolean (include full step evidence)",
    },
    risk: "high",
    category: "Services",
    source: "builtin",
    family: "workflow-definitions",
    handler: sidekick_workflow,
  }),
]);

module.exports = { descriptors, sidekick_workflow };
