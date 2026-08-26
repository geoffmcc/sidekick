const assert = require("assert");
const { runBoundedShell, MAX_COMMAND_LENGTH } = require("../src/security/command-execution");

assert.strictEqual(runBoundedShell("printf bounded").trim(), "bounded");
assert.throws(() => runBoundedShell("rm -rf /"), /dangerous pattern/);
assert.throws(() => runBoundedShell("printf 'bad\nvalue'"), /control character/);
assert.throws(() => runBoundedShell("x".repeat(MAX_COMMAND_LENGTH + 1)), /too long/);

console.log("Command execution safety tests passed");
