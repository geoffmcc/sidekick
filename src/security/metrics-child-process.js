"use strict";

const { execFileSync } = require("node:child_process");
const { childProcessEnv } = require("./child-process");

// The metrics collector needs service secrets to write telemetry, but its host
// probes and Docker/system utilities do not. Keep these child environments on
// the same credential and loader-hook filter used by Core subprocesses.
function runMetricsCommand(program, args, options = {}, execFileSyncImpl = execFileSync) {
  return execFileSyncImpl(program, args, {
    ...options,
    env: childProcessEnv(options.env),
  });
}

module.exports = { runMetricsCommand };
