"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { normalizeManagedService, ALLOWED_SERVICE_NAMES } = require("../../src/tools/families/process-mgmt");

const root = path.join(__dirname, "../..");
const ruleTemplate = fs.readFileSync(path.join(root, "systemd/sidekick-polkit.rules"), "utf8");
const ruleSource = ruleTemplate.replaceAll("@SIDEKICK_USER@", "sidekick");

function evaluateRule({ id, unit, verb, user = "sidekick" }) {
  let registered;
  const polkit = {
    Result: { YES: "yes" },
    addRule(rule) { registered = rule; }
  };
  vm.runInNewContext(ruleSource, { polkit });
  assert.equal(typeof registered, "function", "rule registers with polkit");
  return registered(
    { id, lookup(key) { return key === "unit" ? unit : key === "verb" ? verb : undefined; } },
    { user }
  );
}

test("polkit authorizes only scoped Sidekick systemd unit state operations", () => {
  for (const unit of ["sidekick-mcp.service", "sidekick-metrics.timer", "nginx.service"]) {
    for (const verb of ["start", "stop", "restart", "reload"]) {
      assert.equal(evaluateRule({ id: "org.freedesktop.systemd1.manage-units", unit, verb }), "yes");
    }
  }
});

test("polkit denies other identities, units, verbs, and systemd privilege classes", () => {
  const manageUnits = "org.freedesktop.systemd1.manage-units";
  assert.equal(evaluateRule({ id: manageUnits, unit: "sshd.service", verb: "restart" }), undefined);
  assert.equal(evaluateRule({ id: manageUnits, unit: "sidekick-mcp.service", verb: "kill" }), undefined);
  assert.equal(evaluateRule({ id: manageUnits, unit: "sidekick-mcp.service", verb: "restart", user: "other" }), undefined);
  assert.equal(evaluateRule({ id: "org.freedesktop.systemd1.manage-unit-files", unit: "sidekick-mcp.service", verb: "enable" }), undefined);
  assert.equal(evaluateRule({ id: "org.freedesktop.systemd1.reload-daemon", unit: null, verb: null }), undefined);
});

test("application service targets match the narrow host policy", () => {
  assert.equal(normalizeManagedService("sidekick-mcp"), "sidekick-mcp");
  assert.equal(normalizeManagedService("nginx.service"), "nginx");
  assert.equal(normalizeManagedService("sidekick-metrics.timer"), "sidekick-metrics.timer");
  assert.equal(normalizeManagedService("sshd"), null);
  assert.equal(normalizeManagedService("--user"), null);
  assert.equal(normalizeManagedService("sidekick-mcp.service.service"), null);
  assert.equal(normalizeManagedService(null), null);
});

test("application allowlist exactly matches the Polkit unit allowlist", () => {
  const unitsLiteral = ruleSource.match(/var units = (\[[\s\S]*?\]);/);
  assert.ok(unitsLiteral, "Polkit rule exposes a static unit allowlist");
  const polkitUnits = Array.from(vm.runInNewContext(unitsLiteral[1]));
  const applicationUnits = ALLOWED_SERVICE_NAMES.map(name =>
    name.endsWith(".timer") ? name : `${name}.service`
  );
  assert.deepEqual(polkitUnits, applicationUnits);
});

test("bootstrap installs polkit and the rule without putting unit control in sudoers", () => {
  const bootstrap = fs.readFileSync(path.join(root, "scripts/bootstrap.sh"), "utf8");
  const setupTools = fs.readFileSync(path.join(root, "scripts/setup-tools.sh"), "utf8");
  const existingHostInstaller = fs.readFileSync(path.join(root, "scripts/install-polkit-policy.sh"), "utf8");
  const sudoers = fs.readFileSync(path.join(root, "systemd/sidekick-sudoers"), "utf8");
  const installer = fs.readFileSync(path.join(root, "scripts/lib/polkit.sh"), "utf8");

  for (const script of [bootstrap, setupTools]) {
    assert.match(script, /apt-get install[^\n]*polkitd/);
    assert.match(script, /install_sidekick_polkit_rule "\$USERNAME" "\$SCRIPT_DIR"/);
  }
  assert.match(existingHostInstaller, /sudo bash \.\/scripts\/install-polkit-policy\.sh/);
  assert.match(existingHostInstaller, /EUID/);
  assert.match(existingHostInstaller, /apt-get install -y polkitd/);
  assert.match(existingHostInstaller, /install_sidekick_polkit_rule "\$USERNAME" "\$SCRIPT_DIR"/);
  assert.match(existingHostInstaller, /running systemd host is required/);
  assert.match(installer, /mktemp/);
  assert.match(installer, /chown root:root/);
  assert.doesNotMatch(sudoers, /systemctl\s+(?:start|stop|restart|reload|status)\s/);
});
