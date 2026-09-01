const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");
const root = path.join(__dirname, "..");
const result = spawnSync(process.execPath, [path.join(root, "scripts", "check-docs.js")], { cwd: root, encoding: "utf8" });
assert.strictEqual(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /Documentation drift checks passed/);
console.log("Documentation drift checks passed");
