"use strict";

const { execFileSync } = require("child_process");
const { isDangerous } = require("../tools/families/shell");
const { childProcessEnv } = require("./child-process");

const MAX_COMMAND_LENGTH = 16384;

function runBoundedShell(command, options = {}) {
  const value = String(command || "");
  if (!value || value.length > MAX_COMMAND_LENGTH || /[\u0000\r\n]/.test(value)) throw new Error("command is empty, too long, or contains a control character");
  if (isDangerous(value)) throw new Error("command matches a dangerous pattern");
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", value] : ["-c", value];
  return execFileSync(shell, args, { shell: false, timeout: Math.max(1000, Math.min(Number(options.timeout) || 60000, 3600000)), encoding: options.encoding || "utf8", stdio: options.stdio || ["pipe", "pipe", "pipe"], maxBuffer: Math.min(Number(options.maxBuffer) || 10 * 1024 * 1024, 50 * 1024 * 1024), env: childProcessEnv(options.env) });
}

module.exports = { runBoundedShell, MAX_COMMAND_LENGTH };
