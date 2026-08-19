"use strict";

// Runbook tool family: runbook.
//
// Extracted from src/tools-legacy.js. Multi-step operational runbooks with
// platform-execution tracking. Steps run via execSync; scheduling primitives
// come from the shared scheduled-execution module; the platform kernel tracks
// claims and transitions. Never imports tools-legacy.js.
// recoverStrandedRunbooks moves here with its store and is re-exported through
// the facade for src/agent.js. `runbook` is `critical` risk, preserved from
// src/tools/metadata.js.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { z } = require("zod");
const { childProcessEnv } = require("../../security/child-process");
const evolveCommon = require("../../evolve/common");
const platformKernel = require("../../platform/kernel");
const toolContext = require("../context");
const {
  createScheduledPlatformExecution,
  transitionScheduledPlatformExecution,
  releaseScheduledClaim,
  appendScheduledPlatformEvent,
} = require("../scheduled-execution");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const RUNBOOK_FILE = path.join(DATA_DIR, "runbooks.json");
const MAX_RUNBOOKS = 20;
const MAX_ACTIVE_INSTANCES = 5;
const MAX_STEPS_PER_RUNBOOK = 20;
const STEP_TIMEOUT_MS = 60000;
// Claim lease sized for the worst-case autonomous run (20 steps x step +
// verify + rollback timeouts ~= 27 min) instead of using a renewal timer — no
// timer means no path to a perpetually-renewed leak.
const RUNBOOK_CLAIM_LEASE_MS = 3600000;
const RUNBOOK_ABANDON_AGE_MS = 30 * 60 * 1000;
const RUNBOOK_ACTIVE_LEDGER_STATES = new Set(["queued", "running", "waiting"]);

function loadRunbooks() {
  try {
    if (fs.existsSync(RUNBOOK_FILE)) {
      return JSON.parse(fs.readFileSync(RUNBOOK_FILE, "utf8"));
    }
  } catch {}
  return { definitions: {}, instances: {} };
}

// The JSON document remains a compatibility mirror, but the platform
// execution ledger owns lifecycle status once an instance has been created.
// This keeps interactive calls safe when another process has advanced or
// terminalized the execution since this process loaded runbooks.json.
function syncInstanceFromLedger(instance) {
  if (!instance?.platform_execution_id) return { execution: null, changed: false };
  const execution = platformKernel.getExecution(instance.platform_execution_id);
  if (!execution) return { execution: null, changed: false };
  const mirroredStatus = execution.state === "cancelled" && instance.status === "aborted"
    ? "aborted"
    : execution.state;
  const changed = instance.status !== mirroredStatus;
  if (changed) instance.status = mirroredStatus;
  return { execution, changed };
}

function syncInstancesFromLedger(data) {
  let changed = false;
  const failures = [];
  for (const instance of Object.values(data.instances || {})) {
    try {
      if (syncInstanceFromLedger(instance).changed) changed = true;
    } catch (error) {
      // Mirror sync stays best-effort per instance, but a failed sync is
      // collected and logged instead of vanishing: an instance whose ledger
      // read keeps failing would otherwise silently drift stale forever.
      failures.push({ instance: instance?.id || "(unknown)", error: String(error.message || error) });
    }
  }
  if (failures.length > 0) {
    console.error(`[Runbook] Failed to sync ${failures.length} instance(s) from the execution ledger: ` +
      failures.map(f => `${f.instance}: ${f.error}`).join("; "));
  }
  return changed;
}

function checkpointRunbookCursor(instance, claim, stepIndex, totalSteps) {
  if (!instance?.platform_execution_id || !claim) return { ok: true };
  return platformKernel.checkpointExecution({
    execution_id: instance.platform_execution_id,
    claimed_by: claim.claimed_by,
    claim_epoch: claim.claim_epoch,
    checkpoint: {
      cursor: "runbook_step",
      completed_step: stepIndex,
      next_step: stepIndex + 1,
      total_steps: totalSteps,
    },
  });
}

// Phase 4/B restart recovery: an instance stranded `running` by a crash used
// to hold one of the MAX_ACTIVE_INSTANCES capacity slots forever. An instance
// is abandoned when no live claim exists AND its execution is orphaned or has
// sat in `running` past the worst-case runtime. Guided instances parked
// between steps (execution `waiting`) are never touched, and instances whose
// execution already reached a terminal state have their file status synced.
function recoverStrandedRunbooks(details = {}) {
  try {
    platformKernel.recoverOrphanedExecutions({ source: details.source || "runbook", actor_id: details.actor || null });
  } catch (e) {}
  const data = loadRunbooks();
  const recovered = [];
  const nowMs = Date.now();
  for (const instance of Object.values(data.instances)) {
    if (!instance.platform_execution_id) continue;
    const wasTerminal = ["aborted", "completed", "partial", "failed", "cancelled", "timed_out", "rolled_back", "rollback_failed"].includes(instance.status);
    try {
      const claim = platformKernel.getExecutionClaim(instance.platform_execution_id);
      const exec = platformKernel.getExecution(instance.platform_execution_id);
      if (!exec) continue;
      if (exec.state === "waiting") {
        instance.status = "waiting";
        continue;
      }
      if (claim && claim.claimed_by && claim.lease_expires_at && claim.lease_expires_at > new Date().toISOString()) {
        instance.status = exec.state;
        continue;
      }
      if (platformKernel.TERMINAL_STATES.has(exec.state)) {
        instance.status = exec.state === "cancelled" && instance.status === "aborted" ? "aborted" : exec.state;
        if (!wasTerminal) recovered.push(instance.id);
        continue;
      }
      const isOrphaned = exec.state === "orphaned";
      const isStaleRunning = exec.state === "running" && nowMs - (instance.started || 0) > RUNBOOK_ABANDON_AGE_MS;
      if (!isOrphaned && !isStaleRunning) continue;
      const checkpoint = claim?.checkpoint || {};
      if (Number.isInteger(checkpoint.next_step) && checkpoint.next_step >= 0) {
        instance.currentStep = checkpoint.next_step;
      }
      if (isOrphaned) {
        platformKernel.transitionExecution(instance.platform_execution_id, "running", { source: details.source || "runbook", actor_id: details.actor || null, reason: "recovering orphaned runbook instance", correlation_id: instance.id });
      }
      platformKernel.transitionExecution(instance.platform_execution_id, "failed", { source: details.source || "runbook", actor_id: details.actor || null, reason: "runbook instance abandoned after runner crash", result_status: "failure", error_category: "timeout", result_summary: `Runbook instance ${instance.id} abandoned at step ${instance.currentStep}`, correlation_id: instance.id });
      instance.status = "failed";
      instance.abandoned = true;
      recovered.push(instance.id);
    } catch (e) {}
  }
  if (recovered.length > 0) saveRunbooks(data);
  return { recovered: recovered.length, instances: recovered };
}

function saveRunbooks(data) {
  fs.writeFileSync(RUNBOOK_FILE, JSON.stringify(data, null, 2));
}

function generateRunbookId() {
  return "rb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function sidekick_runbook({ action, name, mode, steps, runbook_id, step_index }) {
  const data = loadRunbooks();
  const actorId = toolContext.getExecutionContext().actor;
  const execMode = mode || "autonomous";
  const ledgerMirrorChanged = syncInstancesFromLedger(data);
  if (ledgerMirrorChanged) saveRunbooks(data);

  if (action === "create") {
    if (!name || !steps || steps.length === 0) {
      return { content: [{ type: "text", text: "name and steps required" }], isError: true };
    }
    if (steps.length > MAX_STEPS_PER_RUNBOOK) {
      return { content: [{ type: "text", text: `Max steps per runbook: ${MAX_STEPS_PER_RUNBOOK}` }], isError: true };
    }
    if (Object.keys(data.definitions).length >= MAX_RUNBOOKS) {
      return { content: [{ type: "text", text: `Max runbooks reached (${MAX_RUNBOOKS})` }], isError: true };
    }

    const id = generateRunbookId();
    data.definitions[id] = {
      name,
      steps,
      created: Date.now()
    };
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Runbook created: ${id} (${name})\nSteps: ${steps.length}` }] };
  }

  if (action === "list") {
    const entries = Object.entries(data.definitions);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No runbooks defined" }] };
    }
    const list = entries.map(([id, rb]) => {
      const instances = Object.values(data.instances).filter(i => i.definitionId === id && i.status === "running").length;
      return `${id}: ${rb.name} (${rb.steps.length} steps, ${instances} active)`;
    }).join("\n");
    return { content: [{ type: "text", text: `Runbooks (${entries.length}/${MAX_RUNBOOKS}):\n\n${list}` }] };
  }

  if (action === "get") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let rb = null;
    let rbId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { rb = def; rbId = id; break; }
      }
    } else {
      rb = data.definitions[runbook_id];
    }
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }
    const stepsList = rb.steps.map((s, i) => `${i + 1}. ${s.name}\n   Command: ${s.command}\n   ${s.rollback ? "Rollback: " + s.rollback : ""}\n   ${s.verify_command ? "Verify: " + s.verify_command : ""}`).join("\n\n");
    return { content: [{ type: "text", text: `Runbook: ${rbId} (${rb.name})\n\n${stepsList}` }] };
  }

  if (action === "delete") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let targetId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { targetId = id; break; }
      }
    }
    if (!data.definitions[targetId]) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }
    delete data.definitions[targetId];
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Deleted runbook: ${targetId}` }] };
  }

  if (action === "start") {
    if (!runbook_id && !name) {
      return { content: [{ type: "text", text: "runbook_id or name required" }], isError: true };
    }
    let rb = null;
    let rbId = runbook_id;
    if (name) {
      for (const [id, def] of Object.entries(data.definitions)) {
        if (def.name === name) { rb = def; rbId = id; break; }
      }
    } else {
      rb = data.definitions[runbook_id];
    }
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook not found" }], isError: true };
    }

    const activeCount = Object.values(data.instances).filter(i => RUNBOOK_ACTIVE_LEDGER_STATES.has(i.status)).length;
    if (activeCount >= MAX_ACTIVE_INSTANCES) {
      return { content: [{ type: "text", text: `Max active instances reached (${MAX_ACTIVE_INSTANCES})` }], isError: true };
    }

    const instanceId = generateRunbookId();
    data.instances[instanceId] = {
      id: instanceId,
      definitionId: rbId,
      status: "running",
      currentStep: 0,
      mode: execMode,
      started: Date.now(),
      results: []
    };
    createScheduledPlatformExecution("runbook", data.instances[instanceId], {
      operationType: "runbook_execution",
      state: "running",
      risk: "critical",
      metadata: { definition_id: rbId, mode: execMode, steps: rb.steps.length, runbook_name: rb.name },
      reason: "runbook started",
    });
    saveRunbooks(data);

    // Liveness claim (Phase 4/B): the lease marks this instance as actively
    // running so recoverStrandedRunbooks can tell a live run from one
    // abandoned by a crash. The lease is sized for the worst-case autonomous
    // run instead of using a renewal timer — no timer means no path to a
    // perpetually-renewed leak; a crash self-heals at lease expiry.
    const startedInstance = data.instances[instanceId];
    const startClaimRes = startedInstance.platform_execution_id ? platformKernel.claimExecution({ execution_id: startedInstance.platform_execution_id, claimed_by: `runbook-run:${process.pid}`, lease_ms: RUNBOOK_CLAIM_LEASE_MS }) : { ok: true, claim: null };
    const startClaim = startClaimRes.ok ? startClaimRes.claim : null;
    if (startClaim && startClaim.cancel_requested) {
      startedInstance.status = "cancelled";
      transitionScheduledPlatformExecution("runbook", startedInstance, "cancelled", { reason: "cancel requested before first step", result_status: "cancelled" });
      saveRunbooks(data);
      releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
      return { content: [{ type: "text", text: `Runbook instance ${instanceId} cancelled before dispatch` }] };
    }

    const startCheckpoint = checkpointRunbookCursor(startedInstance, startClaim, -1, rb.steps.length);
    if (!startCheckpoint.ok) {
      releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
      return { content: [{ type: "text", text: `Runbook instance ${instanceId} could not establish its execution checkpoint` }], isError: true };
    }

    if (execMode === "autonomous") {
      let output = `Starting autonomous runbook: ${rbId} (${rb.name})\n\n`;
      for (let i = 0; i < rb.steps.length; i++) {
        const step = rb.steps[i];
        // Cooperative cancel (B4): re-read the claim from the ledger before
        // dispatching each step so a cross-process cancel request stops the
        // run at the next step boundary. The claimant terminalizes its own
        // execution; already-completed steps are not rolled back.
        if (startedInstance.platform_execution_id) {
          const liveClaim = platformKernel.getExecutionClaim(startedInstance.platform_execution_id);
          if (liveClaim && liveClaim.cancel_requested) {
            output += `Cancel requested — stopping before step ${i + 1}/${rb.steps.length} (${step.name})\n`;
            startedInstance.status = "cancelled";
            startedInstance.currentStep = i;
            transitionScheduledPlatformExecution("runbook", startedInstance, "cancelled", {
              reason: "cancel requested during autonomous run",
              result_status: "cancelled",
              result_summary: output,
            });
            saveRunbooks(data);
            releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
            return { content: [{ type: "text", text: output }] };
          }
        }
        output += `Step ${i + 1}/${rb.steps.length}: ${step.name}\n`;
        appendScheduledPlatformEvent("runbook", data.instances[instanceId], "runbook.step_started", { step: i, name: step.name });
        try {
          const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024, env: childProcessEnv() });
          output += `  ✓ Success\n`;
          appendScheduledPlatformEvent("runbook", data.instances[instanceId], "runbook.step_completed", { step: i, name: step.name });
          if (step.verify_command) {
            try {
              const verifyResult = execSync(step.verify_command, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024, env: childProcessEnv() });
              output += `  ✓ Verified\n`;
              appendScheduledPlatformEvent("runbook", data.instances[instanceId], "runbook.step_verified", { step: i, name: step.name });
            } catch (e) {
              output += `  ✗ Verification failed: ${e.message}\n`;
              if (step.rollback) {
                output += `  Rolling back...\n`;
                try {
                  execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024, env: childProcessEnv() });
                  output += `  ✓ Rollback successful\n`;
                } catch (re) {
                  output += `  ✗ Rollback failed: ${re.message}\n`;
                }
              }
              data.instances[instanceId].status = "failed";
              transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "failed", {
                reason: "runbook verification failed",
                result_status: "failure",
                error_category: evolveCommon.errorCategory(e.message),
                result_summary: output,
              });
              saveRunbooks(data);
              releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
              return { content: [{ type: "text", text: output }], isError: true };
            }
          }
          data.instances[instanceId].results.push({ step: i, success: true });
          const checkpoint = checkpointRunbookCursor(startedInstance, startClaim, i, rb.steps.length);
          if (!checkpoint.ok) {
            releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
            return { content: [{ type: "text", text: output + "\n✗ Execution checkpoint rejected" }], isError: true };
          }
        } catch (e) {
          output += `  ✗ Failed: ${e.message}\n`;
          if (step.rollback) {
            output += `  Rolling back...\n`;
            try {
                  execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024, env: childProcessEnv() });
              output += `  ✓ Rollback successful\n`;
            } catch (re) {
              output += `  ✗ Rollback failed: ${re.message}\n`;
            }
          }
          data.instances[instanceId].status = "failed";
          data.instances[instanceId].currentStep = i;
          transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "failed", {
            reason: "runbook step failed",
            result_status: "failure",
            error_category: evolveCommon.errorCategory(e.message),
            result_summary: output,
          });
          saveRunbooks(data);
          releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
          return { content: [{ type: "text", text: output }], isError: true };
        }
      }
      data.instances[instanceId].status = "completed";
      transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "completed", {
        reason: "runbook completed",
        result_status: "success",
        result_summary: output,
      });
      saveRunbooks(data);
      releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
      output += `\n✓ Runbook completed successfully`;
      return { content: [{ type: "text", text: output }] };
    } else {
      const step = rb.steps[0];
      let output = `Starting guided runbook: ${rbId} (${rb.name})\n\n`;
      output += `Step 1/${rb.steps.length}: ${step.name}\n`;
      output += `Command: ${step.command}\n`;
      try {
        const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024, env: childProcessEnv() });
        output += `Result: ${result.substring(0, 500)}\n`;
        data.instances[instanceId].results.push({ step: 0, success: true, output: result });
        const checkpoint = checkpointRunbookCursor(startedInstance, startClaim, 0, rb.steps.length);
        if (!checkpoint.ok) {
          releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
          return { content: [{ type: "text", text: output + "\n✗ Execution checkpoint rejected" }], isError: true };
        }
        if (rb.steps.length > 1) {
          data.instances[instanceId].status = "waiting";
          output += `\nUse action="next" with runbook_id="${instanceId}" to continue`;
          transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "waiting", {
            reason: "guided runbook waiting for next step",
            result_status: "waiting",
            result_summary: output,
          });
        } else {
          data.instances[instanceId].status = "completed";
          transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "completed", {
            reason: "guided runbook completed",
            result_status: "success",
            result_summary: output,
          });
          output += `\n✓ Runbook completed`;
        }
      } catch (e) {
        output += `Failed: ${e.message}\n`;
        if (step.rollback) {
          output += `Use action="rollback" with runbook_id="${instanceId}" to rollback`;
        }
        data.instances[instanceId].status = "failed";
        transitionScheduledPlatformExecution("runbook", data.instances[instanceId], "failed", {
          reason: "guided runbook step failed",
          result_status: "failure",
          error_category: evolveCommon.errorCategory(e.message),
          result_summary: output,
        });
      }
      saveRunbooks(data);
      releaseScheduledClaim(startedInstance.platform_execution_id, startClaim);
      return { content: [{ type: "text", text: output }] };
    }
  }

  if (action === "next") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (!instance.id) instance.id = runbook_id;
    if (instance.mode !== "guided") {
      return { content: [{ type: "text", text: "Instance is not in guided mode" }], isError: true };
    }
    if (instance.status !== "waiting") {
      return { content: [{ type: "text", text: `Runbook instance ${runbook_id} cannot continue: ledger state ${instance.status}` }], isError: true };
    }
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }

    // Fenced claim (Phase 4/B): two concurrent `next` calls cannot both run
    // the step; a cancel request stops the instance before dispatch.
    let nextClaim = null;
    if (instance.platform_execution_id) {
      const nextClaimRes = platformKernel.claimExecution({ execution_id: instance.platform_execution_id, claimed_by: `runbook-next:${process.pid}`, lease_ms: RUNBOOK_CLAIM_LEASE_MS });
      if (!nextClaimRes.ok) {
        const detail = nextClaimRes.code === "claim_held" ? `a step is already in progress (${nextClaimRes.claimed_by})` : `cannot continue: execution ${nextClaimRes.code}`;
        return { content: [{ type: "text", text: `Runbook instance ${runbook_id}: ${detail}` }], isError: true };
      }
      nextClaim = nextClaimRes.claim;
      if (nextClaim.cancel_requested) {
        instance.status = "cancelled";
        transitionScheduledPlatformExecution("runbook", instance, "cancelled", { reason: "cancel requested before next step", result_status: "cancelled" });
        saveRunbooks(data);
        releaseScheduledClaim(instance.platform_execution_id, nextClaim);
        return { content: [{ type: "text", text: `Runbook instance ${runbook_id} cancelled before next step` }] };
      }
    }

    instance.currentStep++;
    transitionScheduledPlatformExecution("runbook", instance, "running", { reason: "guided runbook next step started" });
    if (instance.currentStep >= rb.steps.length) {
      instance.status = "completed";
      transitionScheduledPlatformExecution("runbook", instance, "completed", {
        reason: "guided runbook completed",
        result_status: "success",
        result_summary: "Runbook completed",
      });
      saveRunbooks(data);
      releaseScheduledClaim(instance.platform_execution_id, nextClaim);
      return { content: [{ type: "text", text: `✓ Runbook completed` }] };
    }

    const step = rb.steps[instance.currentStep];
    let output = `Step ${instance.currentStep + 1}/${rb.steps.length}: ${step.name}\n`;
    output += `Command: ${step.command}\n`;
    appendScheduledPlatformEvent("runbook", instance, "runbook.step_started", { step: instance.currentStep, name: step.name });
    try {
      const result = execSync(step.command, { encoding: "utf8", timeout: STEP_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024, env: childProcessEnv() });
      output += `Result: ${result.substring(0, 500)}\n`;
      instance.results.push({ step: instance.currentStep, success: true, output: result });
      const checkpoint = checkpointRunbookCursor(instance, nextClaim, instance.currentStep, rb.steps.length);
      if (!checkpoint.ok) {
        releaseScheduledClaim(instance.platform_execution_id, nextClaim);
        return { content: [{ type: "text", text: output + "\n✗ Execution checkpoint rejected" }], isError: true };
      }
      appendScheduledPlatformEvent("runbook", instance, "runbook.step_completed", { step: instance.currentStep, name: step.name });
      if (instance.currentStep < rb.steps.length - 1) {
        instance.status = "waiting";
        output += `\nUse action="next" to continue`;
        transitionScheduledPlatformExecution("runbook", instance, "waiting", {
          reason: "guided runbook waiting for next step",
          result_status: "waiting",
          result_summary: output,
        });
      } else {
        instance.status = "completed";
        transitionScheduledPlatformExecution("runbook", instance, "completed", {
          reason: "guided runbook completed",
          result_status: "success",
          result_summary: output,
        });
        output += `\n✓ Runbook completed`;
      }
    } catch (e) {
      output += `Failed: ${e.message}\n`;
      if (step.rollback) {
        output += `Use action="rollback" to rollback`;
      }
      instance.status = "failed";
      transitionScheduledPlatformExecution("runbook", instance, "failed", {
        reason: "guided runbook step failed",
        result_status: "failure",
        error_category: evolveCommon.errorCategory(e.message),
        result_summary: output,
      });
    }
    saveRunbooks(data);
    releaseScheduledClaim(instance.platform_execution_id, nextClaim);
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "verify") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (!instance.id) instance.id = runbook_id;
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }
    const step = rb.steps[instance.currentStep];
    if (!step.verify_command) {
      return { content: [{ type: "text", text: "No verification command for this step" }] };
    }
    try {
      const result = execSync(step.verify_command, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024, env: childProcessEnv() });
      return { content: [{ type: "text", text: `✓ Verification passed\n\n${result}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `✗ Verification failed\n\n${e.message}` }], isError: true };
    }
  }

  if (action === "rollback") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (!instance.id) instance.id = runbook_id;
    const rb = data.definitions[instance.definitionId];
    if (!rb) {
      return { content: [{ type: "text", text: "Runbook definition not found" }], isError: true };
    }

    let output = `Rolling back runbook: ${runbook_id}\n\n`;
    transitionScheduledPlatformExecution("runbook", instance, "rolling_back", { reason: "runbook rollback started" });
    for (let i = instance.currentStep; i >= 0; i--) {
      const step = rb.steps[i];
      if (step.rollback) {
        output += `Step ${i + 1}: ${step.name}\n`;
        try {
          execSync(step.rollback, { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024, env: childProcessEnv() });
          output += `  ✓ Rollback successful\n`;
        } catch (e) {
          output += `  ✗ Rollback failed: ${e.message}\n`;
        }
      }
    }
    instance.status = "rolled_back";
    transitionScheduledPlatformExecution("runbook", instance, "rolled_back", {
      reason: "runbook rollback completed",
      result_status: "rolled_back",
      result_summary: output,
    });
    saveRunbooks(data);
    return { content: [{ type: "text", text: output }] };
  }

  if (action === "abort") {
    if (!runbook_id) {
      return { content: [{ type: "text", text: "runbook_id required" }], isError: true };
    }
    const instance = data.instances[runbook_id];
    if (!instance) {
      return { content: [{ type: "text", text: "Instance not found" }], isError: true };
    }
    if (!instance.id) instance.id = runbook_id;
    if (["aborted", "cancelled", "completed", "failed", "rolled_back", "rollback_failed"].includes(instance.status)) {
      return { content: [{ type: "text", text: `Runbook instance ${runbook_id} is already terminal (status: ${instance.status})` }], isError: true };
    }

    const claim = instance.platform_execution_id ? platformKernel.getExecutionClaim(instance.platform_execution_id) : null;
    const liveClaim = Boolean(claim?.claimed_by && claim.lease_expires_at && claim.lease_expires_at > new Date().toISOString());
    if (liveClaim) {
      platformKernel.requestExecutionCancel(instance.platform_execution_id, {
        source: "runbook",
        actor_id: actorId,
        reason: "runbook abort requested",
      });
      return { content: [{ type: "text", text: `Abort requested for runbook: ${runbook_id}` }] };
    }

    instance.status = "aborted";
    transitionScheduledPlatformExecution("runbook", instance, "cancelled", {
      source: "runbook",
      actor: actorId,
      reason: "runbook aborted",
      result_status: "aborted",
      result_summary: `Aborted runbook: ${runbook_id}`,
    });
    saveRunbooks(data);
    return { content: [{ type: "text", text: `Aborted runbook: ${runbook_id}` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: create, start, next, verify, rollback, abort, list, get, delete" }], isError: true };
}

const SCHEMAS = {
  runbook: z.object({
    action: z.enum(["create", "start", "next", "verify", "rollback", "abort", "list", "get", "delete"]),
    name: z.string().max(200).optional(),
    mode: z.enum(["autonomous", "guided"]).optional().default("autonomous"),
    steps: z.array(z.object({
      name: z.string().max(200),
      command: z.string().max(16384).regex(/^[^\u0000]*$/),
      expected: z.string().max(4096).optional().describe("Expected output pattern (regex)"),
      rollback: z.string().max(16384).regex(/^[^\u0000]*$/).optional().describe("Rollback command if this step fails"),
      verify_command: z.string().max(16384).regex(/^[^\u0000]*$/).optional().describe("Verification command to run after")
    })).optional(),
    runbook_id: z.string().optional(),
    step_index: z.number().optional()
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "runbook",
    description: "Operational runbook executor with autonomous and guided modes. Supports verification, rollback, and step-by-step execution.",
    schema: SCHEMAS.runbook,
    args: { action: "string (create|start|next|verify|rollback|abort|list|get|delete)", name: "string (optional, runbook name)", mode: "string (optional, autonomous|guided - default autonomous)", steps: "array (optional, step definitions)", runbook_id: "string (optional, instance or definition ID)", step_index: "number (optional, step index)" },
    risk: "critical",
    category: "Workflow",
    source: "builtin",
    family: "runbook",
    handler: sidekick_runbook,
  }),
]);

module.exports = { descriptors, sidekick_runbook, recoverStrandedRunbooks };
