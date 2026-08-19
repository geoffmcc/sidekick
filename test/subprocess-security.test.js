"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const agentSource = fs.readFileSync(path.join(__dirname, "..", "src", "agent.js"), "utf8");
const observabilityPath = path.join(__dirname, "..", "src", "tools", "families", "observability.js");
const observabilitySource = fs.readFileSync(observabilityPath, "utf8");
const netdiagStart = observabilitySource.indexOf("const MAX_NETDIAG_COMMANDS");
const netdiagSource = observabilitySource.slice(netdiagStart);
const { sidekick_netdiag } = require(observabilityPath);
const { childProcessEnv } = require(path.join(__dirname, "..", "src", "security", "child-process"));

function text(result) {
  return result?.content?.[0]?.text || "";
}

assert.ok(!agentSource.includes("execFileSync"), "agent.js must not retain the removed legacy subprocess helpers");
assert.ok(!netdiagSource.includes("execSync("), "netdiag must not execute shell command strings");
assert.ok(!netdiagSource.includes("shellEscape"), "netdiag must not rely on shell escaping");
assert.match(netdiagSource, /safeExecFileSync\(program, args/);

const savedSecret = process.env.SIDEKICK_API_KEY;
const savedNodeOptions = process.env.NODE_OPTIONS;
const savedLowerNodeOptions = process.env.node_options;
process.env.SIDEKICK_API_KEY = "must-not-cross-process-boundary";
process.env.NODE_OPTIONS = "--require attacker-hook";
process.env.node_options = "--require attacker-hook-lowercase";
const filteredEnv = childProcessEnv();
assert.strictEqual(filteredEnv.SIDEKICK_API_KEY, undefined, "child processes must not inherit service credentials");
assert.strictEqual(filteredEnv.NODE_OPTIONS, undefined, "child processes must not inherit runtime loader hooks");
assert.strictEqual(filteredEnv.node_options, undefined, "loader filtering must be case-insensitive on Windows");
if (savedSecret === undefined) delete process.env.SIDEKICK_API_KEY;
else process.env.SIDEKICK_API_KEY = savedSecret;
if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = savedNodeOptions;
if (savedLowerNodeOptions === undefined) delete process.env.node_options;
else process.env.node_options = savedLowerNodeOptions;

(async () => {
  for (const target of ["-x", "example.com; touch /tmp/pwned", "example.com\nwhoami", "a".repeat(2049)]) {
    const result = await sidekick_netdiag({ action: "dns", target });
    assert.strictEqual(result.isError, true, `malformed target should be rejected: ${JSON.stringify(target)}`);
  }

  for (const port_range of ["0-80", "80-65536", "443-22", "80;id", "80-443 extra"]) {
    const result = await sidekick_netdiag({ action: "ports", target: "example.com", port_range });
    assert.strictEqual(result.isError, true, `malformed port range should be rejected: ${port_range}`);
  }

  const connectivity = await sidekick_netdiag({ action: "connectivity", target: "example.com, -n" });
  assert.strictEqual(connectivity.isError, true, "option-like connectivity targets must be rejected");
  assert.match(text(connectivity), /invalid option/);
  console.log("subprocess security regression tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
