const legacy = require("../tools-legacy");
const dynamicTools = require("../dynamic-tools");
const dbStore = require("../db");
const { stripSidekickPrefix } = require("../core/tool-name");
const { RISK_LEVELS } = require("./metadata");
const { buildBuiltinRegistry } = require("./registry");
const {
  createExecutionContext,
  createMcpExecutionContext,
  createAgentExecutionContext,
  createDashboardExecutionContext,
  createInternalExecutionContext,
  createApprovalExecutionContext,
  createTestExecutionContext,
  childContext,
  runWithContext,
  dispatcherMetadata,
} = require("./context");
const { normalizeResult, errorResult, sanitizeText } = require("./result");

const APPROVED_EXECUTION_CAPABILITY = Symbol("sidekick.approvedExecution");
const TEST_DESCRIPTOR_CAPABILITY = Symbol("sidekick.testDescriptorExecution");

function clonePlain(value) {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function getBuiltinRegistry() {
  return buildBuiltinRegistry({
    toolDefs: legacy.TOOL_DEFS,
    handlers: legacy.TOOLS,
    schemas: require("./schemas").TOOL_SCHEMAS,
  });
}

function getHandlerMap() {
  return getBuiltinRegistry().toolsMap();
}

function resolveDynamicDescriptor(name) {
  let cap = dbStore.getGeneratedCapabilityByName(name);
  if (!cap && name.startsWith("sidekick_")) cap = dbStore.getGeneratedCapabilityByName(name.slice(9));
  if (!cap && !name.startsWith("sidekick_")) cap = dbStore.getGeneratedCapabilityByName("sidekick_" + name);
  if (!cap || !["trial", "active"].includes(cap.state)) return null;
  if (!RISK_LEVELS.includes(cap.risk)) {
    return { error: `Generated tool ${cap.name || name} has missing or invalid risk classification` };
  }
  return {
    name: cap.name,
    description: `[generated:${cap.state}] ${cap.description}`,
    schema: dynamicTools.getDynamicToolSchemas()[cap.name] || dynamicTools.getDynamicToolSchemas()[stripSidekickPrefix(cap.name)],
    risk: cap.risk,
    category: "Meta",
    source: "generated",
    generated: true,
    capabilityId: cap.id,
    state: cap.state,
    handler: (args, runtime) => dynamicTools.callDynamicTool(cap.name, args, {
      callTool,
      source: runtime.context.source,
      executionId: runtime.context.executionId,
      timeoutMs: runtime.context.timeoutMs,
    }),
  };
}

function validationError(name, parsed) {
  const issues = parsed.error?.issues || [];
  const details = issues.map(issue => `${issue.path.join(".") || "args"}: ${issue.message}`).join("; ");
  return errorResult(`Invalid arguments for ${name}${details ? ": " + details : ""}`, "validation_failed");
}

function withTimeoutAndCancellation(handler, args, runtime, context) {
  const timeoutMs = context.timeoutMs;
  const callerSignal = context.signal;
  if (callerSignal?.aborted) return Promise.resolve(errorResult("Tool execution cancelled before start", "cancelled", { cancelled: true }));
  const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
  const signal = controller?.signal || callerSignal;
  const run = () => Promise.resolve(handler(args, { ...runtime, signal }));
  if ((!timeoutMs || timeoutMs <= 0) && !callerSignal) return run();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = fn => value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(resolve)(errorResult("Tool execution cancelled", "cancelled", { cancelled: true }));
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        finish(resolve)(errorResult(`Timed out after ${timeoutMs}ms; cancellation was requested but the operation may still be running`, "timed_out_operation_may_continue", { timedOut: true, operationMayContinue: true, operationId: context.operationId, idempotencyKey: context.idempotencyKey }));
      }, timeoutMs);
    }
    if (callerSignal) {
      if (callerSignal.aborted) return onAbort();
      callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    run().then(finish(resolve), finish(reject));
  });
}

function log(name, args, started, result, context, extra = {}) {
  try {
    const summary = sanitizeText(result.content?.[0]?.text || (result.isError ? result.code || "error" : "(ok)")).substring(0, 1000);
    legacy.logToolCall(name, clonePlain(args), Date.now() - started, !result.isError, summary, dispatcherMetadata(context, extra));
    return result;
  } catch (e) {
    const safe = sanitizeText(e.message || e);
    console.error(JSON.stringify({
      level: "error",
      event: "tool.audit_failed",
      tool: name,
      invocationId: context.invocationId,
      approvalId: context.approvalId || null,
      stage: extra.stage || "final",
      error: safe,
    }));
    return { ...result, auditFailed: true, auditErrorCode: "audit_persistence_failed" };
  }
}

async function executeResolvedTool(descriptor, args, context, requestedName = descriptor.name, options = {}) {
  if (!descriptor.schema || typeof descriptor.schema.safeParse !== "function") {
    return errorResult(`Tool ${descriptor.name} has no executable schema`, "dispatcher_internal_error");
  }
  const parsed = descriptor.schema.safeParse(clonePlain(args || {}));
  if (!parsed.success) return validationError(descriptor.name, parsed);
  const executionArgs = freezeDeep(clonePlain(parsed.data));

  let policyError;
  try {
    policyError = legacy.enforceToolPolicy(descriptor.name, context.source);
  } catch (e) {
    return errorResult("Policy evaluation failed", "policy_evaluation_failed");
  }
  if (policyError) return { ...normalizeResult(policyError), code: "policy_denied", status: "policy_denied" };

  if (!options.approvedExecution) {
    let approval;
    try {
      approval = legacy.getApprovalDecision(descriptor.name, context.source);
    } catch (e) {
      return errorResult("Approval evaluation failed", "approval_evaluation_failed");
    }
    if (approval.required) {
      let item;
      try {
        item = legacy.queueApproval(requestedName, executionArgs, approval, context);
      } catch (e) {
        return errorResult("Approval queue unavailable: " + e.message, "approval_queue_unavailable");
      }
      const text = `Approval required: ${requestedName} (${approval.risk} risk, source=${approval.source}, mode=${approval.mode}). Queued as ${item.id}. ${approval.reason}.`;
      return errorResult(text, "approval_required", { approvalRequired: true, approvalId: item.id, status: "approval_required" });
    }
  }

  try {
    return normalizeResult(await withTimeoutAndCancellation(
      descriptor.handler,
      executionArgs,
      { context, signal: context.signal },
      context
    ));
  } catch (e) {
    return errorResult(e, "handler_error");
  }
}

function isApprovedInternal(request) {
  return request.internalCapability === APPROVED_EXECUTION_CAPABILITY;
}

async function dispatchCore(request, context, started) {
  const registry = getBuiltinRegistry();
  if (request.descriptor && request.internalCapability !== TEST_DESCRIPTOR_CAPABILITY) {
    const result = errorResult("Caller-provided descriptors are not accepted by production dispatch", "descriptor_injection_denied");
    return log(request.name || request.descriptor.name || "unknown", request.args || {}, started, result, context);
  }
  const name = request.name || (request.internalCapability === TEST_DESCRIPTOR_CAPABILITY ? request.descriptor?.name : null);
  const canonical = stripSidekickPrefix(name || "");
  let descriptor = request.internalCapability === TEST_DESCRIPTOR_CAPABILITY ? request.descriptor : registry.get(canonical);
  if (!descriptor) {
    const dynamicDescriptor = resolveDynamicDescriptor(name || canonical);
    if (dynamicDescriptor?.error) {
      const result = errorResult(dynamicDescriptor.error, "risk_unclassified");
      return log(name || canonical, request.args || {}, started, result, context, { risk: "unclassified" });
    }
    descriptor = dynamicDescriptor;
  }
  if (!descriptor) {
    const result = errorResult("Unknown tool: " + name, "unknown_tool");
    return log(name || "unknown", request.args || {}, started, result, context);
  }
  if (!RISK_LEVELS.includes(descriptor.risk)) {
    const result = errorResult(`Tool ${descriptor.name} has invalid risk classification`, "risk_unclassified");
    return log(descriptor.name, request.args || {}, started, result, context, { risk: descriptor.risk || "unclassified" });
  }
  const logName = name || descriptor.name;
  const result = await executeResolvedTool(descriptor, request.args || {}, context, logName, { approvedExecution: isApprovedInternal(request) });
  return log(logName, request.args || {}, started, result, context, { risk: descriptor.risk, approvalId: result.approvalId || context.approvalId });
}

function publicContextInput(request) {
  const input = { ...(request.options || {}), ...(request.context || {}) };
  delete input.bypassApproval;
  delete input.approvalBypass;
  delete input.approvedExecution;
  return input;
}

async function executeApprovedTool({ approvalId, reviewer = "system", source } = {}) {
  let claim;
  try {
    claim = legacy.claimApprovalExecution({ approvalId, reviewer, source });
  } catch (e) {
    return errorResult("Approval execution could not be claimed", "approval_execution_failed");
  }
  if (claim?.isError) return claim;
  let renewalTimer = null;
  const renew = () => legacy.renewApprovalLease({ approvalId, operationId: claim.operationId, executorId: claim.executorId });
  renewalTimer = setInterval(() => {
    const renewed = renew();
    if (!renewed.ok) console.error(JSON.stringify({ level: "error", event: "approval.lease_renew_failed", approvalId, operationId: claim.operationId, reason: renewed.reason }));
  }, 30000);
  let result;
  try {
    result = await dispatchTool({
      name: claim.tool,
      args: claim.args,
      context: createApprovalExecutionContext({
        actor: reviewer,
        approvalId,
        operationId: claim.operationId,
        idempotencyKey: claim.idempotencyKey,
        executionId: claim.operationId,
        timeoutMs: claim.timeoutMs,
        parentId: claim.parentId || null,
        rootExecutionId: claim.rootExecutionId || null,
        correlationId: approvalId,
        approvedExecution: true,
      }),
      internalCapability: APPROVED_EXECUTION_CAPABILITY,
    });
    result.operationId = result.operationId || claim.operationId;
    result.idempotencyKey = result.idempotencyKey || claim.idempotencyKey;
    legacy.finalizeApprovalExecution({ approvalId, reviewer, result, args: claim.args, operationId: claim.operationId, executorId: claim.executorId });
  } catch (e) {
    return { ...(result || errorResult("Approval execution failed", "approval_execution_failed")), auditFailed: true, auditErrorCode: "approval_finalization_failed", operationId: claim.operationId };
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
  }
  return result;
}

async function dispatchTestTool({ descriptor, args = {}, context = {} } = {}) {
  return dispatchTool({ descriptor, args, context: createTestExecutionContext(context), internalCapability: TEST_DESCRIPTOR_CAPABILITY });
}

async function dispatchTool(input, maybeArgs, maybeContext) {
  const request = typeof input === "string" ? { name: input, args: maybeArgs, context: maybeContext } : input || {};
  const name = request.name || request.descriptor?.name;
  const canonical = stripSidekickPrefix(name || "");
  const trusted = isApprovedInternal(request);
  const context = childContext({ ...publicContextInput(request), ...(trusted ? { approvedExecution: true, approvalId: request.context?.approvalId } : {}), toolName: canonical });
  return runWithContext(context, async () => {
    const started = Date.now();
    try {
      return await dispatchCore({ ...request, args: clonePlain(request.args || {}) }, context, started);
    } catch (e) {
      const result = errorResult("Dispatcher internal error", "dispatcher_internal_error");
      return log(name || "unknown", request.args || {}, started, result, context, { stage: "internal_error" });
    }
  });
}

async function callTool(name, args, options = {}) {
  return dispatchTool({ name, args, context: createExecutionContext(options), options });
}

async function callMcpTool(name, args, options = {}) {
  return dispatchTool({ name, args, context: createMcpExecutionContext(options), options });
}

async function callAgentTool(name, args, options = {}) {
  return dispatchTool({ name, args, context: createAgentExecutionContext(options), options });
}

async function callDashboardTool(name, args, options = {}) {
  return dispatchTool({ name, args, context: createDashboardExecutionContext(options), options });
}

async function callInternalTool(name, args, options = {}) {
  return dispatchTool({ name, args, context: createInternalExecutionContext(options), options });
}

module.exports = { dispatchTool, dispatchTestTool, callTool, callMcpTool, callAgentTool, callDashboardTool, callInternalTool, executeApprovedTool, getHandlerMap, getBuiltinRegistry };
