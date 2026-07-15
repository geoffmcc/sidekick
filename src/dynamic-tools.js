const z = require("zod");
const dbStore = require("./db");
const { substitute } = require("./evolve/validator");
const { recordInvocation } = require("./evolve/lifecycle");

function schemaToZod(schema = {}) {
  const shape = {};
  for (const [key, def] of Object.entries(schema.properties || {})) {
    let field = def.type === "number" ? z.number() : def.type === "boolean" ? z.boolean() : z.string();
    if (def.description) field = field.describe(def.description);
    if (!schema.required || !schema.required.includes(key)) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape);
}

function getDynamicToolDefs() {
  return dbStore.listGeneratedCapabilities({ states: ["trial", "active"] }).map(cap => ({
    name: cap.name,
    description: `[generated:${cap.state}] ${cap.description}`,
    args: cap.schema || { type: "object", properties: {}, required: [] },
    risk: cap.risk || "medium",
    category: "Meta",
    generated: true,
    version: cap.version || 1,
    state: cap.state,
    capabilityId: cap.id,
  }));
}

function getDynamicToolSchemas() {
  const schemas = {};
  for (const def of getDynamicToolDefs()) schemas[def.name] = schemaToZod(def.args);
  return schemas;
}

function isDynamicTool(name) {
  return Boolean(dbStore.getGeneratedCapabilityByName(name));
}

async function callDynamicTool(name, args, deps) {
  const cap = dbStore.getGeneratedCapabilityByName(name);
  if (!cap || !["trial", "active"].includes(cap.state)) {
    return { content: [{ type: "text", text: `Generated tool is not active: ${name}` }], isError: true };
  }
  const results = [];
  let success = false;
  try {
    for (let i = 0; i < cap.steps.length; i++) {
      const step = cap.steps[i];
      const resolvedArgs = substitute(step.args, args || {});
      const result = await deps.callTool(step.tool, resolvedArgs, { generatedProcedure: cap.name, correlationId: cap.id });
      results.push({ step: i + 1, tool: step.tool, success: !result.isError, summary: result.content?.[0]?.text?.slice(0, 240) || "" });
      if (result.isError) {
        recordInvocation(cap, false, 0);
        dbStore.saveGeneratedCapability(cap);
        dbStore.appendGeneratedToolAudit({ capability_id: cap.id, tool_name: cap.name, success: false, args, result_summary: results[results.length - 1].summary });
        return { content: [{ type: "text", text: JSON.stringify({ generated_tool: cap.name, state: cap.state, success: false, failed_step: i + 1, results }, null, 2) }], isError: true };
      }
    }
    success = true;
    recordInvocation(cap, true, Math.max((cap.steps || []).length - 1, 0));
    dbStore.saveGeneratedCapability(cap);
    dbStore.appendGeneratedToolAudit({ capability_id: cap.id, tool_name: cap.name, success: true, args, result_summary: `Executed ${cap.steps.length} generated steps` });
    return { content: [{ type: "text", text: JSON.stringify({ generated_tool: cap.name, state: cap.state, success: true, calls_saved: Math.max(cap.steps.length - 1, 0), results }, null, 2) }] };
  } finally {
    if (!success) dbStore.syncGeneratedToolRegistry();
  }
}

module.exports = {
  getDynamicToolDefs,
  getDynamicToolSchemas,
  isDynamicTool,
  callDynamicTool,
};
