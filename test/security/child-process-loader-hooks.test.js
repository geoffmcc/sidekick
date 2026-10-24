"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { childProcessEnv } = require("../../src/security/child-process");

const loaderKeys = [
  "LD_AUDIT", "GCONV_PATH", "LOCPATH", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  "PYTHONUSERBASE", "PYTHONINSPECT", "PYTHONSTARTUP", "PYTHONBREAKPOINT",
  "RUBYOPT", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
  "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
];

test("child-process environments remove code-loading and trust-override variables", t => {
  const original = new Map(loaderKeys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const key of loaderKeys) process.env[key] = `synthetic-${key.toLowerCase()}`;
  const overrides = Object.fromEntries(loaderKeys.map(key => [key, `override-${key.toLowerCase()}`]));
  overrides.LANG = "C.UTF-8";
  const childEnv = childProcessEnv(overrides);

  for (const key of loaderKeys) {
    assert.equal(childEnv[key], undefined, `${key} must not reach children from ambient state or explicit overrides`);
  }
  assert.equal(childEnv.LANG, "C.UTF-8", "benign runtime settings remain configurable");
});
