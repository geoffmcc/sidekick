"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const bootstrap = fs.readFileSync(path.join(root, "scripts", "bootstrap.sh"), "utf8");
const setupTools = fs.readFileSync(path.join(root, "scripts", "setup-tools.sh"), "utf8");
const sudoers = fs.readFileSync(path.join(root, "systemd", "sidekick-sudoers"), "utf8");
const deployPs = fs.readFileSync(path.join(root, "deploy.ps1"), "utf8");

assert.doesNotMatch(bootstrap, /usermod\s+-aG\s+sudo\s+\"\$USERNAME\"/);
assert.match(bootstrap, /gpasswd\s+-d\s+\"\$USERNAME\"\s+sudo/);
for (const policy of [bootstrap, setupTools, sudoers]) {
  assert.match(policy, /chmod\s+-R\s+700\s+\/home\/sidekick\/sidekick\/data\//);
  assert.doesNotMatch(policy, /chmod\s+-R\s+755\s+\/home\/sidekick\/sidekick\/data\//);
}
assert.match(deployPs, /chmod\s+-R\s+700\s+\$REMOTE_DIR\/data\//);
assert.doesNotMatch(deployPs, /chmod\s+-R\s+755\s+\$REMOTE_DIR\/data\//);

console.log("Passed: service account privilege and data permissions are constrained");
