const assert = require("assert");
const { CONFIG, listConfigDefinitions, validateConfig } = require("../src/config/registry");

assert.ok(CONFIG.length >= 10);
assert.ok(listConfigDefinitions({ safeOnly: true }).every(entry => entry.expose === true));
assert.ok(!listConfigDefinitions({ safeOnly: true }).some(entry => entry.type === "secret_reference"));
assert.strictEqual(validateConfig({ SIDEKICK_DASHBOARD_PORT: "4098", SIDEKICK_TOOL_POLICY: "restricted" }).ok, true);
assert.strictEqual(validateConfig({ SIDEKICK_DASHBOARD_PORT: "99999" }).ok, false);
assert.strictEqual(validateConfig({ SIDEKICK_TOOL_POLICY: "unsafe" }).ok, false);
console.log("Configuration registry checks passed");
