"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const security = fs.readFileSync(path.join(root, "docs", "security.md"), "utf8");
const artifact = fs.readFileSync(path.join(root, "docs", "security-phase-04-secure-defaults.md"), "utf8");

assert.match(envExample, /SIDEKICK_ALLOWED_IPS=127\.0\.0\.1,::1/);
assert.match(envExample, /SIDEKICK_DASHBOARD_ALLOWED_IPS=127\.0\.0\.1,::1/);
assert.match(envExample, /SIDEKICK_TOOL_POLICY=restricted/);
assert.match(envExample, /SIDEKICK_APPROVAL_MODE=strict/);
assert.ok(readme.includes("Fresh `.env.example` configurations allow only loopback"));
assert.ok(security.includes("Fresh installations use the local identity bootstrap/login flow"));
for (const marker of ["F4-01", "Compatibility and migration", "Residual risk"]) {
  assert.ok(artifact.includes(marker), `Phase 4 artifact is missing ${marker}`);
}

console.log("Phase 4 secure-default checks passed.");
