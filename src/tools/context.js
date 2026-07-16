const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

const storage = new AsyncLocalStorage();
let compatibilitySource = "mcp";

function invocationId(prefix = "tool") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function safeSource(source) {
  return String(source || "mcp").toLowerCase().replace(/[^a-z0-9_-]/g, "_") || "mcp";
}

function createExecutionContext(input = {}) {
  const parent = input.parentContext || storage.getStore() || null;
  const source = safeSource(input.source || parent?.source || compatibilitySource || "mcp");
  const traceId = input.traceId || input.trace_id || parent?.traceId || invocationId("trace");
  const parentInvocationId = input.parentInvocationId || input.parent_invocation_id || parent?.invocationId || input.parentId || input.parent_id || null;
  return Object.freeze({
    source,
    requestId: input.requestId || input.request_id || parent?.requestId || invocationId("req"),
    traceId,
    correlationId: input.correlationId || input.correlation_id || parent?.correlationId || traceId,
    invocationId: input.invocationId || input.invocation_id || invocationId("invoke"),
    parentInvocationId,
    actor: input.actor || input.actor_id || parent?.actor || source,
    authIdentity: input.authIdentity || input.auth_identity || parent?.authIdentity || null,
    sessionId: input.sessionId || input.session_id || parent?.sessionId || process.env.SIDEKICK_SESSION_ID || null,
    taskId: input.taskId || input.task_id || input.requestId || input.request_id || parent?.taskId || null,
    project: input.project || parent?.project || process.env.SIDEKICK_PROJECT || null,
    toolName: input.toolName || input.tool_name || null,
    approvalId: input.approvalId || input.approval_id || parent?.approvalId || null,
    approvedExecution: input.approvedExecution === true || parent?.approvedExecution === true,
    generatedProcedure: input.generatedProcedure || input.generated_procedure || parent?.generatedProcedure || null,
    executionId: input.executionId || input.execution_id || parent?.executionId || null,
    rootExecutionId: input.rootExecutionId || input.root_execution_id || parent?.rootExecutionId || input.executionId || input.execution_id || null,
    parentId: input.parentId || input.parent_id || parent?.parentId || null,
    stepNumber: input.stepNumber || input.step_number || null,
    timeoutMs: Number(input.timeoutMs || input.timeout_ms || 0) || null,
    signal: input.signal || parent?.signal || null,
    startedAt: input.startedAt || new Date().toISOString(),
    security: input.security || parent?.security || null,
  });
}

function childContext(input = {}) {
  return createExecutionContext({ ...input, parentContext: storage.getStore() || input.parentContext });
}

function runWithContext(context, fn) {
  return storage.run(Object.freeze({ ...context }), fn);
}

function getExecutionContext() {
  return storage.getStore() || createExecutionContext({ source: compatibilitySource });
}

function setExecutionSource(source) {
  compatibilitySource = safeSource(source);
}

function getExecutionSource() {
  return (storage.getStore() && storage.getStore().source) || compatibilitySource;
}

function dispatcherMetadata(context = getExecutionContext(), extra = {}) {
  return {
    requestId: context.requestId,
    taskId: context.taskId,
    sessionId: context.sessionId,
    project: context.project,
    correlationId: context.correlationId,
    parentId: context.parentId || context.parentInvocationId,
    rootExecutionId: context.rootExecutionId,
    executionId: context.executionId,
    stepNumber: context.stepNumber,
    approvalId: context.approvalId,
    generatedProcedure: context.generatedProcedure,
    actor: context.actor,
    source: context.source,
    ...extra,
  };
}

module.exports = {
  createExecutionContext,
  childContext,
  runWithContext,
  getExecutionContext,
  setExecutionSource,
  getExecutionSource,
  dispatcherMetadata,
};
