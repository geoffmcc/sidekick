"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { hasNoNewPrivileges, runSudoCommand } = require("../../src/core/privilege-diagnostics");

test("network privilege calls all pass through the NNP diagnostic guard", () => {
  const networking = fs.readFileSync(require.resolve("../../src/tools/families/networking"), "utf8");
  assert.doesNotMatch(networking, /safeExecFileSync\(["']sudo["']/);
  assert.match(networking, /function safeSudoExecFileSync\(/);
  assert.match(networking, /runSudoCommand\(args, options, \{ childProcessEnv \}\)/);
});

test("NoNewPrivs status is parsed as an exact kernel status field", () => {
  assert.equal(hasNoNewPrivileges("Name:\tnode\nNoNewPrivs:\t1\nSeccomp:\t2\n"), true);
  assert.equal(hasNoNewPrivileges("Name:\tnode\nNoNewPrivs:\t0\n"), false);
  assert.equal(hasNoNewPrivileges("Name:\tnode\nNoNewPrivsExtra:\t1\n"), false);
  assert.equal(hasNoNewPrivileges(""), false);
});

test("sudo is not attempted from a non-root process with NoNewPrivs enabled", () => {
  let invoked = false;
  assert.throws(() => runSudoCommand(["/usr/bin/id", "-u"], {}, {
    getuid: () => 1000,
    readStatus: () => "Name:\tnode\nNoNewPrivs:\t1\n",
    execFileSync: () => { invoked = true; },
  }), error => {
    assert.equal(error.code, "SIDEKICK_NO_NEW_PRIVILEGES");
    assert.match(error.message, /NoNewPrivileges enabled/);
    assert.match(error.message, /No change was made/);
    assert.match(error.message, /narrowly scoped privileged broker/);
    return true;
  });
  assert.equal(invoked, false, "the privileged command must not be attempted");
});

test("sudo execution remains available when elevation is not blocked by NNP", () => {
  const call = {};
  const result = runSudoCommand(["/usr/bin/id", "-u"], { timeout: 1000 }, {
    getuid: () => 1000,
    readStatus: () => "Name:\tnode\nNoNewPrivs:\t0\n",
    childProcessEnv: env => ({ ...env, SIDEKICK_TEST: "1" }),
    execFileSync: (program, args, options) => {
      Object.assign(call, { program, args, options });
      return "0\n";
    },
  });

  assert.equal(result, "0\n");
  assert.equal(call.program, "sudo");
  assert.deepEqual(call.args, ["/usr/bin/id", "-u"]);
  assert.equal(call.options.timeout, 1000);
  assert.equal(call.options.env.SIDEKICK_TEST, "1");
});

test("root does not need sudo elevation even when NoNewPrivs is set", () => {
  let invoked = false;
  runSudoCommand(["/usr/bin/id", "-u"], {}, {
    getuid: () => 0,
    readStatus: () => "NoNewPrivs:\t1\n",
    execFileSync: () => { invoked = true; return "0"; },
  });
  assert.equal(invoked, true);
});
