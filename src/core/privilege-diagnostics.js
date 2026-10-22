"use strict";

const fs = require("fs");

function hasNoNewPrivileges(statusText) {
  const match = /^NoNewPrivs:\s*([01])\s*$/m.exec(String(statusText || ""));
  return match?.[1] === "1";
}

function noNewPrivilegesError(operation) {
  const error = new Error(
    `${operation} was not run: this Sidekick service has NoNewPrivileges enabled, so sudo cannot elevate. ` +
    "No change was made. Keep NoNewPrivileges enabled and configure a supported, narrowly scoped privileged broker."
  );
  error.code = "SIDEKICK_NO_NEW_PRIVILEGES";
  return error;
}

function readProcessStatus() {
  try {
    return fs.readFileSync("/proc/self/status", "utf8");
  } catch {
    return "";
  }
}

function runSudoCommand(args, options = {}, dependencies = {}) {
  const getuid = dependencies.getuid || process.getuid;
  const uid = typeof getuid === "function" ? getuid() : null;
  const readStatus = dependencies.readStatus || readProcessStatus;
  if (uid !== 0 && hasNoNewPrivileges(readStatus())) {
    throw noNewPrivilegesError("The privileged network operation");
  }

  const execFileSync = dependencies.execFileSync || require("child_process").execFileSync;
  const childProcessEnv = dependencies.childProcessEnv || (env => env);
  return execFileSync("sudo", args, { ...options, env: childProcessEnv(options.env) });
}

module.exports = { hasNoNewPrivileges, noNewPrivilegesError, runSudoCommand };
