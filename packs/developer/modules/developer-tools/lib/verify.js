"use strict";

/**
 * Governed software-project verification.
 *
 * Commands are SELECTED here and EXECUTED by Sidekick's `bash` tool through
 * the module services facade. The pack never spawns a process itself: running
 * project commands is a critical-risk operation, and it must carry the
 * dispatcher's policy, approval, timeout, redaction and audit path rather than
 * quietly stepping around it.
 *
 * Selection is conservative on purpose:
 *   - explicit configuration overrides win outright;
 *   - otherwise a command is only run when detection found real evidence for
 *     it (a package script, a lockfile, an ecosystem marker);
 *   - when detection is ambiguous or empty for an intent, that intent is
 *     reported as `not_detected` rather than guessed at.
 */

const INTENTS = Object.freeze(["syntax", "lint", "typecheck", "test", "build"]);

const MODE_INTENTS = Object.freeze({
  quick: ["syntax", "lint", "typecheck"],
  standard: ["lint", "typecheck", "test"],
  full: ["lint", "typecheck", "test", "build"],
});

// Node's own syntax check, used only when the project is a Node project and
// the operator asked for the `syntax` intent. It is deliberately not inferred
// for other ecosystems: a wrong syntax command is worse than none.
const SYNTAX_COMMANDS = Object.freeze({
  // Prunes EVERY node_modules directory, not just the top-level one: a
  // vendored dependency tree anywhere under the repository would otherwise
  // dominate the check and report failures the project does not own.
  node: 'find . \\( -name node_modules -o -name .git \\) -prune -o -name "*.js" -print0 | xargs -0 -r -n50 node --check',
});

function textOf(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map(part => (part && typeof part.text === "string" ? part.text : "")).join("\n");
}

/** Shell-quote a path for a POSIX shell. */
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function windowsQuote(value) { return `"${String(value).replace(/"/g, '""')}"`; }

function commandRequiresWrite(intent, command) {
  if (["build", "test"].includes(intent)) return true;
  return /(?:--fix(?:\b|=)|\b(?:rm|rmdir|mkdir|touch|mv|cp|install|write|unlink)\b|(?:^|[\s/])(?:build|dist|coverage|out)(?:[/\s]|$)|\bemit\b)/i.test(String(command || ""));
}

function workspacePermissions(root) {
  const access = mode => { try { require("fs").accessSync(root, mode); return true; } catch { return false; } };
  return { read: access(require("fs").constants.R_OK), write: access(require("fs").constants.W_OK), execute: access(require("fs").constants.X_OK) };
}

function mountMode(root) {
  if (process.platform !== "linux") return { available: false, mode: "unknown" };
  try {
    const mounts = require("fs").readFileSync("/proc/mounts", "utf8").split(/\r?\n/).filter(Boolean);
    const target = require("path").resolve(root);
    let best = null;
    for (const line of mounts) {
      const fields = line.split(" ");
      if (fields.length < 4) continue;
      const mountPoint = fields[1].replace(/\\040/g, " ");
      if (target === mountPoint || target.startsWith(`${mountPoint}/`)) {
        if (!best || mountPoint.length > best.mount_point.length) best = { mount_point: mountPoint, options: fields[3].split(",") };
      }
    }
    return best ? { available: true, mode: best.options.includes("ro") ? "read_only" : "read_write", mount_point: best.mount_point } : { available: false, mode: "unknown" };
  } catch { return { available: false, mode: "unknown" }; }
}

function workspacePreflight(root, selection) {
  const permissions = workspacePermissions(root);
  const mount = mountMode(root);
  const commands = selection.map(entry => ({
    intent: entry.intent,
    command: entry.command,
    command_requires_write: Boolean(entry.command && commandRequiresWrite(entry.intent, entry.command)),
    would_modify_files: Boolean(entry.command && commandRequiresWrite(entry.intent, entry.command)),
  }));
  const requiresWrite = commands.some(entry => entry.command_requires_write);
  const readOnly = permissions.write !== true || mount.mode === "read_only";
  const allowed = !requiresWrite || !readOnly;
  return {
    execution_host: require("os").hostname(),
    workspace: root,
    workspace_permissions: permissions,
    mount,
    commands,
    write_requirements: commands.filter(entry => entry.command_requires_write).map(entry => ({ intent: entry.intent, command: entry.command })),
    command_requires_write: requiresWrite,
    allowed,
    refusal: allowed ? null : { code: "workspace_write_not_allowed", reason: "a selected command may modify files in the current workspace" },
    reason: allowed ? null : "selected verification commands may modify files but the workspace is read-only",
  };
}

function boundOutput(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return { output: value, truncated: false };
  // Keep the tail: compilers and test runners put the summary at the end.
  const head = Math.floor(maxChars * 0.3);
  const tail = maxChars - head;
  return {
    output: `${value.slice(0, head)}\n…[truncated ${value.length - maxChars} characters]…\n${value.slice(-tail)}`,
    truncated: true,
  };
}

/**
 * Extract the exit status the bash tool reports. The tool returns
 * "Exit code: N\nstdout: …\nstderr: …" on failure and plain stdout on success.
 */
function parseExecution(result) {
  const text = textOf(result);
  if (!result || !result.isError) return { exit_code: 0, output: text, timed_out: false };
  const timedOut = /^Timed out after/.test(text);
  const match = text.match(/^Exit code:\s*(\d+|null)/);
  return {
    exit_code: timedOut ? null : match ? (match[1] === "null" ? null : Number(match[1])) : null,
    output: text,
    timed_out: timedOut,
  };
}

/**
 * Resolve which command to run for each requested intent.
 *
 * Returns one entry per intent with either a command and the reason it was
 * chosen, or an explicit "not detected" verdict. Nothing is invented.
 */
function selectCommands({ intents, candidates, overrides = {}, ecosystems = [] }) {
  const selection = [];
  for (const intent of intents) {
    const override = overrides[`${intent}_command`];
    if (override) {
      selection.push({ intent, command: override, selected_because: `explicit ${intent}_command configuration override`, source: "configuration" });
      continue;
    }
    if (intent === "syntax") {
      const isNode = ecosystems.some(entry => entry.ecosystem === "node");
      if (isNode) {
        selection.push({ intent, command: SYNTAX_COMMANDS.node, selected_because: "Node project detected (package.json); node --check over tracked JavaScript", source: "ecosystem" });
      } else {
        selection.push({ intent, command: null, status: "not_detected", selected_because: "no syntax check is defined for the detected ecosystems" });
      }
      continue;
    }
    const matches = candidates.filter(candidate => candidate.intent === intent);
    if (!matches.length) {
      selection.push({ intent, command: null, status: "not_detected", selected_because: `no ${intent} command could be detected from project files` });
      continue;
    }
    // Prefer a package-script candidate: it is what the project's own authors
    // told the world to run.
    const preferred = matches.find(candidate => candidate.source === "package.json scripts") || matches[0];
    selection.push({
      intent,
      command: preferred.command,
      selected_because: `${preferred.source}: ${preferred.evidence}`,
      source: preferred.source,
      alternatives: matches.filter(candidate => candidate.command !== preferred.command).map(candidate => candidate.command),
    });
  }
  return selection;
}

/**
 * Execute the selected commands through the governed bash tool.
 * Stops early on failure unless `continueOnFailure` is set.
 */
async function runSelection(services, { root, selection, maxOutputChars, timeoutMs, continueOnFailure }) {
  const results = [];
  for (const entry of selection) {
    if (!entry.command) {
      results.push({ ...entry, status: "not_detected", executed: false });
      continue;
    }
    const command = process.platform === "win32"
      ? `cd /d ${windowsQuote(root)} && ${entry.command}`
      : `cd ${quote(root)} && ${entry.command}`;
    const started = Date.now();
    let dispatched;
    try {
      dispatched = await services.dispatch("bash", { command }, { timeoutMs });
    } catch (error) {
      const detail = String(error && error.message ? error.message : error);
      results.push({
        ...entry,
        status: /timeout|timed out|mcp|session/i.test(detail) ? "timed_out" : "failed",
        executed: false,
        command_executed: command,
        duration_ms: Date.now() - started,
        error_code: "verification_dispatch_failed",
        detail: detail.slice(0, 1000),
        execution_state: "unknown",
      });
      break;
    }
    const durationMs = Date.now() - started;

    if (dispatched && dispatched.approvalRequired) {
      results.push({
        ...entry,
        status: "approval_required",
        executed: false,
        approval_id: dispatched.approvalId || null,
        command_executed: command,
        duration_ms: durationMs,
        detail: "verification command requires operator approval before it can run",
      });
      break;
    }
    if (dispatched && dispatched.code === "module_permission_denied") {
      results.push({ ...entry, status: "blocked", executed: false, command_executed: command, detail: textOf(dispatched), duration_ms: durationMs });
      break;
    }

    if (!dispatched || typeof dispatched !== "object") {
      results.push({ ...entry, status: "failed", executed: false, command_executed: command, duration_ms: durationMs, error_code: "empty_verification_dispatch", detail: "The governed command dispatcher returned no result.", execution_state: "unknown" });
      break;
    }
    const execution = parseExecution(dispatched);
    const bounded = boundOutput(execution.output, maxOutputChars);
    const passed = dispatched.isError !== true;
    results.push({
      ...entry,
      status: passed ? "passed" : execution.timed_out ? "timed_out" : "failed",
      executed: true,
      command_executed: command,
      exit_code: execution.exit_code,
      duration_ms: durationMs,
      output: bounded.output,
      output_truncated: bounded.truncated,
    });
    if (!passed && !continueOnFailure) break;
  }
  return results;
}

/** Overall verdict across executed intents. */
function summarize(results, intents) {
  const executed = results.filter(entry => entry.executed);
  const failed = results.filter(entry => entry.status === "failed" || entry.status === "timed_out");
  const blocked = results.filter(entry => entry.status === "approval_required" || entry.status === "blocked");
  const notDetected = results.filter(entry => entry.status === "not_detected");
  const notRun = intents.filter(intent => !results.some(entry => entry.intent === intent));

  let verdict;
  if (failed.length) verdict = "failed";
  else if (blocked.length) verdict = "blocked";
  else if (!executed.length) verdict = "nothing_to_verify";
  else if (notDetected.length || notRun.length) verdict = "passed_partial";
  else verdict = "passed";

  return {
    verdict,
    executed_count: executed.length,
    passed_count: executed.filter(entry => entry.status === "passed").length,
    failed_count: failed.length,
    blocked_count: blocked.length,
    not_detected: notDetected.map(entry => entry.intent),
    not_run: notRun,
    failures: failed.map(entry => ({
      intent: entry.intent,
      command: entry.command_executed,
      exit_code: entry.exit_code,
      status: entry.status,
      output_tail: String(entry.output || "").split("\n").slice(-25).join("\n"),
    })),
  };
}

module.exports = { INTENTS, MODE_INTENTS, selectCommands, runSelection, summarize, parseExecution, quote, windowsQuote, boundOutput, textOf, commandRequiresWrite, workspacePermissions, mountMode, workspacePreflight };
