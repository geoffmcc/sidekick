"use strict";

// Scheduling tool family: cron, delay, watch.
//
// Extracted from src/tools-legacy.js. The scheduled-execution primitives come
// from the shared src/tools/scheduled-execution.js module; nested tool
// dispatch goes through the seam (callTool); ids from core/ids; path checks
// from the shared path policy. Never imports tools-legacy.js. getToolRisk is
// resolved lazily from the registry-derived facade at call time (cycle-safe),
// and getCurrentSource mirrors the legacy helper via toolContext. The
// delay/watch JSON stores plus their recovery helpers (recoverStrandedDelays,
// pauseWatchForCancel) move here and are re-exported through the facade for
// src/agent.js and src/dashboard.js. Risks preserved from
// src/tools/metadata.js (cron/delay high, watch high).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { z } = require("zod");
const dbStore = require("../../db");
const { redactSensitive } = require("../../redact");
const evolveCommon = require("../../evolve/common");
const platformKernel = require("../../platform/kernel");
const toolContext = require("../context");
const { enforcePathPolicy } = require("../path-policy");
const { checkWatchFile } = require("../watch-file");
const { childProcessEnv } = require("../../security/child-process");
const { runBoundedShell } = require("../../security/command-execution");
const { generateId } = require("../../core/ids");
const { readSecret } = require("../../core/runtime-secrets");
const { createScheduledAuthority, verifyScheduledAuthority } = require("../../security/scheduled-authority");
const { restoreScheduledContext, authorizeScheduledAgentDelay } = require("../../agent/delay-policy");
const { resolveOutboundUrl } = require("../../security/outbound-url");
const { checkEndpoint } = require("../../security/endpoint-probe");
const networkScopes = require("../../security/network-scopes");
const { reloadAgentScheduler } = require("../../agent/scheduler-reload");
const { assertDistinctAgentSchedulerSecret } = require("../../security/agent-proxy-auth");
const { callTool } = require("../dispatch-seam");
const { requireToolExecution } = require("../read-authorization");
const { readJsonFile, writeJsonFile } = require("../../core/json-file-store");
const {
  createScheduledPlatformExecution,
  transitionScheduledPlatformExecution,
  releaseScheduledClaim,
  startScheduledLeaseRenewal,
  appendScheduledPlatformEvent,
  claimScheduledDefinition,
} = require("../scheduled-execution");

function getScheduledAgentDescriptor(name) {
  // Resolve lazily to avoid a tools -> scheduling -> tools initialization cycle.
  const tools = require("../index");
  const { createAgentCatalog } = require("../../agent/catalog");
  const catalog = createAgentCatalog({
    getToolDefsForSource: tools.getToolDefsForSource,
    getBuiltinRegistry: tools.getBuiltinRegistry,
    crypto: require("crypto"),
  });
  return catalog.getLiveAgentDescriptor(name);
}

function getCurrentSource() {
  return toolContext.getExecutionSource() || "unknown";
}

function getToolRisk(name) {
  return require("../index").getToolRisk(name);
}

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });


function loadCronJobs() {
  return dbStore.loadDocument("cron", []);
}

function saveCronJobs(jobs) {
  dbStore.setDocument("cron", jobs);
}

async function sidekick_cron({ action, name, schedule, command, id }) {
  const authorizationError = requireToolExecution({ tool: "cron", action: action || null, id: id || null }, "tools.execute_high", "cron");
  if (authorizationError) return authorizationError;
  const allowedActions = ["add", "list", "remove", "run"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const jobs = loadCronJobs();

  if (action === "add") {
    if (!name || !schedule || !command) {
      return { content: [{ type: "text", text: "name, schedule, and command required" }], isError: true };
    }
    if (name.length > 200 || schedule.length > 100 || command.length > 8192 || /[\u0000\r\n]/.test(schedule) || /[\u0000\r\n]/.test(command) || !isSafeCronSchedule(schedule)) {
      return { content: [{ type: "text", text: "cron name, schedule, or command exceeds its safe size or contains a control character" }], isError: true };
    }
    const newJob = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      schedule,
      command,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastResult: null
    };
    createScheduledPlatformExecution("cron", newJob, {
      operationType: "cron_job",
      state: "queued",
      risk: "high",
      metadata: { schedule: newJob.schedule },
      reason: "cron job scheduled",
    });
    jobs.push(newJob);
    saveCronJobs(jobs);
    syncCrontab(jobs);
    appendScheduledPlatformEvent("cron", newJob, "schedule.cron.added", { schedule: newJob.schedule });
    return { content: [{ type: "text", text: "Added cron job: " + name + " (id: " + newJob.id + ")" }] };
  }

  if (action === "list") {
    if (jobs.length === 0) {
      return { content: [{ type: "text", text: "No cron jobs scheduled" }] };
    }
    const summary = jobs.map(j =>
      j.id + " | " + j.name + " | " + j.schedule + " | " + (j.enabled ? "enabled" : "disabled") + " | last: " + (j.lastRun || "never")
    ).join("\n");
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "remove") {
    if (!id && !name) {
      return { content: [{ type: "text", text: "id or name required" }], isError: true };
    }
    const idx = jobs.findIndex(j => j.id === id || j.name === name);
    if (idx === -1) {
      return { content: [{ type: "text", text: "Job not found" }], isError: true };
    }
    // Live-claim cancel path (same contract as delay cancel / runbook abort):
    // when a claimed run is in flight, removing the definition out from under
    // it would silently abandon the claimant. Request cancellation on the
    // execution instead — the run path sees cancel_requested and disables the
    // job — and leave the definition in place for that claimant to settle.
    // Direct removal below stays the behavior when no live claim exists.
    const cronJob = jobs[idx];
    const cronClaimRow = cronJob.platform_execution_id ? platformKernel.getExecutionClaim(cronJob.platform_execution_id) : null;
    const cronLiveClaim = Boolean(cronClaimRow?.claimed_by && cronClaimRow.lease_expires_at && cronClaimRow.lease_expires_at > new Date().toISOString());
    if (cronLiveClaim) {
      platformKernel.requestExecutionCancel(cronJob.platform_execution_id, {
        source: "cron",
        actor_id: getCurrentSource() || "unknown",
        reason: "cron job removal requested while a run is in flight",
      });
      return { content: [{ type: "text", text: `Cancellation requested for cron job ${cronJob.id}: a claimed run is in flight (${cronClaimRow.claimed_by}); the job will be disabled when the claimant honors the cancel. Re-run remove afterwards to delete it.` }] };
    }
    const removed = jobs.splice(idx, 1)[0];
    transitionScheduledPlatformExecution("cron", removed, "cancelled", {
      reason: "cron job removed",
      result_status: "removed",
      result_summary: `Removed cron job ${removed.name}`,
    });
    appendScheduledPlatformEvent("cron", removed, "schedule.cron.removed", {});
    saveCronJobs(jobs);
    syncCrontab(jobs);
    return { content: [{ type: "text", text: "Removed job: " + removed.name }] };
  }

  if (action === "run") {
    if (!id && !name) {
      return { content: [{ type: "text", text: "id or name required" }], isError: true };
    }
    const job = jobs.find(j => j.id === id || j.name === name);
    if (!job) {
      return { content: [{ type: "text", text: "Job not found" }], isError: true };
    }
    // Fenced claim (Phase 4/B): sidekick-initiated runs of the same job are
    // serialized on the job's definition execution; crontab-fired commands
    // bypass sidekick entirely and cannot carry the contract. A cancel
    // request disables the job, which also removes its crontab entry.
    let cronClaim = null;
    if (job.platform_execution_id) {
      const cronClaimRes = claimScheduledDefinition(job, `cron-run:${process.pid}`, "cron");
      if (!cronClaimRes.ok) {
        const detail = cronClaimRes.code === "claim_held" ? `already running (${cronClaimRes.claimed_by})` : `cannot run: execution ${cronClaimRes.code}`;
        return { content: [{ type: "text", text: `Cron job ${job.id} ${detail}` }], isError: true };
      }
      cronClaim = cronClaimRes.claim;
      if (cronClaim.cancel_requested) {
        job.enabled = false;
        transitionScheduledPlatformExecution("cron", job, "blocked", { reason: "cron job disabled by cancel request", result_status: "disabled" });
        appendScheduledPlatformEvent("cron", job, "schedule.cron.disabled", { cancel_requested: true });
        saveCronJobs(jobs);
        syncCrontab(jobs);
        releaseScheduledClaim(job.platform_execution_id, cronClaim);
        return { content: [{ type: "text", text: `Cron job ${job.id} disabled: cancel requested on its execution` }] };
      }
    }
    const cronRenewTimer = startScheduledLeaseRenewal(job.platform_execution_id, cronClaim);
    const execution = createScheduledPlatformExecution("cron", job, {
      attach: false,
      operationType: "cron_run",
      state: "running",
      risk: "high",
      reason: "cron job run started",
      metadata: { cron_job_id: job.id, schedule: job.schedule },
    });
    try {
      const stdout = runBoundedShell(job.command, { timeout: 300000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      job.lastRun = new Date().toISOString();
      job.lastResult = "success";
      saveCronJobs(jobs);
      if (execution) platformKernel.transitionExecution(execution.execution_id, "completed", {
        source: "cron",
        actor_id: getCurrentSource() || "unknown",
        reason: "cron job run completed",
        result_status: "success",
        result_summary: stdout || "(empty output)",
        correlation_id: job.id,
      });
      if (cronRenewTimer) clearInterval(cronRenewTimer);
      releaseScheduledClaim(job.platform_execution_id, cronClaim);
      return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
    } catch (e) {
      job.lastRun = new Date().toISOString();
      job.lastResult = "error";
      saveCronJobs(jobs);
      if (execution) platformKernel.transitionExecution(execution.execution_id, "failed", {
        source: "cron",
        actor_id: getCurrentSource() || "unknown",
        reason: "cron job run failed",
        result_status: "failure",
        error_category: evolveCommon.errorCategory(e.message),
        result_summary: e.stderr || e.stdout || e.message,
        correlation_id: job.id,
      });
      if (cronRenewTimer) clearInterval(cronRenewTimer);
      releaseScheduledClaim(job.platform_execution_id, cronClaim);
      return { content: [{ type: "text", text: redactSensitive("Error: " + (e.stderr || e.stdout || e.message)) }], isError: true };
    }
  }
}

function syncCrontab(jobs) {
  try {
    const enabledJobs = jobs.filter(j => j.enabled);
    if (enabledJobs.length === 0) {
      try { execFileSync("crontab", ["-r"], { encoding: "utf-8", env: childProcessEnv() }); } catch {}
      return;
    }
    const runner = path.resolve(__dirname, "../../../scripts/run-cron-job.js");
    const lines = enabledJobs.map(j => `${j.schedule} ${shellQuote(process.execPath)} ${shellQuote(runner)} ${shellQuote(j.id)} >> ${shellQuote(path.join(DATA_DIR, `cron-${j.id}.log`))} 2>&1 # sidekick:${j.id}`);
    const crontabContent = lines.join("\n") + "\n";
    execFileSync("crontab", ["-"], { input: crontabContent, encoding: "utf-8", env: childProcessEnv() });
  } catch (e) {
    // Silently fail if crontab not available
  }
}

function isSafeCronSchedule(schedule) {
  const fields = String(schedule).trim().split(/\s+/);
  return fields.length === 5 && fields.every(field => /^[0-9*/?,\-]+$/.test(field));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}


const DELAYS_FILE = path.join(DATA_DIR, "delays.json");

function loadDelays() {
  if (!fs.existsSync(DELAYS_FILE)) return [];
  try {
    const value = readJsonFile(DELAYS_FILE);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveDelays(delays) {
  writeJsonFile(DELAYS_FILE, delays);
}

// Phase 4/B restart recovery: a delay that was `running` when its runner died
// used to be stranded forever. The kernel recovery scan orphans executions
// whose claim lease expired; any such delay is re-queued to `pending` exactly
// once (fenced by the orphaned->queued transition, which a concurrent
// recoverer would lose). Called by the agent on startup.
function recoverStrandedDelays(details = {}) {
  try {
    platformKernel.recoverOrphanedExecutions({ source: details.source || "delay", actor_id: details.actor || null });
  } catch (e) {}
  const delays = loadDelays();
  let requeued = 0;
  for (const d of delays) {
    if (d.status !== "running" || !d.platform_execution_id) continue;
    try {
      const claim = platformKernel.getExecutionClaim(d.platform_execution_id);
      if (claim && claim.claimed_by) continue; // actively leased by a live runner
      const exec = platformKernel.getExecution(d.platform_execution_id);
      if (!exec || exec.state !== "orphaned") continue;
      platformKernel.transitionExecution(d.platform_execution_id, "queued", { source: details.source || "delay", actor_id: details.actor || null, reason: "delay re-queued after orphan recovery" });
      d.status = "pending";
      d.startedAt = null;
      requeued++;
    } catch (e) {}
  }
  if (requeued > 0) saveDelays(delays);
  return { requeued };
}
// A cancel request on the definition execution permanently stops the watch:
// cancel_requested is not clearable, so every future claimant re-pauses it.
// Normal operational stop/resume stays with the watch pause/remove actions.
function pauseWatchForCancel(watch, claim, options = {}) {
  // Re-load before the lifecycle write: claims fence per watch, but
  // watches.json is global — an entry snapshot could clobber concurrent
  // changes to other watches.
  const watches = loadWatches();
  const fresh = watches.find(w => w.id === watch.id) || watch;
  fresh.status = "paused";
  transitionScheduledPlatformExecution("watch", fresh, "blocked", { source: options.source, actor: options.actor, reason: "watch paused by cancel request", result_status: "paused" });
  appendScheduledPlatformEvent("watch", fresh, "schedule.watch.paused", { cancel_requested: true }, { source: options.source, actor: options.actor });
  saveWatches(watches);
  releaseScheduledClaim(watch.platform_execution_id, claim);
}

function parseWhen(when) {
  if (!when) return null;

  const match = when.match(/^(\d+)(s|m|h|d)$/);
  if (match) {
    const amount = parseInt(match[1]);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(Date.now() + amount * multipliers[unit]);
  }

  const date = new Date(when);
  if (!isNaN(date.getTime())) {
    return date;
  }

  return null;
}

async function sidekick_delay({ action, id, when, name, tool, args }) {
  const authorizationError = requireToolExecution({ tool: "delay", action: action || null, id: id || null }, "tools.execute_high", "delay");
  if (authorizationError) return authorizationError;
  const delays = loadDelays();
  const now = new Date().toISOString();
  const actorId = toolContext.getExecutionContext().actor;

  if (action === "add") {
    if (!when || !tool) {
      return { content: [{ type: "text", text: "when and tool required" }], isError: true };
    }

    const executeAt = parseWhen(when);
    if (!executeAt) {
      return { content: [{ type: "text", text: "Invalid when format. Use: 10s, 5m, 2h, 1d, or ISO date" }], isError: true };
    }

    if (executeAt.getTime() <= Date.now()) {
      return { content: [{ type: "text", text: "Time must be in the future" }], isError: true };
    }

    const delay = {
      id: generateId("delay"),
      name: name || `${tool} at ${executeAt.toISOString()}`,
      when: executeAt.toISOString(),
      tool,
      args: args || {},
      created: now,
      status: "pending"
    };
    let scheduleAuthorityKey;
    try {
      scheduleAuthorityKey = readSecret("SIDEKICK_SECRET_KEY", { required: true });
    } catch {
      return { content: [{ type: "text", text: "Cannot schedule delay: durable authority protection is unavailable; configure SIDEKICK_SECRET_KEY and retry" }], isError: true, code: "scheduled_authority_unavailable" };
    }
    let agentProxyKey;
    let agentSchedulerKey;
    try {
      agentProxyKey = readSecret("SIDEKICK_AGENT_PROXY_KEY", { required: true });
      agentSchedulerKey = readSecret("SIDEKICK_AGENT_SCHEDULER_KEY", { required: true });
      assertDistinctAgentSchedulerSecret(agentProxyKey, agentSchedulerKey);
    } catch {
      return { content: [{ type: "text", text: "Cannot activate delay scheduling: distinct SIDEKICK_AGENT_PROXY_KEY and SIDEKICK_AGENT_SCHEDULER_KEY credentials are required" }], isError: true, code: "agent_service_credential_unavailable" };
    }
    createScheduledPlatformExecution("delay", delay, {
      operationType: "delay_task",
      state: "queued",
      risk: getToolRisk(tool),
      deadlineAt: delay.when,
      metadata: { target_tool: tool },
      reason: "delay scheduled",
    });
    delay.scheduled_authority = createScheduledAuthority({
      delay,
      context: toolContext.getExecutionContext(),
      secret: scheduleAuthorityKey,
    });

    delays.push(delay);
    saveDelays(delays);
    appendScheduledPlatformEvent("delay", delay, "schedule.delay.added", { when: delay.when, tool: delay.tool });

    const msUntil = executeAt.getTime() - Date.now();
    const minutes = Math.round(msUntil / 60000);

    const reload = await reloadAgentScheduler("delays", { secret: agentSchedulerKey });
    const message = reload.ok
      ? `Scheduled delay: ${delay.id}\nWill execute ${tool} in ${minutes} minutes (${executeAt.toISOString()})`
      : `Delay definition ${delay.id} is persisted for ${executeAt.toISOString()}, but the Agent did not acknowledge its timer reload (${reload.code}). It is not active until the Agent reloads scheduled delays.`;
    return { content: [{ type: "text", text: message }] };
  }

  if (action === "list") {
    const pending = delays.filter(d => d.status === "pending");
    const completed = delays.filter(d => d.status === "completed");
    const cancelled = delays.filter(d => d.status === "cancelled");

    let output = `# Scheduled Delays\n\n`;
    output += `**Pending: ${pending.length}**\n`;
    output += `**Completed: ${completed.length}**\n`;
    output += `**Cancelled: ${cancelled.length}**\n\n`;

    if (pending.length > 0) {
      output += `## Pending\n`;
      for (const d of pending) {
        const when = new Date(d.when);
        const msUntil = when.getTime() - Date.now();
        const minutes = Math.round(msUntil / 60000);
        output += `- **${d.id}**: ${d.name}\n`;
        output += `  - Tool: ${d.tool}\n`;
        output += `  - Executes in: ${minutes} minutes (${d.when})\n`;
      }
    }

    if (completed.length > 0) {
      output += `\n## Completed (last 5)\n`;
      for (const d of completed.slice(-5)) {
        output += `- ${d.id}: ${d.name} (completed ${d.completedAt})\n`;
      }
    }

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "cancel") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const delay = delays.find(d => d.id === id);
    if (!delay) {
      return { content: [{ type: "text", text: `Delay not found: ${id}` }], isError: true };
    }

    if (["completed", "failed"].includes(delay.status)) {
      return { content: [{ type: "text", text: `Delay ${id} is not pending (status: ${delay.status})` }], isError: true };
    }

    if (delay.status === "cancelled") {
      return { content: [{ type: "text", text: `Delay ${id} is already cancelled` }] };
    }

    const claim = delay.platform_execution_id ? platformKernel.getExecutionClaim(delay.platform_execution_id) : null;
    const liveClaim = Boolean(claim?.claimed_by && claim.lease_expires_at && claim.lease_expires_at > now);
    if (liveClaim) {
      platformKernel.requestExecutionCancel(delay.platform_execution_id, {
        source: "delay",
        actor_id: actorId,
        reason: "delay cancellation requested",
      });
      return { content: [{ type: "text", text: `Cancellation requested for delay: ${id}` }] };
    }

    delay.status = "cancelled";
    delay.cancelledAt = now;
    transitionScheduledPlatformExecution("delay", delay, "cancelled", {
      source: "delay",
      actor: actorId,
      reason: "delay cancelled",
      result_status: "cancelled",
      result_summary: `Cancelled delay ${id}`,
    });
    appendScheduledPlatformEvent("delay", delay, "schedule.delay.cancelled", { cancelled_at: delay.cancelledAt }, { source: "delay", actor: actorId });
    saveDelays(delays);

    return { content: [{ type: "text", text: `Cancelled delay: ${id}` }] };
  }

  if (action === "run") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const delay = delays.find(d => d.id === id);
    if (!delay) {
      return { content: [{ type: "text", text: `Delay not found: ${id}` }], isError: true };
    }

    if (delay.status !== "pending") {
      return { content: [{ type: "text", text: `Delay ${id} is not pending (status: ${delay.status})` }], isError: true };
    }

    const verifiedAuthority = verifyScheduledAuthority({ delay, secret: readSecret("SIDEKICK_SECRET_KEY", { required: true }) });
    if (!verifiedAuthority) {
      return { content: [{ type: "text", text: `Delay ${id} has no valid authority record and will not be executed` }], isError: true, code: "scheduled_authority_invalid" };
    }
    let scheduledContext = null;
    let authorityPolicy = null;
    try {
      scheduledContext = restoreScheduledContext(verifiedAuthority);
      if (scheduledContext) authorityPolicy = authorizeScheduledAgentDelay(delay, scheduledContext, { getDescriptor: getScheduledAgentDescriptor });
    } catch {}
    if (!scheduledContext || !authorityPolicy?.ok) {
      delay.status = "failed";
      delay.completedAt = new Date().toISOString();
      delay.error = "Scheduled authority is no longer valid or permitted";
      transitionScheduledPlatformExecution("delay", delay, "failed", {
        source: "delay",
        actor: "delay",
        reason: delay.error,
        result_status: "failure",
        error_category: "authorization_denied",
        result_summary: delay.error,
      });
      appendScheduledPlatformEvent("delay", delay, "schedule.delay.failed", { error: delay.error }, { source: "delay", actor: "delay", severity: "error" });
      saveDelays(delays);
      return { content: [{ type: "text", text: `Delay ${id} cannot run because its scheduled authority is no longer valid or permitted` }], isError: true, code: "scheduled_authority_invalid" };
    }

    // Fenced claim (Phase 4/B): of the agent timer and any MCP-side run, only
    // one claimant dispatches. Any claim failure refuses dispatch — a terminal
    // or missing execution means the ledger disagrees with delays.json, and
    // running unfenced would bypass the contract entirely.
    let runClaim = null;
    if (delay.platform_execution_id) {
      const claimRes = platformKernel.claimExecution({ execution_id: delay.platform_execution_id, claimed_by: `delay-run:${process.pid}` });
      if (!claimRes.ok) {
        const detail = claimRes.code === "claim_held" ? `already being executed by another runner (${claimRes.claimed_by})` : `cannot run: execution ${claimRes.code}`;
        return { content: [{ type: "text", text: `Delay ${id} ${detail}` }], isError: true };
      }
      runClaim = claimRes.claim;
      if (runClaim.cancel_requested) {
        delay.status = "cancelled";
        delay.cancelledAt = now;
        transitionScheduledPlatformExecution("delay", delay, "cancelled", { reason: "cancel requested before dispatch", result_status: "cancelled", result_summary: `Cancelled delay ${id}` });
        appendScheduledPlatformEvent("delay", delay, "schedule.delay.cancelled", { cancelled_at: delay.cancelledAt });
        saveDelays(delays);
        releaseScheduledClaim(delay.platform_execution_id, runClaim);
        return { content: [{ type: "text", text: `Delay ${id} was cancelled before dispatch` }] };
      }
    }

    delay.status = "running";
    delay.startedAt = now;
    transitionScheduledPlatformExecution("delay", delay, "running", { reason: "delay execution started" });
    saveDelays(delays);
    let renewTimer = startScheduledLeaseRenewal(delay.platform_execution_id, runClaim);

    try {
      const result = await callTool(delay.tool, delay.args, {
        parentId: delay.platform_execution_id || null,
        rootExecutionId: delay.platform_execution_id || null,
        correlationId: delay.id,
        project: scheduledContext.project || undefined,
        taskId: scheduledContext.taskId || undefined,
        authIdentity: scheduledContext.authIdentity,
        agentAuthorityContext: scheduledContext.agentAuthorityContext || undefined,
        authorityApprovalRequired: authorityPolicy.authorityApprovalRequired === true,
        authorityRisk: authorityPolicy.authorityRisk || undefined,
        authorityReason: authorityPolicy.authorityReason || undefined,
      });
      if (renewTimer) clearInterval(renewTimer);
      // Release before the completion write: a rejected release means this
      // runner was superseded mid-dispatch, and its stale snapshot must not
      // clobber the current claimant's state.
      const release = releaseScheduledClaim(delay.platform_execution_id, runClaim);
      if (runClaim && !release.ok && release.code === "release_rejected") {
        return { content: [{ type: "text", text: `Delay ${id} finished but its claim was superseded; state is owned by the current claimant` }], isError: true };
      }
      const delaysAfter = loadDelays();
      const fresh = delaysAfter.find(d => d.id === id) || delay;
      fresh.status = result.isError ? "failed" : "completed";
      fresh.completedAt = new Date().toISOString();
      fresh.result = result.content?.[0]?.text?.substring(0, 200) || "ok";
      transitionScheduledPlatformExecution("delay", fresh, result.isError ? "failed" : "completed", {
        reason: result.isError ? "delay execution failed" : "delay execution completed",
        result_status: result.isError ? "failure" : "success",
        error_category: result.isError ? evolveCommon.errorCategory(fresh.result) : null,
        result_summary: fresh.result,
      });
      appendScheduledPlatformEvent("delay", fresh, result.isError ? "schedule.delay.failed" : "schedule.delay.completed", { completed_at: fresh.completedAt }, { severity: result.isError ? "error" : "info" });
      saveDelays(delaysAfter);
      if (result.isError) return { content: [{ type: "text", text: `Delay ${id} failed:\n\n${result.content?.[0]?.text || "error"}` }], isError: true };
      return { content: [{ type: "text", text: `Executed delay ${id}:\n\n${result.content?.[0]?.text || "ok"}` }] };
    } catch (e) {
      if (renewTimer) clearInterval(renewTimer);
      const release = releaseScheduledClaim(delay.platform_execution_id, runClaim);
      if (runClaim && !release.ok && release.code === "release_rejected") {
        return { content: [{ type: "text", text: `Delay ${id} threw (${e.message}) but its claim was superseded; state is owned by the current claimant` }], isError: true };
      }
      const delaysAfter = loadDelays();
      const fresh = delaysAfter.find(d => d.id === id) || delay;
      fresh.status = "failed";
      fresh.completedAt = new Date().toISOString();
      fresh.error = e.message;
      transitionScheduledPlatformExecution("delay", fresh, "failed", {
        reason: "delay execution threw",
        result_status: "failure",
        error_category: evolveCommon.errorCategory(e.message),
        result_summary: e.message,
      });
      appendScheduledPlatformEvent("delay", fresh, "schedule.delay.failed", { error: e.message }, { severity: "error" });
      saveDelays(delaysAfter);

      return { content: [{ type: "text", text: `Delay ${id} failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: add, list, cancel, run" }], isError: true };
}


const WATCHES_FILE = path.join(DATA_DIR, "watches.json");

function loadWatches() {
  if (!fs.existsSync(WATCHES_FILE)) return [];
  try {
    const value = readJsonFile(WATCHES_FILE);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveWatches(watches) {
  writeJsonFile(WATCHES_FILE, watches);
}

function checkService(serviceName) {
  try {
    const output = execFileSync("systemctl", ["is-active", serviceName], { encoding: "utf-8", timeout: 5000, env: childProcessEnv() }).trim();
    return { status: output, active: output === "active" };
  } catch {
    return { status: "unknown", active: false };
  }
}

function checkProcess(processName) {
  try {
    const output = execFileSync("pgrep", ["-f", processName], { encoding: "utf-8", timeout: 5000, env: childProcessEnv() }).trim();
    return { running: output.length > 0, pids: output.split("\n").filter(Boolean) };
  } catch {
    return { running: false, pids: [] };
  }
}

function checkFile(filePath, pattern) {
  return checkWatchFile(filePath, pattern, { source: toolContext.getExecutionSource() || "unknown" });
}

function evaluateCondition(watch, checkResult) {
  const { source, condition, value } = watch;

  if (source === "service") {
    if (condition === "status!=active") return !checkResult.active;
    if (condition === "status=active") return checkResult.active;
  }

  if (source === "process") {
    if (condition === "not_running") return !checkResult.running;
    if (condition === "running") return checkResult.running;
  }

  if (source === "endpoint") {
    if (condition === "status!=200") return checkResult.status !== 200;
    if (condition === "status=200") return checkResult.status === 200;
    if (condition.startsWith("status>=")) {
      const threshold = parseInt(condition.substring(8));
      return checkResult.status >= threshold;
    }
  }

  if (source === "file") {
    if (condition === "content_matches") return checkResult.exists && checkResult.matches;
    if (condition === "not_exists") return !checkResult.exists;
    if (condition === "exists") return checkResult.exists;
  }

  return false;
}

async function executeWatchAction(watch, checkResult, metadata = {}) {
  const { action_tool, action_args } = watch;
  if (!action_tool) return;

  const args = { ...action_args };
  if (args.message) {
    args.message = args.message
      .replace(/\{\{source\}\}/g, watch.source)
      .replace(/\{\{target\}\}/g, watch.target)
      .replace(/\{\{status\}\}/g, JSON.stringify(checkResult))
      .replace(/\{\{time\}\}/g, new Date().toISOString());
  }

  try {
    return await callTool(action_tool, args, metadata);
  } catch (e) {
    console.error(`Watch ${watch.id} action failed: ${e.message}`);
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_watch({ action, id, name, source, target, condition, value, interval, action_tool, action_args, pause, network_scope }) {
  const authorizationError = requireToolExecution({ tool: "watch", action: action || null, id: id || null }, "tools.execute_high", "watch");
  if (authorizationError) return authorizationError;
  const watches = loadWatches();
  const now = new Date().toISOString();

  if (action === "add") {
    if (!name || !source || !target || !condition) {
      return { content: [{ type: "text", text: "name, source, target, and condition required" }], isError: true };
    }
    if (condition === "content_matches" && (typeof value !== "string" || value.length === 0 || value.length > 4096)) {
      return { content: [{ type: "text", text: "content_matches requires a non-empty value of at most 4096 characters" }], isError: true };
    }

    const validSources = ["service", "process", "endpoint", "file"];
    if (!validSources.includes(source)) {
      return { content: [{ type: "text", text: `Invalid source. Use: ${validSources.join(", ")}` }], isError: true };
    }
    if (network_scope && source !== "endpoint") {
      return { content: [{ type: "text", text: "network_scope is only valid for endpoint watches" }], isError: true };
    }
    let networkScopeRevision = null;
    if (source === "endpoint") {
      let scope = null;
      if (network_scope) {
        scope = networkScopes.get(network_scope);
        if (!scope || !scope.enabled || !scope.is_current) {
          return { content: [{ type: "text", text: "Endpoint watch network scope is missing, disabled, or superseded" }], isError: true, code: "network_scope_unavailable" };
        }
      }
      const destination = await resolveOutboundUrl(target, "endpoint", scope ? { networkScope: scope } : {});
      if (destination.refusal && !["dns_resolution_failed"].includes(destination.code)) {
        return { content: [{ type: "text", text: `Endpoint watch target denied (${destination.code}): ${destination.refusal}` }], isError: true, code: destination.code };
      }
      networkScopeRevision = scope?.revision || null;
    }
    if (source === "file") {
      const policyError = enforcePathPolicy(target, "read");
      if (policyError) return policyError;
    }
    let agentProxyKey;
    let agentSchedulerKey;
    try {
      agentProxyKey = readSecret("SIDEKICK_AGENT_PROXY_KEY", { required: true });
      agentSchedulerKey = readSecret("SIDEKICK_AGENT_SCHEDULER_KEY", { required: true });
      assertDistinctAgentSchedulerSecret(agentProxyKey, agentSchedulerKey);
    } catch {
      return { content: [{ type: "text", text: "Cannot activate watch scheduling: distinct SIDEKICK_AGENT_PROXY_KEY and SIDEKICK_AGENT_SCHEDULER_KEY credentials are required" }], isError: true, code: "agent_service_credential_unavailable" };
    }

    const watch = {
      id: generateId("watch"),
      name,
      source,
      target,
      network_scope: source === "endpoint" ? network_scope || null : null,
      network_scope_revision: source === "endpoint" ? networkScopeRevision || null : null,
      condition,
      value: source === "file" && condition === "content_matches" ? value : null,
      interval: interval || "60s",
      action_tool: action_tool || "sidekick_notify",
      action_args: action_args || { channel: "discord", message: "Watch triggered: {{source}} {{target}} at {{time}}" },
      created: now,
      status: "active",
      lastCheck: null,
      lastTriggered: null,
      triggerCount: 0
    };
    createScheduledPlatformExecution("watch", watch, {
      operationType: "watch_monitor",
      state: "queued",
      risk: getToolRisk(watch.action_tool),
      metadata: { source: watch.source, target: watch.target, network_scope: watch.network_scope, network_scope_revision: watch.network_scope_revision, condition: watch.condition, interval: watch.interval, action_tool: watch.action_tool },
      reason: "watch scheduled",
    });

    watches.push(watch);
    saveWatches(watches);
    appendScheduledPlatformEvent("watch", watch, "schedule.watch.added", { source: watch.source, target: watch.target, network_scope: watch.network_scope, network_scope_revision: watch.network_scope_revision, condition: watch.condition, interval: watch.interval });

    const reload = await reloadAgentScheduler("watches", { secret: agentSchedulerKey });
    const message = reload.ok
      ? `Added watch: ${watch.id}\nName: ${name}\nSource: ${source} ${target}\nCondition: ${condition}\nInterval: ${watch.interval}\nAction: ${watch.action_tool}`
      : `Watch definition ${watch.id} is persisted, but the Agent did not acknowledge its timer reload (${reload.code}). It is not active until the Agent reloads scheduled watches.`;
    return { content: [{ type: "text", text: message }] };
  }

  if (action === "list") {
    const active = watches.filter(w => w.status === "active");
    const paused = watches.filter(w => w.status === "paused");

    let output = `# Active Watches\n\n`;
    output += `**Active: ${active.length}**\n`;
    output += `**Paused: ${paused.length}**\n\n`;

    if (active.length > 0) {
      output += `## Active\n`;
      for (const w of active) {
        output += `- **${w.id}**: ${w.name}\n`;
        output += `  - Source: ${w.source} ${w.target}\n`;
        if (w.network_scope) output += `  - Network scope: ${w.network_scope}\n`;
        output += `  - Condition: ${w.condition}\n`;
        output += `  - Interval: ${w.interval}\n`;
        output += `  - Triggers: ${w.triggerCount}\n`;
        if (w.lastCheck) output += `  - Last check: ${w.lastCheck}\n`;
        if (w.lastTriggered) output += `  - Last triggered: ${w.lastTriggered}\n`;
      }
    }

    if (paused.length > 0) {
      output += `\n## Paused\n`;
      for (const w of paused) {
        output += `- ${w.id}: ${w.name}\n`;
      }
    }

    return { content: [{ type: "text", text: output }] };
  }

  if (action === "remove") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const idx = watches.findIndex(w => w.id === id);
    if (idx === -1) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }

    // Live-claim cancel path (delay-cancel pattern): a check claimed by a live
    // runner must receive a cancel request rather than having its definition
    // yanked mid-flight. The claimant pauses the watch on cancel
    // (pauseWatchForCancel); direct removal remains when no live claim exists.
    const removeTarget = watches[idx];
    const removeClaim = removeTarget.platform_execution_id ? platformKernel.getExecutionClaim(removeTarget.platform_execution_id) : null;
    const removeLiveClaim = Boolean(removeClaim?.claimed_by && removeClaim.lease_expires_at && removeClaim.lease_expires_at > now);
    if (removeLiveClaim) {
      platformKernel.requestExecutionCancel(removeTarget.platform_execution_id, {
        source: "watch",
        actor_id: getCurrentSource() || "unknown",
        reason: "watch removal requested while a check is in flight",
      });
      return { content: [{ type: "text", text: `Cancellation requested for watch ${id}: a claimed check is in flight (${removeClaim.claimed_by}); it will pause when the claimant honors the cancel. Re-run remove afterwards to delete it.` }] };
    }

    const removed = watches.splice(idx, 1)[0];
    transitionScheduledPlatformExecution("watch", removed, "cancelled", {
      reason: "watch removed",
      result_status: "removed",
      result_summary: `Removed watch ${id}`,
    });
    appendScheduledPlatformEvent("watch", removed, "schedule.watch.removed", {});
    saveWatches(watches);

    return { content: [{ type: "text", text: `Removed watch: ${id}` }] };
  }

  if (action === "pause") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const watch = watches.find(w => w.id === id);
    if (!watch) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }

    // Disable direction only: pausing while a claimed check is in flight
    // requests cancellation so the claimant pauses the watch itself instead of
    // this writer transitioning the definition under a live lease. Resume
    // (pause=false) never conflicts with a claimant and stays direct.
    if (pause) {
      const pauseClaim = watch.platform_execution_id ? platformKernel.getExecutionClaim(watch.platform_execution_id) : null;
      const pauseLiveClaim = Boolean(pauseClaim?.claimed_by && pauseClaim.lease_expires_at && pauseClaim.lease_expires_at > now);
      if (pauseLiveClaim) {
        platformKernel.requestExecutionCancel(watch.platform_execution_id, {
          source: "watch",
          actor_id: getCurrentSource() || "unknown",
          reason: "watch pause requested while a check is in flight",
        });
        return { content: [{ type: "text", text: `Cancellation requested for watch ${id}: a claimed check is in flight (${pauseClaim.claimed_by}); it will pause when the claimant honors the cancel.` }] };
      }
    }

    watch.status = pause ? "paused" : "active";
    transitionScheduledPlatformExecution("watch", watch, pause ? "blocked" : "queued", {
      reason: pause ? "watch paused" : "watch resumed",
      result_status: pause ? "paused" : "active",
    });
    appendScheduledPlatformEvent("watch", watch, pause ? "schedule.watch.paused" : "schedule.watch.resumed", {});
    saveWatches(watches);

    return { content: [{ type: "text", text: `${pause ? "Paused" : "Resumed"} watch: ${id}` }] };
  }

  if (action === "check") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const watch = watches.find(w => w.id === id);
    if (!watch) {
      return { content: [{ type: "text", text: `Watch not found: ${id}` }], isError: true };
    }

    const checkClaim = claimScheduledDefinition(watch, `watch-check:${process.pid}`, "watch");
    if (!checkClaim.ok) {
      const detail = checkClaim.code === "claim_held" ? `check already in progress (${checkClaim.claimed_by})` : `cannot check: execution ${checkClaim.code}`;
      return { content: [{ type: "text", text: `Watch ${id} ${detail}` }], isError: true };
    }
    if (checkClaim.claim && checkClaim.claim.cancel_requested) {
      pauseWatchForCancel(watch, checkClaim.claim);
      return { content: [{ type: "text", text: `Watch ${id} paused: cancel requested on its execution` }] };
    }
    // Everything after a successful claim runs under try/finally: a mid-check
    // throw must clear the renewal timer (which would otherwise keep the
    // lease fresh forever) and release the claim.
    const renewTimer = startScheduledLeaseRenewal(watch.platform_execution_id, checkClaim.claim);
    try {
      const checkExecution = createScheduledPlatformExecution("watch", watch, {
        attach: false,
        parentExecutionId: watch.platform_execution_id || null,
        rootExecutionId: watch.platform_execution_id || null,
        operationType: "watch_check",
        state: "running",
        risk: getToolRisk(watch.action_tool),
        metadata: { source: watch.source, target: watch.target, network_scope: watch.network_scope || null, network_scope_revision: watch.network_scope_revision || null, condition: watch.condition },
        reason: "watch check started",
      });
      let checkResult;
      try {
        if (watch.source === "service") {
          checkResult = checkService(watch.target);
        } else if (watch.source === "process") {
          checkResult = checkProcess(watch.target);
        } else if (watch.source === "endpoint") {
          checkResult = await checkEndpoint(watch.target, watch.network_scope, watch.network_scope_revision);
        } else if (watch.source === "file") {
          const policyError = enforcePathPolicy(watch.target, "read");
          if (policyError) {
            platformKernel.transitionExecution(checkExecution.execution_id, "failed", {
              source: "watch", actor_id: getCurrentSource() || "unknown",
              reason: "watch file target denied by current path policy",
              result_status: "failure", error_category: "path_policy_denied",
              result_summary: "watch file target denied by current path policy", correlation_id: watch.id,
            });
            appendScheduledPlatformEvent("watch", watch, "schedule.watch.check_failed", { code: "path_policy_denied" }, { severity: "error", executionId: checkExecution?.execution_id, rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id });
            return policyError;
          }
          checkResult = checkFile(watch.target, watch.condition === "content_matches" ? watch.value : null);
        }
      } catch (error) {
        const reason = error.policyDenied ? "watch check denied by current security policy" : "watch check failed";
        if (checkExecution) platformKernel.transitionExecution(checkExecution.execution_id, "failed", {
          source: "watch", actor_id: getCurrentSource() || "unknown", reason,
          result_status: "failure", error_category: error.code || "watch_check_failed",
          result_summary: reason, correlation_id: watch.id,
        });
        appendScheduledPlatformEvent("watch", watch, "schedule.watch.check_failed", {
          code: String(error.code || "watch_check_failed").slice(0, 80),
        }, { severity: "error", executionId: checkExecution?.execution_id, rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id });
        return { content: [{ type: "text", text: reason }], isError: true, code: error.code || "watch_check_failed" };
      }

      const triggered = evaluateCondition(watch, checkResult);

      if (triggered) {
        appendScheduledPlatformEvent("watch", watch, "schedule.watch.triggered", { check_result: checkResult }, { executionId: checkExecution?.execution_id, rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id });
        const actionResult = await executeWatchAction(watch, checkResult, {
          parentId: checkExecution?.execution_id || watch.platform_execution_id || null,
          rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id || null,
          correlationId: watch.id,
        });
        if (checkExecution) platformKernel.transitionExecution(checkExecution.execution_id, actionResult?.isError ? "failed" : "completed", {
          source: "watch",
          actor_id: getCurrentSource() || "unknown",
          reason: actionResult?.isError ? "watch action failed" : "watch action completed",
          result_status: actionResult?.isError ? "failure" : "success",
          error_category: actionResult?.isError ? evolveCommon.errorCategory(actionResult.content?.[0]?.text || "watch action failed") : null,
          result_summary: actionResult?.content?.[0]?.text || "watch triggered",
          correlation_id: watch.id,
        });
      } else if (checkExecution) {
        platformKernel.transitionExecution(checkExecution.execution_id, "completed", {
          source: "watch",
          actor_id: getCurrentSource() || "unknown",
          reason: "watch check completed without trigger",
          result_status: "not_triggered",
          result_summary: `Watch ${watch.id} did not trigger`,
          correlation_id: watch.id,
        });
      }
      // Re-load before writing: the entry snapshot may be stale relative to a
      // concurrent tick for another watch in the other process.
      const watchesAfter = loadWatches();
      const fresh = watchesAfter.find(w => w.id === watch.id);
      if (fresh) {
        fresh.lastCheck = now;
        if (triggered) {
          fresh.lastTriggered = now;
          fresh.triggerCount = (fresh.triggerCount || 0) + 1;
        }
        saveWatches(watchesAfter);
      }

      return { content: [{ type: "text", text: `Watch check: ${watch.id}\nSource: ${watch.source} ${watch.target}\nResult: ${JSON.stringify(checkResult)}\nTriggered: ${triggered}` }] };
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      releaseScheduledClaim(watch.platform_execution_id, checkClaim.claim);
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: add, list, remove, pause, check" }], isError: true };
}

const SCHEMAS = {
  cron: z.object({
    action: z.enum(["add", "list", "remove", "run"]).describe("Cron action to perform"),
    name: z.string().max(200).optional().describe("Job name (required for add, optional for remove/run)"),
    schedule: z.string().max(100).optional().describe("Cron schedule expression (e.g. '0 * * * *' for hourly)"),
    command: z.string().max(8192).optional().describe("Command to execute (required for add)"),
    id: z.string().optional().describe("Job ID (for remove/run)")
  }),
  delay: z.object({
    action: z.enum(["add", "list", "cancel", "run"]).describe("Delay action: add (schedule new), list (show all), cancel (remove pending), run (execute immediately)"),
    id: z.string().optional().describe("Delay ID (required for cancel/run)"),
    when: z.string().optional().describe("When to execute: 10s, 5m, 2h, 1d, or ISO date string"),
    name: z.string().optional().describe("Human-readable name for the delay"),
    tool: z.string().optional().describe("Tool name to execute (for add action)"),
    args: z.record(z.any()).optional().describe("Arguments to pass to the tool (for add action)")
  }),
  watch: z.object({
    action: z.enum(["add", "list", "remove", "pause", "check"]).describe("Watch action: add (create new), list (show all), remove (delete), pause (pause/resume), check (manual check)"),
    id: z.string().optional().describe("Watch ID (required for remove/pause/check)"),
    name: z.string().optional().describe("Human-readable watch name"),
    source: z.string().optional().describe("Watch source: service, process, endpoint, or file"),
    target: z.string().optional().describe("Watch target: service name, process name, HTTP(S) URL, or file path"),
    network_scope: z.string().max(80).optional().describe("Operator-created network scope for private or non-global endpoint targets; revalidated on every check"),
    condition: z.string().optional().describe("Trigger condition: status!=active, not_running, status!=200, content_matches, exists, not_exists"),
    value: z.string().max(4096).optional().describe("Required text to match for content_matches file watches"),
    interval: z.string().optional().describe("Check interval: 30s, 5m, 1h (default: 60s)"),
    action_tool: z.string().optional().describe("Tool to call when triggered (default: notify)"),
    action_args: z.record(z.any()).optional().describe("Arguments for action tool"),
    pause: z.boolean().optional().describe("True to pause, false to resume")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "cron",
    description: "Schedule recurring tasks (add, list, remove, run jobs)",
    schema: SCHEMAS.cron,
    args: { action: "string", name: "string (optional)", schedule: "string (optional)", command: "string (optional)", id: "string (optional)" },
    risk: "high",
    category: "Scheduling",
    source: "builtin",
    family: "scheduling",
    handler: sidekick_cron,
  }),
  Object.freeze({
    name: "delay",
    description: "One-shot task scheduling: run a tool once at a specific time or after a delay",
    schema: SCHEMAS.delay,
    args: { action: "string (add|list|cancel|run)", id: "string (optional, for cancel/run)", when: "string (optional, e.g. 10s, 5m, 2h, 1d, or ISO date)", name: "string (optional, human-readable name)", tool: "string (optional, tool name to execute)", args: "object (optional, arguments for the tool)" },
    risk: "high",
    category: "Scheduling",
    source: "builtin",
    family: "scheduling",
    handler: sidekick_delay,
  }),
  Object.freeze({
    name: "watch",
    description: "Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions",
    schema: SCHEMAS.watch,
    args: { action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, HTTP(S) URL, or file path)", network_scope: "string (optional; required for private or non-global endpoint targets)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", value: "string (required for content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" },
    risk: "high",
    category: "Monitoring",
    source: "builtin",
    family: "scheduling",
    handler: sidekick_watch,
  }),
]);

module.exports = {
  descriptors,
  sidekick_cron, sidekick_delay, sidekick_watch,
  loadDelays, saveDelays, recoverStrandedDelays, pauseWatchForCancel,
  loadWatches, saveWatches,
};
