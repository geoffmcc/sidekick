"use strict";

const { execFileSync } = require("child_process");
const { isDangerous } = require("../tools/families/shell");
const { buildBubblewrapArgs } = require("../core/bubblewrap-executor");

const MAX_COMMAND_LENGTH = 16384;

function runBoundedShell(command, options = {}) {
  const value = String(command || "");
  if (!value || value.length > MAX_COMMAND_LENGTH || /[\u0000\r\n]/.test(value)) throw new Error("command is empty, too long, or contains a control character");
  if (isDangerous(value)) throw new Error("command matches a dangerous pattern");
  // This legacy helper has several callers outside the dedicated `bash` tool.
  // Route every one through the same OS boundary; an in-process shell with a
  // scrubbed environment is still unrestricted host execution. No workspace
  // is mounted here, so callers that need files must use the governed shell
  // interface with an explicitly authorized workspace.
  const invocation = buildBubblewrapArgs({ command: value });
  return execFileSync(invocation.executable, invocation.args, {
    shell: false,
    timeout: Math.max(1000, Math.min(Number(options.timeout) || 60000, 3600000)),
    encoding: options.encoding || "utf8",
    // Bubblewrap's JSON status channel is fd 3. It must be a pipe even when
    // the caller only needs stdout; discarding it makes bwrap hang while
    // reporting namespace setup.
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    maxBuffer: Math.min(Number(options.maxBuffer) || 10 * 1024 * 1024, 50 * 1024 * 1024),
    windowsHide: true,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
}

module.exports = { runBoundedShell, MAX_COMMAND_LENGTH };
