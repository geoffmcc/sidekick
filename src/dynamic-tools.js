const z = require("zod");
const crypto = require("crypto");
const EventEmitter = require("events");
const dbStore = require("./db");
const { substitute } = require("./evolve/validator");
const { summarizeResult, errorCategory } = require("./evolve/common");
const { redactSensitive } = require("./redact");

const executionEvents = new EventEmitter();
executionEvents.setMaxListeners(100);

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

function executionId() {
  return `gte_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function emitExecution(execution) {
  executionEvents.emit("event", execution);
  executionEvents.emit(execution.id, execution);
}

function sensitiveInputValues(inputs) {
  return Object.entries(inputs || {})
    .filter(([key, value]) => /(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i.test(key) && value !== undefined && value !== null && String(value))
    .map(([, value]) => String(value));
}

function redacted(value, sensitiveValues = []) {
  const scrub = (input, key = "") => {
    if (input === null || input === undefined) return input;
    if (/(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i.test(key)) return "[REDACTED]";
    if (Array.isArray(input)) return input.map(item => scrub(item, key));
    if (typeof input === "object") return Object.fromEntries(Object.entries(input).map(([childKey, childValue]) => [childKey, scrub(childValue, childKey)]));
    let text = redactSensitive(String(input));
    for (const secret of sensitiveValues) text = text.split(secret).join("[REDACTED]");
    return text;
  };
  return scrub(value || {});
}

function redactSummaryWithInputs(summary, inputs) {
  let text = redactSensitive(String(summary || ""));
  for (const [key, value] of Object.entries(inputs || {})) {
    if (!/(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i.test(key)) continue;
    const raw = String(value || "");
    if (raw) text = text.split(raw).join("[REDACTED]");
  }
  return summarizeResult(text);
}

function finalCriteria(cap) {
  return cap.successCriteria || cap.qualityGates?.successfulOutcome && "All generated workflow steps must complete successfully" || "All generated workflow steps must complete successfully";
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve({ isError: true, timedOut: true, content: [{ type: "text", text: `Timed out after ${timeoutMs}ms` }] }), timeoutMs)),
  ]);
}

function completedState(result) {
  if (result.timedOut) return "timed_out";
  return result.isError ? "failed" : "succeeded";
}

function syncStats(capabilityId) {
  const updated = dbStore.syncGeneratedCapabilityStats(capabilityId);
  dbStore.syncGeneratedToolRegistry();
  return updated;
}

async function callDynamicTool(name, args, deps) {
  const cap = dbStore.getGeneratedCapabilityByName(name);
  if (!cap || !["trial", "active"].includes(cap.state)) {
    return { content: [{ type: "text", text: `Generated tool is not active: ${name}` }], isError: true };
  }
  const id = deps.executionId || executionId();
  const source = deps.source || "unknown";
  const timeoutMs = Number(deps.timeoutMs || args?.__timeout_ms || 0) || null;
  const startedAt = new Date().toISOString();
  const sensitiveValues = sensitiveInputValues(args || {});
  dbStore.createGeneratedToolExecution({
    id,
    capabilityId: cap.id,
    toolName: cap.name,
    state: "running",
    source,
    args: redacted(args || {}, sensitiveValues),
    successCriteria: finalCriteria(cap),
    timeoutMs,
    startedAt,
  });
  emitExecution(dbStore.getGeneratedToolExecution(id));
  const results = [];
  try {
    for (let i = 0; i < cap.steps.length; i++) {
      const current = dbStore.getGeneratedToolExecution(id);
      if (current?.cancelRequested || current?.state === "cancelled") {
        const cancelled = dbStore.updateGeneratedToolExecution(id, {
          state: "cancelled",
          completedAt: new Date().toISOString(),
          finalSummary: "Execution cancelled before step " + (i + 1),
          successCriteriaSatisfied: false,
          errorCategory: "cancelled",
        });
        emitExecution(cancelled);
        syncStats(cap.id);
        return { content: [{ type: "text", text: JSON.stringify({ execution_id: id, generated_tool: cap.name, state: "cancelled", success: false, results }, null, 2) }], isError: true };
      }
      const step = cap.steps[i];
      const resolvedArgs = substitute(step.args, args || {});
      const stepStartedAt = new Date().toISOString();
      const stepRow = dbStore.addGeneratedToolExecutionStep({
        executionId: id,
        stepNumber: i + 1,
        toolName: step.tool,
        state: "running",
        args: redacted(resolvedArgs, sensitiveValues),
        startedAt: stepStartedAt,
      });
      emitExecution(dbStore.getGeneratedToolExecution(id));
      const result = await withTimeout(deps.callTool(step.tool, resolvedArgs, {
        generatedProcedure: cap.name,
        correlationId: id,
        parentId: id,
        executionId: id,
        stepNumber: i + 1,
      }), timeoutMs);
      const summary = redactSummaryWithInputs(result.content?.[0]?.text || "", args || {});
      const durationMs = Date.now() - Date.parse(stepStartedAt);
      const state = completedState(result);
      dbStore.updateGeneratedToolExecutionStep(stepRow.id, {
        state,
        completedAt: new Date().toISOString(),
        durationMs,
        resultSummary: summary,
        errorCategory: result.isError ? (result.timedOut ? "timeout" : errorCategory(summary)) : null,
        success: !result.isError,
      });
      results.push({ step: i + 1, tool: step.tool, success: !result.isError, summary, retry_count: 0, error_category: result.isError ? (result.timedOut ? "timeout" : errorCategory(summary)) : null });
      emitExecution(dbStore.getGeneratedToolExecution(id));
      if (result.isError) {
        const finalState = result.timedOut ? "timed_out" : "failed";
        const execution = dbStore.updateGeneratedToolExecution(id, {
          state: finalState,
          completedAt: new Date().toISOString(),
          finalSummary: summary,
          successCriteriaSatisfied: false,
          errorCategory: result.timedOut ? "timeout" : errorCategory(summary),
        });
        dbStore.appendGeneratedToolAudit({ capability_id: cap.id, tool_name: cap.name, success: false, args: redacted(args || {}, sensitiveValues), result_summary: summary });
        syncStats(cap.id);
        emitExecution(execution);
        return { content: [{ type: "text", text: JSON.stringify({ execution_id: id, generated_tool: cap.name, state: finalState, success: false, failed_step: i + 1, success_criteria_satisfied: false, results }, null, 2) }], isError: true };
      }
    }
    const execution = dbStore.updateGeneratedToolExecution(id, {
      state: "succeeded",
      completedAt: new Date().toISOString(),
      finalSummary: `Executed ${cap.steps.length} generated steps`,
      successCriteriaSatisfied: true,
    });
    dbStore.appendGeneratedToolAudit({ capability_id: cap.id, tool_name: cap.name, success: true, args: redacted(args || {}, sensitiveValues), result_summary: `Executed ${cap.steps.length} generated steps` });
    syncStats(cap.id);
    emitExecution(execution);
    return { content: [{ type: "text", text: JSON.stringify({ execution_id: id, generated_tool: cap.name, state: "succeeded", success: true, success_criteria_satisfied: true, calls_saved: Math.max(cap.steps.length - 1, 0), results }, null, 2) }] };
  } finally {
    dbStore.syncGeneratedToolRegistry();
  }
}

function onExecutionEvent(listener) {
  executionEvents.on("event", listener);
  return () => executionEvents.off("event", listener);
}

function cancelExecution(id) {
  const execution = dbStore.requestGeneratedToolExecutionCancel(id);
  if (execution) emitExecution(execution);
  return execution;
}

module.exports = {
  getDynamicToolDefs,
  getDynamicToolSchemas,
  isDynamicTool,
  callDynamicTool,
  onExecutionEvent,
  cancelExecution,
};
