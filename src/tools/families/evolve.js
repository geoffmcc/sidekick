"use strict";

// Evolve tool family: evolve.
//
// Extracted from src/tools-legacy.js. A thin wrapper over src/evolve that
// hands the impl the full built-in tool catalog (registry-derived TOOL_DEFS,
// read lazily from the facade to avoid a module-init dependency on
// tools-legacy) plus active module descriptors and the shared procedures
// store. `evolve` is `critical` risk, preserved from src/tools/metadata.js.

const { z } = require("zod");
const { loadProcedures } = require("../../core/procedures-store");

async function sidekick_evolve(args = {}) {
  const evolveImpl = require("../../evolve");
  const { TOOL_DEFS } = require("../index");
  // Active module tools count as built-in names so evolve cannot mint a
  // generated capability that collides with a module-owned tool.
  const moduleDefs = require("../../modules/loader").getActiveDescriptors().map(d => ({ name: d.name, aliases: d.aliases, description: d.description, args: d.args }));
  return evolveImpl.sidekick_evolve(args, { TOOL_DEFS: [...TOOL_DEFS, ...moduleDefs], loadProcedures });
}

const SCHEMAS = {
  evolve: z.object({
    action: z.enum(["analyze", "candidates", "inspect", "propose", "validate", "test", "approve", "activate_trial", "promote", "reject", "revise", "deprecate", "feedback", "report", "list", "cleanup"]).describe("Evolve action"),
    id: z.string().optional().describe("Candidate or generated capability ID/name"),
    proposal: z.string().optional().describe("Deprecated legacy proposal text"),
    approver: z.string().optional().describe("Approver identity for approve/activate_trial"),
    useful: z.boolean().optional().describe("Feedback: true if useful, false if not"),
    notes: z.string().optional().describe("Feedback or lifecycle notes"),
    reason: z.string().optional().describe("Reject/deprecate reason"),
    limit: z.number().optional().describe("Number of logs to analyze"),
    approve: z.boolean().optional().describe("Deprecated - use action=approve"),
    test: z.boolean().optional().describe("Deprecated - use action=test"),
    confirm: z.coerce.boolean().optional().describe("For cleanup action - actually delete old entries")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "evolve",
    description: "Evidence-driven workflow learning and generated-tool lifecycle management. Mines successful bounded workflows, validates parameterized procedures, and exposes approved trial/active generated tools through normal discovery.",
    schema: SCHEMAS.evolve,
    args: { action: "string (analyze|candidates|inspect|validate|approve|activate_trial|promote|reject|deprecate|feedback|report|cleanup)", id: "string (optional, candidate/generated capability id or name)", approver: "string (optional)", useful: "boolean (optional, for feedback)", notes: "string (optional)", reason: "string (optional)", limit: "number (optional, logs to analyze)" },
    risk: "critical",
    category: "Meta",
    source: "builtin",
    family: "evolve",
    handler: sidekick_evolve,
  }),
]);

module.exports = { descriptors, sidekick_evolve };
