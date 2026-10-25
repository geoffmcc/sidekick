"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { configureWorkspaceWritePath } = require("../../packaging/execution-node/configure-systemd-workspace");
const { removeOwnedTempTree } = require("../helpers/owned-temp-cleanup");

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
    "TasksMax=256",
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
    assert.doesNotMatch(unit, /^LimitNPROC=/m,
      `${relativePath} must use its service cgroup task limit instead of a shared-UID process limit`);
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
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "UMask=0077",
    "Environment=SIDEKICK_SECRET_DIR=/etc/sidekick/secrets",
  ]) assert.ok(unit.split(/\r?\n/).includes(setting), `metrics service must set ${setting}`);
  assert.match(unit, /^User=sidekick$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/sidekick\/sidekick\.env$/m);
  assert.doesNotMatch(unit, /EnvironmentFile=.*\/sidekick\/\.env$/m,
    "metrics must not load credentials from the repository dotenv file");
});

test("execution-node installer grants systemd writes only to an explicitly writable workspace", t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-node-systemd-"));
  t.after(() => removeOwnedTempTree(fixture, "sidekick-node-systemd-"));
  const home = path.join(fixture, "home");
  const workspace = path.join(home, "Projects", "Research 100%");
  const configDirectory = path.join(home, ".config", "sidekick");
  const unitDirectory = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(configDirectory, { recursive: true });
  const configPath = path.join(configDirectory, "node.json");
  fs.writeFileSync(configPath, JSON.stringify({ workspace, permissions: { write: true } }));

  const enabled = configureWorkspaceWritePath({ configPath, home, unitDirectory });
  assert.equal(enabled.writeEnabled, true);
  assert.match(fs.readFileSync(enabled.dropInPath, "utf8"), /ReadWritePaths=.*Research 100%%/);

  fs.writeFileSync(configPath, JSON.stringify({ workspace, permissions: { write: false } }));
  const disabled = configureWorkspaceWritePath({ configPath, home, unitDirectory });
  assert.equal(disabled.writeEnabled, false);
  assert.equal(fs.existsSync(enabled.dropInPath), false, "removing the local write grant removes its OS write path");
});

test("execution-node uninstall removes only its generated workspace systemd drop-in", () => {
  const uninstall = fs.readFileSync(path.join(root, "packaging/execution-node/uninstall-wsl.sh"), "utf8");
  assert.match(uninstall, /realpath -e -- "\$HOME"/);
  assert.match(uninstall, /realpath -m -- "\$PREFIX"/);
  assert.match(uninstall, /\[\[ "\$PREFIX" != "\$REAL_HOME\/"\* \|\| "\$\{PREFIX##\*\/\}" != "sidekick-execution-node" \]\]/);
  assert.match(uninstall, /\[\[ -L "\$PREFIX" \]\]/);
  assert.match(uninstall, /DROP_IN_DIR=.*sidekick-execution-node\.service\.d/);
  assert.match(uninstall, /\[\[ -d "\$DROP_IN_DIR" && ! -L "\$DROP_IN_DIR" \]\]/);
  assert.match(uninstall, /rm -f -- "\$DROP_IN_DIR\/workspace\.conf"/);
  assert.match(uninstall, /rmdir -- "\$DROP_IN_DIR"/);
});
