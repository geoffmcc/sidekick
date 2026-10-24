"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { runMetricsCommand } = require("../../src/security/metrics-child-process");

test("metrics host probes do not inherit collector credentials or loader hooks", t => {
  const keys = ["SIDEKICK_INFLUX_TOKEN", "GITHUB_TOKEN", "LD_AUDIT", "NODE_PATH"];
  const original = new Map(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of keys) process.env[key] = `synthetic-${key.toLowerCase()}`;

  let captured;
  const result = runMetricsCommand("probe", ["--safe"], { timeout: 1234 }, (program, args, options) => {
    captured = { program, args, options };
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(captured.program, "probe");
  assert.deepEqual(captured.args, ["--safe"]);
  assert.equal(captured.options.timeout, 1234);
  for (const key of keys) assert.equal(captured.options.env[key], undefined, `${key} must not be passed to metric subprocesses`);
});

test("every metrics subprocess call goes through the filtered launcher", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../scripts/collect-metrics.js"), "utf8");
  const directExecCalls = source.match(/\bexecFileSync\s*\(/g) || [];
  assert.equal(directExecCalls.length, 0, "the collector must not invoke execFileSync directly");
  for (const executable of ["df", "docker", "curl", "systemctl"]) {
    assert.match(source, new RegExp(`runMetricsCommand\\(['\"]${executable}['\"]`), `${executable} probes must use the filtered launcher`);
  }
});
