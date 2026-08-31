"use strict";

/**
 * Workflow definition runner.
 *
 * This is the piece that makes registered definitions actually runnable. It is
 * NOT a new execution engine — it drives the primitives Sidekick already owns:
 *
 *   platform_executions      the run's identity, project, risk, lifecycle,
 *                            cancellation and claim/lease (via the shared
 *                            scheduled-execution helpers)
 *   platform_workflows       durable per-run step state and checkpoints
 *   platform_workflow_steps  per-step state and outcome
 *   the tool dispatcher      every step's actual work, with the full schema
 *                            validation, path/tool policy, approval, timeout,
 *                            redaction and audit path
 *
 * Consequences that matter:
 *   - a step is a governed tool call. There is no private child process, no
 *     direct handler access, and no way for a definition to reach a tool the
 *     dispatcher would refuse.
 *   - approvals are honoured, not bypassed. A step that requires approval
 *     parks the run in `waiting`, records where it stopped, and returns the
 *     approval id; the operator approves through the normal approval path and
 *     resumes.
 *   - cancellation is cooperative and cross-process: the claim is re-read
 *     before every step.
 */

const platformKernel = require("../platform/kernel");
const toolContext = require("../tools/context");
const authorization = require("../core/authorization");
const definitionRepository = require("./repository");
const { validateInputs, resolveValue, isTruthy } = require("./definition");
const {
  createScheduledPlatformExecution,
  transitionScheduledPlatformExecution,
  releaseScheduledClaim,
  appendScheduledPlatformEvent,
} = require("../tools/scheduled-execution");

const MAX_STEP_OUTPUT_CHARS = 20000;
const DEFAULT_STEP_TIMEOUT_MS = 120000;
const RUN_CLAIM_LEASE_MS = 1800000;

function truncate(text, limit = MAX_STEP_OUTPUT_CHARS) {
  const value = String(text == null ? "" : text);
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n…[truncated ${value.length - limit} characters]`, truncated: true };
}

function resultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map(part => (part && typeof part.text === "string" ? part.text : "")).join("\n");
}

function parseJsonResult(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Project a dispatcher result into the small shape definitions may reference.
 * Everything a later step can see about an earlier step goes through here.
 */
function projectStepResult(result, expect) {
  const raw = resultText(result);
  const bounded = truncate(raw);
  const ok = !result?.isError;
  const projection = { ok, text: bounded.text, truncated: bounded.truncated, json: null };
  if (expect === "json") projection.json = parseJsonResult(raw);
  else if (ok) projection.json = parseJsonResult(raw);
  return projection;
}

function stepScope(state) {
  return { inputs: state.inputs, steps: state.steps };
}

function checkpointState(workflowId, state, extra = {}) {
  try {
    platformKernel.checkpointWorkflow(workflowId, {
      cursor: "workflow_step",
      next_step: state.nextStep,
      total_steps: state.totalSteps,
      inputs: state.inputs,
      steps: state.steps,
      ...extra,
    }, { source: "workflow-runner" });
  } catch {}
}

function cancelRequested(executionId) {
  if (!executionId) return false;
  try {
    const claim = platformKernel.getExecutionClaim(executionId);
    return Boolean(claim && claim.cancel_requested);
  } catch {
    return false;
  }
}

/**
 * Run (or resume) a workflow definition.
 *
 * `options.resumeWorkflowId` continues an existing run from its recorded
 * checkpoint — the path an operator takes after satisfying an approval.
 */
async function runWorkflowDefinition(name, inputs = {}, options = {}) {
  definitionRepository.ensureStorage();
  const record = definitionRepository.getWorkflowDefinition(name);
  if (!record) return { ok: false, code: "unknown_workflow", error: `Workflow "${name}" is not registered` };
  if (record.state !== "registered") {
    return { ok: false, code: "workflow_unavailable", error: `Workflow "${name}" is ${record.state}` };
  }
  const definition = record.definition;
  const executionContext = toolContext.getExecutionContext();
  let requestedByPrincipalId = options.requestedByPrincipalId || executionContext.authIdentity?.requested_by_principal_id || executionContext.authIdentity?.principal_id || null;
  let actorPrincipalId = options.actorPrincipalId || executionContext.authIdentity?.principal_id || null;
  let actingForPrincipalId = options.actingForPrincipalId || executionContext.authIdentity?.acting_for_principal_id || null;

  let state;
  let workflow;
  let executionId;

  if (options.resumeWorkflowId) {
    workflow = platformKernel.getWorkflow(options.resumeWorkflowId);
    if (!workflow) return { ok: false, code: "unknown_run", error: `Workflow run ${options.resumeWorkflowId} not found` };
    if (workflow.name !== definition.name) {
      return { ok: false, code: "run_mismatch", error: `Run ${options.resumeWorkflowId} belongs to workflow "${workflow.name}"` };
    }
    if (!["paused", "running", "defined"].includes(workflow.state)) {
      return { ok: false, code: "run_not_resumable", error: `Workflow run ${workflow.workflow_id} is ${workflow.state}` };
    }
    if (workflow.actor_principal_id && !actorPrincipalId) {
      return { ok: false, code: "unauthenticated", error: "Resuming a workflow requires the current actor identity" };
    }
    if (workflow.actor_principal_id && workflow.actor_principal_id !== actorPrincipalId) {
      const administrator = authorization.authorize({
        principalId: actorPrincipalId,
        permission: "workflows.manage",
        credentialScopes: executionContext.authIdentity?.scopes,
        delegationId: executionContext.authIdentity?.delegation_id || null,
        resource: { kind: "workflow", workflow_id: workflow.workflow_id },
      });
      if (!administrator.ok) return { ok: false, code: "forbidden", error: "Workflow resume belongs to another principal" };
    }
    const requestedProject = options.project || executionContext.project || null;
    if (workflow.project_id && requestedProject && workflow.project_id !== requestedProject) {
      return { ok: false, code: "project_scope_denied", error: "Workflow resume belongs to another project" };
    }
    // Resume carries the recorded identity only as an input to the current
    // Core authorization check. It is not trusted as a bypass: the current
    // principal must still be authenticated and enabled when the step is
    // dispatched, so disablement/revocation takes effect on resume.
    requestedByPrincipalId = requestedByPrincipalId || workflow.requested_by_principal_id || null;
    if (workflow.actor_principal_id && !actorPrincipalId) {
      return { ok: false, code: "unauthenticated", error: "Resuming an identity-bound workflow requires the current actor identity" };
    }
    let checkpoint = {};
    try {
      checkpoint = JSON.parse(workflow.checkpoint_json || "{}");
    } catch {}
    state = {
      inputs: checkpoint.inputs || {},
      steps: checkpoint.steps || {},
      nextStep: Number.isInteger(checkpoint.next_step) ? checkpoint.next_step : 0,
      totalSteps: definition.steps.length,
    };
    executionId = workflow.execution_id || null;
    if (workflow.state === "paused") platformKernel.startWorkflow(workflow.workflow_id, { source: "workflow-runner" });
  } else {
    const validated = validateInputs(definition, inputs);
    if (!validated.ok) {
      return { ok: false, code: "invalid_inputs", error: `Invalid workflow inputs: ${validated.errors.join("; ")}`, errors: validated.errors };
    }
    state = { inputs: validated.values, steps: {}, nextStep: 0, totalSteps: definition.steps.length };

    const runItem = { id: `wfrun_${Date.now().toString(36)}`, name: definition.name };
    const execution = createScheduledPlatformExecution("workflow", runItem, {
      operationType: "workflow_definition_run",
      state: "running",
      risk: definition.mode === "mutating" ? "medium" : "low",
      projectId: options.project || null,
      allowConcurrent: true,
      metadata: {
        workflow: definition.name,
        workflow_version: definition.version,
        owner_kind: record.owner_kind,
        owner_name: record.owner_name,
        mode: definition.mode,
        steps: definition.steps.length,
        requested_by_principal_id: requestedByPrincipalId,
        actor_principal_id: actorPrincipalId,
        acting_for_principal_id: actingForPrincipalId,
        executed_by_principal_id: actorPrincipalId,
      },
      reason: "workflow definition run started",
    });
    executionId = execution ? execution.execution_id : null;

    workflow = platformKernel.createWorkflow({
      name: definition.name,
      description: definition.title,
      steps: definition.steps.map(step => ({
        name: step.name,
        tool_name: step.tool,
        args: step.args,
        metadata: { title: step.title || step.name, on_error: step.on_error, always: step.always, expect: step.expect },
      })),
      execution_id: executionId,
      project_id: options.project || toolContext.getExecutionContext().project || null,
      created_by: options.actor || toolContext.getExecutionContext().actor || "workflow-runner",
      requested_by_principal_id: requestedByPrincipalId,
      actor_principal_id: actorPrincipalId,
      acting_for_principal_id: actingForPrincipalId,
      executed_by_principal_id: actorPrincipalId,
      source: "workflow-runner",
      metadata: {
        workflow_version: definition.version,
        owner_kind: record.owner_kind,
        owner_name: record.owner_name,
        definition_checksum: record.checksum,
      },
    });
    platformKernel.startWorkflow(workflow.workflow_id, { source: "workflow-runner", actor_id: options.actor });
    checkpointState(workflow.workflow_id, state);
  }

  const claimResult = executionId
    ? platformKernel.claimExecution({ execution_id: executionId, claimed_by: `workflow-run:${process.pid}`, lease_ms: RUN_CLAIM_LEASE_MS })
    : { ok: true, claim: null };
  const claim = claimResult.ok ? claimResult.claim : null;

  const runItem = { id: workflow.workflow_id, platform_execution_id: executionId };
  // A runner is a durable execution identity, not an authorization bypass.
  // Its principal/delegation context is recorded so scheduled work remains
  // inspectable and every step can be evaluated against the same bounded
  // authority through the Core dispatcher.
  const runnerSession = platformKernel.createRunnerSession({
    execution_id: executionId,
    workflow_id: workflow.workflow_id,
    requested_by_principal_id: requestedByPrincipalId,
    actor_principal_id: actorPrincipalId,
    acting_for_principal_id: actingForPrincipalId,
    executed_by_principal_id: actorPrincipalId,
    resource_limits: options.resourceLimits || {},
    metadata: { workflow: definition.name, workflow_version: definition.version },
    source: "workflow-runner",
    actor_id: options.actor || actorPrincipalId || "workflow-runner",
  });
  const started = Date.now();
  const stepReports = [];
  let verdict = "completed";
  let approval = null;
  let failure = null;
  const hasAlwaysSteps = definition.steps.some(step => step.always === true);

  try {
    for (let index = state.nextStep; index < definition.steps.length; index++) {
      const step = definition.steps[index];
      state.nextStep = index;

      const scope = stepScope(state);
      // Advance the kernel cursor for EVERY step, including skipped ones: the
      // durable step index and the runner's index must not drift, or a later
      // step would be recorded against the wrong row.
      platformKernel.advanceWorkflow(workflow.workflow_id, { source: "workflow-runner", actor_id: options.actor });
      const live = platformKernel.getWorkflow(workflow.workflow_id);
      const liveStep = live.steps.find(candidate => candidate.step_index === index);

      // Once a workflow has failed or been cancelled, ordinary steps are
      // skipped but explicitly-marked cleanup steps still run. This keeps
      // resource-owning workflows honest: a browser session, lease, or other
      // temporary resource cannot be stranded merely because an earlier step
      // failed. Cleanup is still a normal governed dispatch.
      if (hasAlwaysSteps && verdict !== "completed" && !step.always) {
        state.steps[step.name] = { ok: false, skipped: true, text: "", json: null };
        if (liveStep) {
          platformKernel.completeWorkflowStep(workflow.workflow_id, liveStep.step_id, {
            success: true,
            source: "workflow-runner",
            actor_id: options.actor,
            result_summary: `skipped after ${verdict}`,
          });
        }
        stepReports.push({ step: step.name, tool: step.tool, status: "skipped", reason: `workflow ${verdict}` });
        state.nextStep = index + 1;
        checkpointState(workflow.workflow_id, state);
        continue;
      }

      if (cancelRequested(executionId) && (!hasAlwaysSteps || !step.always)) {
        verdict = "cancelled";
        if (!hasAlwaysSteps) {
          stepReports.push({ step: step.name, status: "cancelled", reason: "cancel requested before dispatch" });
          break;
        }
        stepReports.push({ step: step.name, status: "cancelled", reason: "cancel requested before dispatch" });
        state.nextStep = index + 1;
        checkpointState(workflow.workflow_id, state);
        continue;
      }

      if (step.when !== undefined && !isTruthy(resolveValue(step.when, scope))) {
        state.steps[step.name] = { ok: true, skipped: true, text: "", json: null };
        if (liveStep) {
          platformKernel.completeWorkflowStep(workflow.workflow_id, liveStep.step_id, {
            success: true,
            source: "workflow-runner",
            actor_id: options.actor,
            result_summary: `skipped: condition not met (${step.when})`,
          });
        }
        stepReports.push({ step: step.name, tool: step.tool, status: "skipped", reason: `condition not met: ${step.when}` });
        state.nextStep = index + 1;
        checkpointState(workflow.workflow_id, state);
        continue;
      }

      const args = resolveValue(step.args, scope);
      appendScheduledPlatformEvent("workflow", runItem, "workflow.step_dispatch", { step: step.name, tool: step.tool, index });

      const stepStarted = Date.now();
      // The single governed dispatch path. `callInternalTool` is the seam
      // Sidekick's own subsystems use; policy, approvals, timeouts, redaction
      // and audit all apply exactly as they would for a direct call.
      let result;
      try {
        result = await require("../tools/dispatcher").callInternalTool(step.tool, args, {
          actor: options.actor || "workflow-runner",
          authIdentity: executionContext.authIdentity || (actorPrincipalId ? {
            principal_id: actorPrincipalId,
            requested_by_principal_id: requestedByPrincipalId,
            acting_for_principal_id: actingForPrincipalId,
            scopes: options.scopes || null,
            delegation_id: options.delegationId || null,
          } : null),
          timeoutMs: step.timeout_ms || options.stepTimeoutMs || DEFAULT_STEP_TIMEOUT_MS,
          executionId,
          project: options.project || undefined,
          correlationId: workflow.workflow_id,
        });
      } catch (error) {
        if (!hasAlwaysSteps) throw error;
        // Preserve cleanup after an unexpected dispatcher exception without
        // echoing an unsanitized error (which could contain a secret). The
        // normal governed result path records the bounded failure and lets an
        // always=true cleanup step run.
        const code = error && error.code ? String(error.code).slice(0, 120) : "tool_dispatch_error";
        result = {
          isError: true,
          code,
          content: [{ type: "text", text: `Workflow tool dispatch failed (${code})` }],
        };
      }
      const durationMs = Date.now() - stepStarted;

      if (result && result.approvalRequired) {
        // Park rather than fail: the operator has a decision to make, and the
        // run must be resumable at exactly this step afterwards.
        approval = { step: step.name, tool: step.tool, approval_id: result.approvalId || null };
        state.nextStep = index;
        checkpointState(workflow.workflow_id, state, { awaiting_approval: approval });
        platformKernel.pauseWorkflow(workflow.workflow_id, { source: "workflow-runner", actor_id: options.actor });
        stepReports.push({ step: step.name, tool: step.tool, status: "approval_required", approval_id: approval.approval_id, duration_ms: durationMs });
        verdict = "awaiting_approval";
        break;
      }

      const projection = projectStepResult(result, step.expect);
      state.steps[step.name] = projection;
      if (liveStep) {
        // A tolerated failure (on_error: "continue") is still recorded as a
        // FAILED step; `advance` keeps the run moving without pretending it
        // succeeded.
        platformKernel.completeWorkflowStep(workflow.workflow_id, liveStep.step_id, {
          source: "workflow-runner",
          actor_id: options.actor,
          result_summary: truncate(projection.text, 500).text,
          error: projection.ok ? null : (result?.code || "tool_error"),
          error_category: projection.ok ? null : (result?.code || "tool_error"),
          advance: step.on_error === "continue" || step.always,
        });
      }
      stepReports.push({
        step: step.name,
        title: step.title || step.name,
        tool: step.tool,
        status: projection.ok ? "ok" : "failed",
        duration_ms: durationMs,
        error: projection.ok ? undefined : truncate(projection.text, 500).text,
        error_code: projection.ok ? undefined : (result?.code || null),
      });

      state.nextStep = index + 1;
      checkpointState(workflow.workflow_id, state);

      if (!projection.ok && step.on_error === "fail") {
        verdict = "failed";
        failure = { step: step.name, tool: step.tool, error: truncate(projection.text, 1000).text, code: result?.code || null };
        if (hasAlwaysSteps) {
          // Continue through the remaining steps so `always` cleanup steps can
          // release resources. Non-cleanup steps are skipped at the top of the
          // next iteration.
          continue;
        }
        break;
      }
    }
  } catch (error) {
    verdict = "failed";
    failure = { step: definition.steps[state.nextStep]?.name || null, error: String(error && error.message ? error.message : error) };
  }

  const result = resolveValue(definition.result, stepScope(state));

  if (verdict === "completed") {
    transitionScheduledPlatformExecution("workflow", runItem, "completed", {
      reason: "workflow definition run completed",
      result_status: "success",
      result_summary: `${definition.name} completed ${stepReports.filter(s => s.status === "ok").length}/${definition.steps.length} steps`,
    });
  } else if (verdict === "awaiting_approval") {
    transitionScheduledPlatformExecution("workflow", runItem, "waiting", {
      reason: "workflow step requires approval",
      result_status: "waiting",
    });
  } else if (verdict === "cancelled") {
    platformKernel.failWorkflow(workflow.workflow_id, { source: "workflow-runner", reason: "cancelled" });
    transitionScheduledPlatformExecution("workflow", runItem, "cancelled", { reason: "cancel requested", result_status: "cancelled" });
  } else {
    platformKernel.failWorkflow(workflow.workflow_id, { source: "workflow-runner", reason: failure?.error || "workflow step failed" });
    transitionScheduledPlatformExecution("workflow", runItem, "failed", {
      reason: "workflow definition run failed",
      result_status: "failure",
      result_summary: failure ? `${failure.step}: ${failure.error}` : "workflow failed",
    });
  }

  if (executionId && claim && verdict !== "awaiting_approval") releaseScheduledClaim(executionId, claim);
  if (runnerSession && verdict !== "awaiting_approval") {
    if (verdict === "completed") platformKernel.completeRunnerSession(runnerSession.runner_id, { source: "workflow-runner", actor_id: options.actor || actorPrincipalId || "workflow-runner" });
    else platformKernel.terminateRunnerSession(runnerSession.runner_id, { source: "workflow-runner", actor_id: options.actor || actorPrincipalId || "workflow-runner", reason: failure?.error || verdict });
  }

  return {
    ok: verdict === "completed",
    status: verdict,
    workflow: definition.name,
    version: definition.version,
    title: definition.title,
    owner: record.owner_name ? `${record.owner_kind}:${record.owner_name}` : record.owner_kind,
    run_id: workflow.workflow_id,
    execution_id: executionId,
    duration_ms: Date.now() - started,
    inputs: state.inputs,
    steps: stepReports,
    evidence: state.steps,
    result,
    approval,
    failure,
  };
}

module.exports = { runWorkflowDefinition, projectStepResult, MAX_STEP_OUTPUT_CHARS };
