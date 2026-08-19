"use strict";

// Phase 11 regression: the Network/Firewall pack must resolve Sidekick
// dependencies from its installation root, not from a Linux-only deployment
// path or an attacker-controlled working directory.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const deps = require("../packs/network-firewall/modules/network-firewall-tools/lib/deps");
const profiles = require("../packs/network-firewall/modules/network-firewall-tools/lib/profiles");

const originalCwd = process.cwd();
const hostileCwd = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-phase-11-cwd-"));
try {
  process.chdir(hostileCwd);
  const resolver = deps.requireSidekickSrc("src/connectors/resolve.js");
  assert.strictEqual(typeof resolver.resolveSecretRef, "function");
  assert.strictEqual(typeof deps.requireFromSidekick("zod").z.object, "function");

  const parsed = profiles.parse("test-profile", {
    provider: "opnsense",
    endpoint: "https://firewall.example.internal",
    credential_ref: "secret:firewall-api",
  });
  assert.strictEqual(parsed.credential, null, "profile parsing must not resolve or expose credentials");
  console.log("Phase 11 Network/Firewall dependency-resolution security test passed.");
} finally {
  process.chdir(originalCwd);
  fs.rmSync(hostileCwd, { recursive: true, force: true });
}
