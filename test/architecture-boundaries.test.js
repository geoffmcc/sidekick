const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const result = spawnSync(process.execPath, [path.join(root, "scripts", "check-architecture.js")], { cwd: root, encoding: "utf8" });
assert.strictEqual(result.status, 0, `architecture check failed:\n${result.stderr || result.stdout}`);
assert.match(result.stdout, /Architecture boundaries OK/);
assert.doesNotMatch(fs.readFileSync(path.join(root, "src", "platform", "kernel.js"), "utf8"), /require\(["']\.\.\/packs\//);
assert.doesNotMatch(fs.readFileSync(path.join(root, "src", "dashboard", "request-metrics.js"), "utf8"), /req\.(url|originalUrl)/);
console.log("Architecture boundary and cycle checks passed");
