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
const { execSync, execFileSync } = require("child_process");
const { z } = require("zod");
const dbStore = require("../../db");
const { redactSensitive } = require("../../redact");
const evolveCommon = require("../../evolve/common");
const platformKernel = require("../../platform/kernel");
const toolContext = require("../context");
const { enforcePathPolicy } = require("../path-policy");
const { generateId } = require("../../core/ids");
const { callTool } = require("../dispatch-seam");
const {
  createScheduledPlatformExecution,
  transitionScheduledPlatformExecution,
  releaseScheduledClaim,
  startScheduledLeaseRenewal,
  appendScheduledPlatformEvent,
  claimScheduledDefinition,
} = require("../scheduled-execution");

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
  const allowedActions = ["add", "list", "remove", "run"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const jobs = loadCronJobs();

  if (action === "add") {
    if (!name || !schedule || !command) {
      return { content: [{ type: "text", text: "name, schedule, and command required" }], isError: true };
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
      const stdout = execSync(job.command, { timeout: 300000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
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
      try { execFileSync("crontab", ["-r"], { encoding: "utf-8" }); } catch {}
      return;
    }
    const lines = enabledJobs.map(j => {
      const script = `cd /home/sidekick/sidekick && ${j.command} >> ${DATA_DIR}/cron-${j.id}.log 2>&1`;
      return `${j.schedule} ${script} # sidekick:${j.id}`;
    });
    const crontabContent = lines.join("\n") + "\n";
    execFileSync("crontab", ["-"], { input: crontabContent, encoding: "utf-8" });
  } catch (e) {
    // Silently fail if crontab not available
  }
}


const DELAYS_FILE = path.join(DATA_DIR, "delays.json");

function loadDelays() {
  if (!fs.existsSync(DELAYS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DELAYS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveDelays(delays) {
  fs.writeFileSync(DELAYS_FILE, JSON.stringify(delays, null, 2));
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
    createScheduledPlatformExecution("delay", delay, {
      operationType: "delay_task",
      state: "queued",
      risk: getToolRisk(tool),
      deadlineAt: delay.when,
      metadata: { target_tool: tool },
      reason: "delay scheduled",
    });

    delays.push(delay);
    saveDelays(delays);
    appendScheduledPlatformEvent("delay", delay, "schedule.delay.added", { when: delay.when, tool: delay.tool });

    const msUntil = executeAt.getTime() - Date.now();
    const minutes = Math.round(msUntil / 60000);

    try {
      const http = require("http");
      const req = http.request({
        hostname: "127.0.0.1",
        port: 4099,
        path: "/api/delays/reload",
        method: "POST"
      });
      req.on("error", () => {});
      req.end();
    } catch {}

    return { content: [{ type: "text", text: `Scheduled delay: ${delay.id}\nWill execute ${tool} in ${minutes} minutes (${executeAt.toISOString()})` }] };
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
    return JSON.parse(fs.readFileSync(WATCHES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveWatches(watches) {
  fs.writeFileSync(WATCHES_FILE, JSON.stringify(watches, null, 2));
}

function checkService(serviceName) {
  try {
    const output = execFileSync("systemctl", ["is-active", serviceName], { encoding: "utf-8" }).trim();
    return { status: output, active: output === "active" };
  } catch {
    return { status: "unknown", active: false };
  }
}

function checkProcess(processName) {
  try {
    const output = execFileSync("pgrep", ["-f", processName], { encoding: "utf-8" }).trim();
    return { running: output.length > 0, pids: output.split("\n").filter(Boolean) };
  } catch {
    return { running: false, pids: [] };
  }
}

function checkEndpoint(url) {
  try {
    const output = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url], { encoding: "utf-8" }).trim();
    return { status: parseInt(output), ok: output.startsWith("2") };
  } catch {
    return { status: 0, ok: false };
  }
}

function checkFile(filePath, pattern) {
  try {
    const output = fs.readFileSync(filePath, "utf-8");
    const matches = pattern ? output.includes(pattern) : true;
    return { exists: true, matches, content: output.substring(0, 200) };
  } catch {
    return { exists: false, matches: false };
  }
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

async function sidekick_watch({ action, id, name, source, target, condition, interval, action_tool, action_args, pause }) {
  const watches = loadWatches();
  const now = new Date().toISOString();

  if (action === "add") {
    if (!name || !source || !target || !condition) {
      return { content: [{ type: "text", text: "name, source, target, and condition required" }], isError: true };
    }

    const validSources = ["service", "process", "endpoint", "file"];
    if (!validSources.includes(source)) {
      return { content: [{ type: "text", text: `Invalid source. Use: ${validSources.join(", ")}` }], isError: true };
    }
    if (source === "file") {
      const policyError = enforcePathPolicy(target, "read");
      if (policyError) return policyError;
    }

    const watch = {
      id: generateId("watch"),
      name,
      source,
      target,
      condition,
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
      metadata: { source: watch.source, target: watch.target, condition: watch.condition, interval: watch.interval, action_tool: watch.action_tool },
      reason: "watch scheduled",
    });

    watches.push(watch);
    saveWatches(watches);
    appendScheduledPlatformEvent("watch", watch, "schedule.watch.added", { source: watch.source, target: watch.target, condition: watch.condition, interval: watch.interval });

    try {
      const http = require("http");
      const req = http.request({
        hostname: "127.0.0.1",
        port: 4099,
        path: "/api/watches/reload",
        method: "POST"
      });
      req.on("error", () => {});
      req.end();
    } catch {}

    return { content: [{ type: "text", text: `Added watch: ${watch.id}\nName: ${name}\nSource: ${source} ${target}\nCondition: ${condition}\nInterval: ${watch.interval}\nAction: ${watch.action_tool}` }] };
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
      let checkResult;
      if (watch.source === "service") {
        checkResult = checkService(watch.target);
      } else if (watch.source === "process") {
        checkResult = checkProcess(watch.target);
      } else if (watch.source === "endpoint") {
        checkResult = checkEndpoint(watch.target);
      } else if (watch.source === "file") {
        const policyError = enforcePathPolicy(watch.target, "read");
        if (policyError) return policyError;
        checkResult = checkFile(watch.target, watch.condition === "content_matches" ? watch.value : null);
      }

      const checkExecution = createScheduledPlatformExecution("watch", watch, {
        attach: false,
        parentExecutionId: watch.platform_execution_id || null,
        rootExecutionId: watch.platform_execution_id || null,
        operationType: "watch_check",
        state: "running",
        risk: getToolRisk(watch.action_tool),
        metadata: { source: watch.source, target: watch.target, condition: watch.condition },
        reason: "watch check started",
      });
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
    name: z.string().optional().describe("Job name (required for add, optional for remove/run)"),
    schedule: z.string().optional().describe("Cron schedule expression (e.g. '0 * * * *' for hourly)"),
    command: z.string().optional().describe("Command to execute (required for add)"),
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
    target: z.string().optional().describe("Watch target: service name, process name, URL, or file path"),
    condition: z.string().optional().describe("Trigger condition: status!=active, not_running, status!=200, content_matches, exists, not_exists"),
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
    args: { action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, URL, or file path)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" },
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
