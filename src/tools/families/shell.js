"use strict";

// Shell tool family: bash.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, zod, and
// the shared redaction utility — never on tools-legacy.js. `bash` is `critical`
// risk (arbitrary shell execution), preserved from src/tools/metadata.js and
// gated by the dispatcher; the DANGEROUS_PATTERNS pre-filter and isDangerous
// are moved verbatim. isDangerous stays on the tools-legacy/facade export
// surface (src/tools/policy.js and test/security.test.js consume it there);
// tools-legacy re-imports it from this family.

const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { runBubblewrap } = require("../../core/bubblewrap-executor");
const { requireToolExecution } = require("../read-authorization");

const DANGEROUS_PATTERNS = [
  /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|$|[/*])/i,
  /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+\/(?:var|etc|home|usr|bin|sbin|lib|lib64|boot|root)(?:\s|$|\/)/i,
  /\s*>\s*\/dev\/(sd|nvme|vd|xvd)[a-z0-9]*/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\b(fdisk|parted)\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /:\(\)\{/,
  /\b(curl|wget)\b\s+.*\|\s*(?:sudo\s+)?(?:bash|sh)\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

function isDangerous(cmd) {
  return DANGEROUS_PATTERNS.some(p => p.test(cmd));
}

const DEFAULT_TIMEOUT_MS = 60000;
// Ceiling for a caller-supplied deadline. Callers that legitimately run long
// work (project test suites, Ansible plays, research probes) declare their own
// budget; this only stops a caller from removing the bound entirely.
const MAX_TIMEOUT_MS = 3600000;

async function sidekick_bash({ command, cwd }, runtime = {}) {
  const authError = requireToolExecution({ tool: "bash" }, "tools.execute_critical", "bash");
  if (authError) return authError;
  if (isDangerous(command)) {
    return { content: [{ type: "text", text: "Blocked: command matches a dangerous pattern" }], isError: true };
  }
  // Honor the deadline the dispatcher was given. The 60s constant used to be
  // absolute, which silently killed every caller that declared a longer budget
  // — a project's test suite, a playbook, a long probe — and then reported the
  // kill as if the command itself had failed.
  // The margin keeps the process kill ahead of the dispatcher's own deadline,
  // so a timeout is reported as a killed command rather than as the
  // dispatcher's "operation may still be running".
  const requested = Number(runtime?.context?.timeoutMs);
  const timeout = requested > 0
    ? Math.max(1000, Math.min(requested, MAX_TIMEOUT_MS) - 250)
    : DEFAULT_TIMEOUT_MS;
  try {
    const result = await runBubblewrap({
      command,
      workspace: cwd,
      workspaceReadOnly: runtime?.context?.workspaceReadOnly === true,
      source: runtime?.context?.source || "mcp",
      timeoutMs: timeout,
      signal: runtime?.signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.timedOut) {
      return { content: [{ type: "text", text: redactSensitive(`Timed out after ${timeout}ms; the isolated process tree was stopped`) }], isError: true, code: "command_timed_out" };
    }
    if (result.outputExceeded) {
      return { content: [{ type: "text", text: "Command output exceeded the configured limit; the isolated process tree was stopped" }], isError: true, code: "output_limit_exceeded" };
    }
    if (result.cancelled) {
      return { content: [{ type: "text", text: "Shell execution cancelled; the isolated process tree was stopped" }], isError: true, code: "cancelled" };
    }
    if (result.exitCode !== 0) {
      const text = `Exit code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
      return { content: [{ type: "text", text: redactSensitive(text) }], isError: true, code: "command_failed" };
    }
    return { content: [{ type: "text", text: redactSensitive(result.stdout || "(empty output)") }] };
  } catch (e) {
    const knownCodes = new Set(["workspace_invalid", "workspace_denied", "command_invalid", "isolation_unavailable", "isolation_configuration_invalid", "sandbox_initialization_failed"]);
    const code = knownCodes.has(e.code) ? e.code : "sandbox_execution_failed";
    return { content: [{ type: "text", text: redactSensitive(e.message || "OS sandbox execution failed; command was not run") }], isError: true, code };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "bash",
    description: "Execute a shell command in an OS-isolated environment with no network access and an optional authorized workspace",
    schema: z.object({
      command: z.string().min(1).max(65536).describe("Shell command to execute in the isolated environment"),
      cwd: z.string().optional().describe("Absolute existing workspace path; must be covered by filesystem allow-path policy. Only this directory is mounted writable."),
    }),
    args: { command: "string", cwd: "string?" },
    risk: "critical",
    category: "Core",
    source: "builtin",
    family: "shell",
    handler: sidekick_bash,
  }),
]);

module.exports = { descriptors, sidekick_bash, isDangerous };
