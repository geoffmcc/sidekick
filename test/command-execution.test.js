const assert = require("assert");
const fs = require("fs");
const bubblewrap = require("../src/core/bubblewrap-executor");
const { runBoundedShell, MAX_COMMAND_LENGTH } = require("../src/security/command-execution");

if (process.platform === "linux" && fs.existsSync(bubblewrap.DEFAULT_BWRAP)) {
  assert.strictEqual(runBoundedShell("echo bounded").trim(), "bounded");
} else {
  assert.throws(() => runBoundedShell("echo must-not-run"), error => error.code === "isolation_unavailable");
}
assert.throws(() => runBoundedShell("rm -rf /"), /dangerous pattern/);
assert.throws(() => runBoundedShell("printf 'bad\nvalue'"), /control character/);
assert.throws(() => runBoundedShell("x".repeat(MAX_COMMAND_LENGTH + 1)), /too long/);

console.log("Command execution safety tests passed");
