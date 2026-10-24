"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

test("agent evidence classification stays bounded for adversarial repeated phrases", () => {
  const script = [
    'const { classifyEvidenceRequirement } = require("./src/agent-protocol");',
    'const result = classifyEvidenceRequirement("look up ".repeat(40_000));',
    'if (result.reason !== "no_evidence_signals") process.exit(2);',
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined, `classifier subprocess failed: ${result.error?.message || "unknown error"}`);
  assert.equal(result.status, 0, result.stderr || "classifier changed expected routing");
});
