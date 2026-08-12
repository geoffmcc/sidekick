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

const { exec } = require("child_process");
const { promisify } = require("util");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");

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

const execAsync = promisify(exec);

async function sidekick_bash({ command }) {
  if (isDangerous(command)) {
    return { content: [{ type: "text", text: "Blocked: command matches a dangerous pattern" }], isError: true };
  }
  try {
    const { stdout } = await execAsync(command, { timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    const text = e.killed || e.signal || e.code === "ETIMEDOUT"
      ? "Timed out after 60000ms (killed by " + (e.signal || "timeout") + ")"
      : "Exit code: " + e.code + "\nstdout: " + (e.stdout || "") + "\nstderr: " + (e.stderr || "");
    return { content: [{ type: "text", text: redactSensitive(text) }], isError: true };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "bash",
    description: "Execute a shell command on the remote machine",
    schema: z.object({ command: z.string().describe("Shell command to execute") }),
    args: { command: "string" },
    risk: "critical",
    category: "Core",
    source: "builtin",
    family: "shell",
    handler: sidekick_bash,
  }),
]);

module.exports = { descriptors, sidekick_bash, isDangerous };
