"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { killWindowsProcessTree } = require("../../src/compute/openvino-helper-manager");

test("OpenVINO Windows cleanup uses system taskkill and does not inherit Sidekick credentials", t => {
  const names = ["SIDEKICK_TEST_API_KEY", "PGPASSFILE", "SSH_AUTH_SOCK", "NODE_OPTIONS"];
  const previous = new Map([...names, "PATH"].map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  for (const name of names) process.env[name] = `synthetic-${name.toLowerCase()}`;
  process.env.PATH = "C:\\attacker\\bin";
  let invocation;
  killWindowsProcessTree(4812, {
    systemRoot: "C:\\Windows",
    spawnSyncImpl: (...args) => { invocation = args; return { status: 0 }; },
  });

  assert.equal(invocation[0], "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(invocation[1], ["/T", "/F", "/PID", "4812"]);
  for (const name of names) {
    assert.equal(invocation[2].env[name], undefined, `${name} must not reach taskkill`);
  }
  assert.equal(invocation[2].shell, false);
  assert.equal(invocation[2].timeout, 5000);
});
