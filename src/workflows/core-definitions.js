"use strict";

const maintenance = Object.freeze({
  schema_version: 1,
  name: "core/memory-maintenance",
  version: "1.0.0",
  title: "Governed memory maintenance",
  description: "Preview, apply, inspect, cancel, or resume one project-scoped bounded memory-maintenance operation.",
  mode: "mutating",
  inputs: {
    action: { type: "string", required: true, enum: ["preview", "apply", "status", "cancel", "resume"] },
    project: { type: "string", required: true },
    run_id: { type: "string", required: false },
    max_candidates: { type: "number", required: false },
    handoff_retention_days: { type: "number", required: false },
    purge_handoff_versions: { type: "boolean", required: false },
    purge_approved: { type: "boolean", required: false },
  },
  steps: [{ name: "maintenance", tool: "memory_maintenance", args: {
    action: "${inputs.action}", project: "${inputs.project}", run_id: "${inputs.run_id}", max_candidates: "${inputs.max_candidates}", handoff_retention_days: "${inputs.handoff_retention_days}", purge_handoff_versions: "${inputs.purge_handoff_versions}", purge_approved: "${inputs.purge_approved}",
  }, expect: "json", on_error: "fail" }],
  result: { maintenance: "${steps.maintenance.json}" },
  tags: ["memory", "maintenance", "governed"],
});

function ensureCoreWorkflowDefinitions() {
  const repository = require("./repository");
  repository.registerWorkflowDefinition(maintenance, { ownerKind: "core", metadata: { builtin: true } });
}

module.exports = { ensureCoreWorkflowDefinitions };
