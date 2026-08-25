const legacy = require("../tools-legacy");
const dynamicTools = require("../dynamic-tools");
const dbStore = require("../db");
const { stripSidekickPrefix } = require("../core/tool-name");
const { RISK_LEVELS } = require("./metadata");
const { getCanonicalRegistry } = require("./canonical-registry");
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
const authorization = require("../core/authorization");
const { recordSecurityEvent } = require("../core/security-audit");
const { performance } = require("perf_hooks");

const APPROVED_EXECUTION_CAPABILITY = Symbol("sidekick.approvedExecution");
const TEST_DESCRIPTOR_CAPABILITY = Symbol("sidekick.testDescriptorExecution");

function roundMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function createLatencyTracker() {
  const started = performance.now();
  const phaseMs = Object.create(null);
  let previous = started;
  let activePhase = "dispatch";
  let finished = null;

  return {
    mark(nextPhase) {
      if (finished) return;
      const now = performance.now();
      phaseMs[activePhase] = roundMilliseconds((phaseMs[activePhase] || 0) + now - previous);
      activePhase = nextPhase;
      previous = now;
    },
    finish() {
      if (finished) return finished;
      const now = performance.now();
      phaseMs[activePhase] = roundMilliseconds((phaseMs[activePhase] || 0) + now - previous);
      finished = { total_ms: roundMilliseconds(now - started), phase_ms: { ...phaseMs } };
      return finished;
    },
  };
}

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
  return getCanonicalRegistry({ includeActiveModules: true });
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

function requiredToolPermission(descriptor, args = {}) {
  if (descriptor.authorizationPermission) return descriptor.authorizationPermission;
  if (descriptor.name === "capability") {
    // Capability packs are a critical tool because some actions activate
    // executable module code.  That risk must not make harmless inventory and
    // inspection unavailable to administrators, who are explicitly granted
    // packs.read.  Keep lifecycle changes behind the stronger manage grant.
    const readActions = new Set(["list", "available", "show", "inspect", "validate", "health", "doctor"]);
    return readActions.has(args.action || "list") ? "packs.read" : "packs.manage";
  }
  if (descriptor.name === "workflow") {
    return ["run", "resume"].includes(args.action) ? "workflows.execute" : "workflows.read";
  }
  if (descriptor.name === "secret") {
    if (args.action === "list") return "secrets.read_metadata";
    if (args.action === "get") return "secrets.read";
    return "secrets.manage";
  }
  if (descriptor.risk === "critical") return "tools.execute_critical";
  if (descriptor.risk === "high") return "tools.execute_high";
  return "tools.execute";
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
    const latency = context.latencyTracker?.finish();
    legacy.logToolCall(name, clonePlain(args), Date.now() - started, !result.isError, summary, dispatcherMetadata(context, {
      ...extra,
      ...(latency ? { latency } : {}),
    }));
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
  const rawArgs = clonePlain(args || {});
  const parsed = descriptor.schema.safeParse(rawArgs);
  if (!parsed.success) {
    context.latencyTracker?.mark("validation");
    return validationError(descriptor.name, parsed);
  }
  // Refuse stale descriptors that silently strip newly introduced safety
  // arguments before a handler or execution node can run a different plan.
  const safetyArguments = {
    dev_verify: ["dry_run"],
    dev_change_summary: ["include_ignored"],
    semantic_repo: ["include", "exclude", "relevant_files"],
    dev_repo_profile: ["include", "exclude"],
  }[descriptor.name];
  if (safetyArguments && safetyArguments.some(key => Object.prototype.hasOwnProperty.call(rawArgs, key) && parsed.data[key] === undefined)) {
    return errorResult(`Tool ${descriptor.name} is using a stale schema; refresh the executing capability before retrying`, "stale_tool_schema");
  }
  const executionArgs = freezeDeep(clonePlain(parsed.data));
  context.latencyTracker?.mark("validation");

  const requiresIdentity = descriptor.name === "secret";
  if (requiresIdentity && !context.authIdentity?.principal_id) {
    return errorResult("Authentication required for secret operations", "unauthenticated");
  }

  // Authenticated HTTP/MCP callers are subject to Core authorization in
  // addition to the existing source policy and approval layers. Explicit
  // legacy API-key compatibility remains transitional and is intentionally
  // visible as a separate authentication method.
  if (context.authIdentity?.principal_id) {
    const permission = requiredToolPermission(descriptor, executionArgs);
    const decision = authorization.authorize({
      principalId: context.authIdentity.principal_id,
      permission,
      credentialScopes: context.authIdentity.scopes,
      delegationId: context.authIdentity.delegation_id || context.authIdentity.delegationId || null,
      resource: { tool: descriptor.name, source: context.source },
    });
    if (!decision.ok) {
      try {
        recordSecurityEvent("authorization.denied", {
          context,
          principalId: context.authIdentity.principal_id,
          details: { permission, tool: descriptor.name, code: decision.code },
        });
      } catch {}
      return errorResult(`Authorization denied: ${decision.code}`, "authorization_denied", { authorization: decision });
    }
  }

  context.latencyTracker?.mark("policy");

  let policyError;
  try {
    policyError = legacy.enforceToolPolicy(descriptor.name, context.source, executionArgs);
  } catch (e) {
    return errorResult("Policy evaluation failed", "policy_evaluation_failed");
  }
  if (policyError) return { ...normalizeResult(policyError), code: "policy_denied", status: "policy_denied" };

  context.latencyTracker?.mark("approval");

  if (!options.approvedExecution) {
    let approval;
    try {
      // executionArgs is the frozen, validated object that will be dispatched,
      // so a per-action risk decision cannot disagree with what actually runs.
      approval = legacy.getApprovalDecision(descriptor.name, context.source, executionArgs);
    } catch (e) {
      return errorResult("Approval evaluation failed", "approval_evaluation_failed");
    }
    if (context.authorityApprovalRequired || approval.required) {
      let item;
      try {
        const authorityApproval = context.authorityApprovalRequired ? { required: true, risk: context.authorityRisk || approval.risk, mode: "agent-authority-envelope", reason: context.authorityReason || "task authority requires explicit approval" } : approval;
        item = legacy.queueApproval(requestedName, executionArgs, authorityApproval, context);
      } catch (e) {
        return errorResult("Approval queue unavailable: " + e.message, "approval_queue_unavailable");
      }
      const text = `Approval required: ${requestedName} (${approval.risk} risk, source=${approval.source}, mode=${approval.mode}). Queued as ${item.id}. ${approval.reason}.`;
      return errorResult(text, "approval_required", { approvalRequired: true, approvalId: item.id, status: "approval_required" });
    }
  }

  context.latencyTracker?.mark("handler");
  try {
    // Placement is an additive execution location. Governance has already
    // validated, authorized, and approved the canonical call above; the node
    // dispatcher receives only the frozen parsed arguments and must validate
    // the descriptor and workspace again locally before invoking its handler.
    const nodeResult = await require("../node/dispatch").maybeExecute(descriptor, executionArgs, context);
    if (nodeResult) return normalizeResult(nodeResult);
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
  context.latencyTracker?.mark("registry");
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
  context.latencyTracker?.mark("resolution");
  if (!descriptor) {
    const result = errorResult("Unknown tool: " + name, "unknown_tool");
    return log(name || "unknown", request.args || {}, started, result, context);
  }
  if (!RISK_LEVELS.includes(descriptor.risk)) {
    const result = errorResult(`Tool ${descriptor.name} has invalid risk classification`, "risk_unclassified");
    return log(descriptor.name, request.args || {}, started, result, context, { risk: descriptor.risk || "unclassified" });
  }
  if (typeof descriptor.source === "string" && descriptor.source.startsWith("module:")) {
    // The persisted module lifecycle state is authoritative across processes:
    // a module disabled in any process stops dispatching here immediately,
    // without waiting for a restart or the reconciliation timer.
    const moduleName = descriptor.source.slice("module:".length);
    const gate = require("../modules/loader").checkModuleDispatchable(moduleName);
    if (!gate.ok) {
      const result = errorResult(`Tool ${descriptor.name} belongs to module "${moduleName}" which is ${gate.state}`, "module_disabled");
      return log(descriptor.name, request.args || {}, started, result, context, { risk: descriptor.risk });
    }
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

/**
 * Dispatch a step the continuation layer has already authorized.
 *
 * ADR docs/adr-approval-continuation.md §1: the task runner is the only
 * executor of plan steps. This is the seam it uses — it carries the
 * approved-execution capability so the dispatcher does not re-queue an
 * approval, but performs NO approval bookkeeping of its own. Claiming,
 * verifying, recording, and terminalising the approval are the continuation
 * transactions' job (T3/T4/T6), and duplicating any of that here would
 * reintroduce the two-writers problem the ADR removes.
 *
 * IT VERIFIES ITS OWN AUTHORIZATION rather than trusting the caller. The seam
 * carries `APPROVED_EXECUTION_CAPABILITY`, so reaching it with a fabricated
 * `meta` would otherwise execute any tool at any risk with no approval at all —
 * the capability Symbol is module-private and cannot be forged, but the whole
 * module is re-exported as `require("./tools").dispatcher`, so the function
 * itself is reachable. Decorative parameters on a privileged seam are how a
 * capability leaks; these are checked.
 *
 * The approval must exist, be `executing`, be bound to the caller's `taskId`
 * through the checkpoint, and match the `operationId` recorded by the claim
 * that authorized this dispatch.
 */
async function executeAuthorizedTaskStep(toolName, args, meta = {}) {
  let approval;
  try {
    const approvalStore = require("../approvals/store");
    approvalStore.ensureApprovalContinuationSchema();
    approval = meta.approvalId ? approvalStore.getApproval(meta.approvalId) : null;
    if (!approval) return errorResult("Authorized step dispatch requires a live approval", "authorized_step_unauthorized");
    if (approval.status !== "executing") return errorResult("Authorized step dispatch requires an executing approval", "authorized_step_unauthorized");
    if (!approval.task_id || approval.task_id !== meta.taskId) return errorResult("Authorized step dispatch is not bound to this task", "authorized_step_unauthorized");
    if (!meta.operationId || approval.operation_id !== meta.operationId) return errorResult("Authorized step dispatch does not match the claim", "authorized_step_unauthorized");
    if (approval.tool_name !== toolName) return errorResult("Authorized step dispatch does not match the approved tool", "authorized_step_unauthorized");

    const checkpoint = approvalStore.getCheckpoint(approval.task_id);
    if (!checkpoint || checkpoint.current_approval_id !== approval.approval_id) {
      return errorResult("Authorized step dispatch is not the task's live approval", "authorized_step_unauthorized");
    }
    if (checkpoint.state !== "running") {
      return errorResult("Authorized step dispatch requires a claimed task", "authorized_step_unauthorized");
    }

    // AUTHENTICATE THE ARGUMENTS, not just the tool. This seam does not run
    // `verifyClaim`, so without this it would enforce a strictly weaker rule
    // than the runner path: an attacker reaching it could run the approved TOOL
    // with arguments nobody approved. Both privileged entry points must apply
    // the same check, or the weaker one is the one that gets used.
    const { argsDigest } = require("../approvals/keys");
    if (argsDigest(args || {}) !== approval.args_digest) {
      return errorResult("Authorized step dispatch does not match the approved arguments", "authorized_step_unauthorized");
    }
  } catch {
    return errorResult("Approval continuation storage is unavailable", "approval_continuation_unavailable");
  }

  return dispatchTool({
    name: toolName,
    args,
    context: createApprovalExecutionContext({
      actor: meta.actor || "task-runner",
      approvalId: meta.approvalId || null,
      operationId: meta.operationId || null,
      idempotencyKey: meta.idempotencyKey || null,
      executionId: meta.operationId || null,
      timeoutMs: meta.timeoutMs || null,
      taskId: meta.taskId || null,
      parentId: meta.parentId || null,
      rootExecutionId: meta.rootExecutionId || null,
      correlationId: meta.approvalId || meta.taskId || null,
      approvedExecution: true,
    }),
    internalCapability: APPROVED_EXECUTION_CAPABILITY,
  });
}

async function executeApprovedTool({ approvalId, reviewer = "system", reviewerPrincipalId = null, source } = {}) {
  // ADR §1: an approval authorizes an action, it never performs one. For a
  // TASK-ORIGINATED approval this call is a STATE TRANSITION (T2) — mark the
  // approval approved and the task runnable, atomically — and returns. The task
  // runner reclaims the task and executes the step through the normal path.
  //
  // Approvals that did not originate from a task (a direct dashboard or MCP
  // call) keep today's standalone execution below. The two are distinguished
  // by whether `task_id` is present on the approval.
  let taskApproval = null;
  try {
    const approvalStore = require("../approvals/store");
    approvalStore.ensureApprovalContinuationSchema();
    const row = approvalStore.getApproval(approvalId);
    if (row && row.task_id) taskApproval = row;
  } catch {
    // A continuation-storage failure must not silently fall through to the
    // standalone executor: that would dispatch a task-originated tool outside
    // the runner and discard its result, which is the bug this ADR fixes.
    return errorResult("Approval continuation storage is unavailable", "approval_continuation_unavailable");
  }

  if (taskApproval) {
    const { approve } = require("../approvals/continuation");
    const outcome = approve({ approvalId, approverIdentity: reviewer, approverPrincipalId: reviewerPrincipalId });
    if (!outcome.ok) {
      const message = outcome.code === "task_not_waiting"
        ? `Approval ${approvalId} was decided, but its task is no longer waiting for it`
        : `Approval ${approvalId} could not be approved (${outcome.code})`;
      return errorResult(message, outcome.code);
    }
    // Honesty check: "will be resumed by the task runner" is only true when a
    // task runner is actually alive. The resume scheduler writes a heartbeat
    // into the approvals store every poll; absent or stale means Brain is
    // disabled or the agent service is down, and the task will simply stay
    // parked. Report that instead of fabricating resumption. Fail closed: an
    // unreadable heartbeat is reported as "not detected", never as live.
    let runnerWarning = null;
    try {
      const liveness = require("../approvals/store").isTaskRunnerLive();
      if (!liveness.live) {
        runnerWarning = `No active task runner was detected (${liveness.reason}). The task is runnable but will remain parked until a task runner starts (agent service with SIDEKICK_BRAIN_ENABLED=1).`;
      }
    } catch {
      runnerWarning = "Task runner liveness could not be determined. The task is runnable but may remain parked until a task runner claims it.";
    }
    return normalizeResult({
      content: [{
        type: "text",
        text: `Approved ${approvalId} for task ${outcome.taskId}. ` +
          (runnerWarning || "The task is runnable and will be resumed by the task runner."),
      }],
      approvalId,
      taskId: outcome.taskId,
      status: "task_runnable",
      ...(runnerWarning ? { warning: runnerWarning } : {}),
    });
  }

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
        authIdentity: reviewerPrincipalId ? { principal_id: reviewerPrincipalId, principal_type: "human" } : null,
        provenance: { approved_by: reviewerPrincipalId, executed_by: reviewerPrincipalId },
        approvalId,
        operationId: claim.operationId,
        idempotencyKey: claim.idempotencyKey,
        executionId: claim.operationId,
        timeoutMs: claim.timeoutMs,
        sessionId: claim.sessionId || null,
        project: claim.project || null,
        taskId: claim.taskId || null,
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
  const latencyTracker = createLatencyTracker();
  const context = childContext({ ...publicContextInput(request), ...(trusted ? { approvedExecution: true, approvalId: request.context?.approvalId } : {}), toolName: canonical, latencyTracker });
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

module.exports = { dispatchTool, dispatchTestTool, callTool, callMcpTool, callAgentTool, callDashboardTool, callInternalTool, executeApprovedTool, executeAuthorizedTaskStep, getHandlerMap, getBuiltinRegistry, requiredToolPermission };
