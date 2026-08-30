"use strict";

// Browser subsystem facade.
//
// Owns initialization (directories, orphan reaping, the session reaper timer),
// health aggregation, shutdown, and the action router the `browser` tool
// descriptor calls. Governance (policy, approval, audit, redaction, timeout,
// cancellation) belongs to the dispatcher — this subsystem enforces the
// browser-specific boundaries: egress, isolation, bounded lifecycles, secret
// scrubbing and artifact custody.

const fs = require("fs");
const path = require("path");
const { browserConfig, PROCESS_MARKER } = require("./config");
const driver = require("./driver");
const sessions = require("./sessions");
const actions = require("./actions");

const { BrowserActionError } = actions;

let reaperTimer = null;
let initialized = false;

/**
 * Kill Chromium processes left over from a previous Sidekick process (crash /
 * SIGKILL). Only processes carrying our marker are touched. Linux-only; other
 * platforms report unsupported rather than pretending.
 */
function reapOrphanProcesses() {
  if (process.platform !== "linux") return { supported: false, killed: 0 };
  let killed = 0;
  let entries = [];
  try { entries = fs.readdirSync("/proc"); } catch { return { supported: false, killed: 0 }; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmdline = "";
    try { cmdline = fs.readFileSync(path.join("/proc", entry, "cmdline"), "utf8"); } catch { continue; }
    if (!cmdline.includes(PROCESS_MARKER)) continue;
    // Only reap processes whose parent is init (orphaned) or gone — a live
    // sibling Sidekick process legitimately owns its own marked children.
    let ppid = null;
    try {
      const stat = fs.readFileSync(path.join("/proc", entry, "stat"), "utf8");
      ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]);
    } catch { continue; }
    if (ppid !== 1) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch { /* raced with its own exit */ }
  }
  return { supported: true, killed };
}

function cleanStaleTmp(config) {
  try {
    if (!fs.existsSync(config.tmpDir)) return 0;
    let removed = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(config.tmpDir)) {
      const target = path.join(config.tmpDir, entry);
      try {
        if (fs.statSync(target).mtimeMs < cutoff) {
          fs.rmSync(target, { recursive: true, force: true });
          removed += 1;
        }
      } catch { /* best-effort cleanup */ }
    }
    return removed;
  } catch {
    return 0;
  }
}

function initialize() {
  const config = browserConfig();
  if (!config.enabled) return { initialized: false, reason: "disabled" };
  fs.mkdirSync(config.artifactsDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
  const orphans = reapOrphanProcesses();
  const staleTmp = cleanStaleTmp(config);
  if (!reaperTimer) {
    reaperTimer = setInterval(() => {
      sessions.sweepSessions().catch(() => {});
    }, 60 * 1000);
    reaperTimer.unref();
  }
  initialized = true;
  return { initialized: true, orphans_reaped: orphans.killed, stale_tmp_removed: staleTmp };
}

async function shutdown() {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
  const closed = await sessions.closeAllSessions({ reason: "shutdown" });
  await driver.closeBrowser().catch(() => {});
  return { closed_sessions: closed };
}

async function health({ deep = false } = {}) {
  const config = browserConfig();
  const runtime = await driver.runtimeHealth({ deep });
  return {
    status: runtime.status,
    runtime,
    sessions: { open: sessions.sessionCount(), max: config.maxSessions },
    limits: {
      max_pages_per_session: config.maxPagesPerSession,
      session_ttl_ms: config.sessionTtlMs,
      idle_timeout_ms: config.idleTimeoutMs,
      max_download_bytes: config.maxDownloadBytes,
      max_upload_bytes: config.maxUploadBytes,
    },
    private_network_ceiling: config.allowPrivateNetwork,
    initialized,
  };
}

const SEQUENCE_ACTIONS = new Set([
  "navigate", "back", "forward", "reload",
  "click", "fill", "secret_fill", "clear", "select", "check", "press",
  "hover", "focus", "scroll", "wait",
  "snapshot", "extract", "screenshot", "upload", "assert",
  "switch_page", "close_page",
]);

/**
 * Route a single action. `runtime` carries { signal, context } from the
 * dispatcher; `resolveSecret` is injected by the tool layer so this subsystem
 * never touches the secret store directly.
 */
async function handleAction(args, runtime = {}, { resolveSecret = null } = {}) {
  const action = args.action;
  const project = runtime.context?.project || null;

  switch (action) {
    case "open": {
      const session = await sessions.openSession(args, runtime.context || null);
      return { session: sessions.sessionSummary(session) };
    }
    case "close": {
      const result = await sessions.closeSession(args.session, { reason: "closed_by_caller" });
      return result;
    }
    case "list":
      return { sessions: sessions.listSessions({ project }) };
    case "status": {
      const report = await health({ deep: args.deep === true });
      if (args.session) {
        const session = sessions.getSession(args.session, { project });
        report.session = sessions.sessionSummary(session);
        report.session.warnings = session.warnings.slice(-20);
        report.session.blocked = session.blockedRequests.slice(-20);
      }
      return report;
    }
    default:
      break;
  }

  const session = sessions.getSession(args.session, { project });

  switch (action) {
    case "navigate": return actions.navigate(session, args, runtime);
    case "back": return actions.history(session, args, runtime, "back");
    case "forward": return actions.history(session, args, runtime, "forward");
    case "reload": return actions.history(session, args, runtime, "reload");
    case "snapshot": return actions.snapshot(session, args, runtime);
    case "extract": return actions.extract(session, args, runtime);
    case "click": return actions.interact(session, args, runtime, "click");
    case "fill": return actions.interact(session, args, runtime, "fill");
    case "clear": return actions.interact(session, args, runtime, "clear");
    case "select": return actions.interact(session, args, runtime, "select");
    case "check": return actions.interact(session, args, runtime, "check");
    case "press": return actions.interact(session, args, runtime, "press");
    case "hover": return actions.interact(session, args, runtime, "hover");
    case "focus": return actions.interact(session, args, runtime, "focus");
    case "scroll": return actions.interact(session, args, runtime, "scroll");
    case "secret_fill": {
      if (typeof resolveSecret !== "function") {
        throw new BrowserActionError("secret_fill is unavailable: no secret resolver", "invalid_argument");
      }
      const plaintext = resolveSecret(args.secret_ref);
      if (!plaintext) {
        throw new BrowserActionError(
          `secret_ref "${String(args.secret_ref).slice(0, 100)}" did not resolve to a stored secret (use "secret:<name>")`,
          "secret_not_found"
        );
      }
      return actions.secretFill(session, args, runtime, plaintext);
    }
    case "wait": return actions.waitFor(session, args, runtime);
    case "screenshot": return actions.screenshot(session, args, runtime);
    case "upload": return actions.upload(session, args, runtime);
    case "downloads": return { downloads: session.downloads.slice(-50) };
    case "assert": return actions.runAssertions(session, args, runtime);
    case "pages": return actions.listPages(session);
    case "switch_page": return actions.switchPage(session, args);
    case "close_page": return actions.closePage(session, args);
    case "sequence": return runSequence(session, args, runtime, { resolveSecret });
    default:
      throw new BrowserActionError(`Unknown browser action "${action}"`, "invalid_argument");
  }
}

/**
 * Bounded multi-step execution. One tool call, one approval decision — the
 * dispatcher gates the WHOLE sequence at the tool's risk, so batching cannot
 * lower governance below what the individual actions would face. Sessions
 * cannot be opened or closed from inside a sequence.
 */
async function runSequence(session, args, runtime, helpers) {
  const config = browserConfig();
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (!steps.length) throw new BrowserActionError("sequence requires a non-empty steps array", "invalid_argument");
  if (steps.length > config.maxSequenceSteps) {
    throw new BrowserActionError(`sequence supports at most ${config.maxSequenceSteps} steps`, "invalid_argument");
  }
  const records = [];
  let failed = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] || {};
    const stepAction = String(step.action || "");
    if (runtime.signal && runtime.signal.aborted) {
      records.push({ index, action: stepAction, status: "cancelled" });
      failed = true;
      break;
    }
    if (failed) {
      records.push({ index, action: stepAction, status: "skipped" });
      continue;
    }
    if (!SEQUENCE_ACTIONS.has(stepAction)) {
      records.push({ index, action: stepAction, status: "failed", error: `action "${stepAction}" is not allowed inside a sequence` });
      failed = true;
      continue;
    }
    const started = Date.now();
    try {
      const result = await handleAction({ ...step, action: stepAction, session: session.id }, runtime, helpers);
      records.push({
        index,
        action: stepAction,
        status: "completed",
        duration_ms: Date.now() - started,
        result,
      });
    } catch (error) {
      const classified = actions.classifyError(error);
      records.push({
        index,
        action: stepAction,
        status: "failed",
        duration_ms: Date.now() - started,
        error: classified.message,
        error_category: classified.category,
      });
      if (step.continue_on_error !== true) failed = true;
    }
  }
  return {
    completed: !failed,
    steps: records,
    total_steps: steps.length,
  };
}

module.exports = {
  initialize,
  shutdown,
  health,
  handleAction,
  reapOrphanProcesses,
  PROCESS_MARKER,
  SEQUENCE_ACTIONS,
};
