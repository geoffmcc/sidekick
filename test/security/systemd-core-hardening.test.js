"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const CORE_UNITS = [
  "systemd/sidekick-mcp.service",
  "systemd/sidekick-dashboard.service",
  "systemd/sidekick-agent.service",
];

test("Core systemd units apply host filesystem and kernel hardening without blocking Sidekick state", () => {
  const required = [
    "NoNewPrivileges=true",
    "UMask=0077",
    "PrivateTmp=true",
    "RemoveIPC=true",
    "ProtectSystem=full",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "RestrictRealtime=true",
  ];

  for (const relativePath of CORE_UNITS) {
    const unit = fs.readFileSync(path.join(root, relativePath), "utf8");
    for (const setting of required) {
      assert.ok(unit.split(/\r?\n/).includes(setting), `${relativePath} must set ${setting}`);
    }

    assert.match(unit, /^WorkingDirectory=\/home\/sidekick\/sidekick$/m,
      `${relativePath} keeps the application tree readable and writable as required`);
    assert.match(unit, /^Environment=SIDEKICK_SECRET_DIR=\/etc\/sidekick\/secrets$/m,
      `${relativePath} can read its protected secret directory`);
    assert.doesNotMatch(unit, /^ProtectHome=(?:true|tmpfs|read-only)$/m,
      `${relativePath} must preserve authorized project and runtime writes under /home`);
    assert.doesNotMatch(unit, /^RestrictAddressFamilies=/m,
      `${relativePath} must preserve legitimate outbound integrations and local IPC`);
  }
});

test("Compute worker systemd unit defaults newly created files to owner-only", () => {
  const unit = fs.readFileSync(path.join(root, "systemd/sidekick-compute-worker.service"), "utf8");
  assert.ok(unit.split(/\r?\n/).includes("UMask=0077"));
  assert.match(unit, /^User=sidekick-worker$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/sidekick-compute-worker$/m);
});

test("metrics collector reads its credential from the protected secret directory", () => {
  const unit = fs.readFileSync(path.join(root, "systemd/sidekick-metrics.service"), "utf8");
  for (const setting of [
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    "UMask=0077",
    "Environment=SIDEKICK_SECRET_DIR=/etc/sidekick/secrets",
  ]) assert.ok(unit.split(/\r?\n/).includes(setting), `metrics service must set ${setting}`);
  assert.match(unit, /^User=sidekick$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/sidekick\/sidekick\.env$/m);
  assert.doesNotMatch(unit, /EnvironmentFile=.*\/sidekick\/\.env$/m,
    "metrics must not load credentials from the repository dotenv file");
});
