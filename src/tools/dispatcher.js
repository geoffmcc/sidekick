const legacy = require("../tools-legacy");
const dynamicTools = require("../dynamic-tools");
const dbStore = require("../db");
const { redactSensitive } = require("../redact");
const { stripSidekickPrefix } = require("../core/tool-name");
const { RISK_LEVELS } = require("./metadata");
const { buildBuiltinRegistry } = require("./registry");
const { createExecutionContext, childContext, runWithContext, dispatcherMetadata } = require("./context");
const { normalizeResult, errorResult } = require("./result");

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

function withTimeoutAndCancellation(promise, context) {
  const timeoutMs = context.timeoutMs;
  const signal = context.signal;
  if ((!timeoutMs || timeoutMs <= 0) && !signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = fn => value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(resolve)(errorResult("Tool execution cancelled", "cancelled", { cancelled: true }));
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => finish(resolve)(errorResult(`Timed out after ${timeoutMs}ms`, "timeout", { timedOut: true })), timeoutMs);
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(finish(resolve), finish(reject));
  });
}

function log(name, args, started, result, context, extra = {}) {
  const summary = result.content?.[0]?.text?.substring(0, 1000) || (result.isError ? result.code || "error" : "(ok)");
  legacy.logToolCall(name, args, Date.now() - started, !result.isError, summary, dispatcherMetadata(context, extra));
}

async function executeResolvedTool(descriptor, args, context, requestedName = descriptor.name) {
  if (!descriptor.schema || typeof descriptor.schema.safeParse !== "function") {
    return errorResult(`Tool ${descriptor.name} has no executable schema`, "dispatcher_internal_error");
  }
  const parsed = descriptor.schema.safeParse(args || {});
  if (!parsed.success) return validationError(descriptor.name, parsed);

  const policyError = legacy.enforceToolPolicy(descriptor.name, context.source);
  if (policyError) return { ...normalizeResult(policyError), code: "policy_denied", status: "policy_denied" };

  if (!context.approvalBypass) {
    const approval = legacy.getApprovalDecision(descriptor.name, context.source);
    if (approval.required) {
      let item;
      try {
        item = legacy.queueApproval(requestedName, parsed.data, approval);
      } catch (e) {
        return errorResult("Approval queue unavailable: " + e.message, "approval_queue_unavailable");
      }
      const text = `Approval required: ${requestedName} (${approval.risk} risk, source=${approval.source}, mode=${approval.mode}). Queued as ${item.id}. ${approval.reason}.`;
      return errorResult(text, "approval_required", { approvalRequired: true, approvalId: item.id, status: "approval_required" });
    }
  }

  try {
    return normalizeResult(await withTimeoutAndCancellation(
      Promise.resolve(descriptor.handler(parsed.data, { context, signal: context.signal })),
      context
    ));
  } catch (e) {
    return errorResult(redactSensitive(e.message || e), "handler_error");
  }
}

async function dispatchTool(input, maybeArgs, maybeContext) {
  const request = typeof input === "string" ? { name: input, args: maybeArgs, context: maybeContext } : input || {};
  const registry = getBuiltinRegistry();
  const name = request.name || request.descriptor?.name;
  const canonical = stripSidekickPrefix(name || "");
  const context = childContext({ ...(request.options || {}), ...(request.context || {}), toolName: canonical });
  return runWithContext(context, async () => {
    const started = Date.now();
    let descriptor = request.descriptor || registry.get(canonical);
    if (!descriptor) {
      if (registry.has(canonical)) return errorResult(`Ambiguous tool lookup: ${name}`, "dispatcher_internal_error");
      const dynamicDescriptor = resolveDynamicDescriptor(name || canonical);
      if (dynamicDescriptor?.error) {
        const result = errorResult(dynamicDescriptor.error, "risk_unclassified");
        log(name || canonical, request.args || {}, started, result, context, { risk: "unclassified" });
        return result;
      }
      descriptor = dynamicDescriptor;
    }
    if (!descriptor) {
      const result = errorResult("Unknown tool: " + name, "unknown_tool");
      log(name || "unknown", request.args || {}, started, result, context);
      return result;
    }
    if (!RISK_LEVELS.includes(descriptor.risk)) {
      const result = errorResult(`Tool ${descriptor.name} has invalid risk classification`, "risk_unclassified");
      log(descriptor.name, request.args || {}, started, result, context, { risk: descriptor.risk || "unclassified" });
      return result;
    }
    const logName = name || descriptor.name;
    const result = await executeResolvedTool(descriptor, request.args || {}, context, logName);
    log(logName, request.args || {}, started, result, context, { risk: descriptor.risk, approvalId: result.approvalId });
    return result;
  });
}

async function callTool(name, args, options = {}) {
  return dispatchTool({ name, args, context: createExecutionContext(options), options });
}

module.exports = { dispatchTool, callTool, getHandlerMap, getBuiltinRegistry };
