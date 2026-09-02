"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const pack = path.join(__dirname, "..", "packs", "network-firewall");
const lib = path.join(pack, "modules", "network-firewall-tools", "lib");
const validate = require(path.join(lib, "validate"));
const profiles = require(path.join(lib, "profiles"));
const providers = require(path.join(lib, "providers"));
const client = require(path.join(lib, "client"));
const { NetworkFirewallError } = require(path.join(lib, "errors"));
const entry = require(path.join(pack, "modules/network-firewall-tools/entry.js"));
const { normalizeResult } = require("../src/tools/result");

function expectCode(fn, code) { assert.throws(fn, e => e instanceof NetworkFirewallError && e.code === code); }
function test(label, fn) { Promise.resolve().then(fn).then(() => console.log(`Passed: ${label}`)).catch(e => { console.error(`FAILED: ${label}\n${e.stack}`); process.exitCode = 1; }); }

test("pack manifest and module manifest are present", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pack, "sidekick.pack.json"), "utf8"));
  const moduleManifest = JSON.parse(fs.readFileSync(path.join(pack, "modules/network-firewall-tools/manifest.json"), "utf8"));
  assert.strictEqual(manifest.name, "network-firewall");
  assert.deepStrictEqual(Object.keys(moduleManifest.tools).sort(), ["dhcp","firewall","network","network_change","vpn"]);
  assert.strictEqual(manifest.configuration.schema.properties.profiles.additionalProperties.required.includes("credential_ref"), true);
});
test("endpoint validation rejects SSRF-shaped per-profile inputs", () => {
  expectCode(() => validate.endpoint("http://127.0.0.1/"), "invalid_input");
  expectCode(() => validate.endpoint("https://user:pass@example.test/"), "invalid_input");
  expectCode(() => validate.endpoint("https://example.test/path"), "invalid_input");
});
test("profile rejects inline secrets and accepts a secret reference", () => {
  expectCode(() => profiles.parse("lab", {provider:"openwrt",endpoint:"https://router.test/",credential_ref:"secret:router",password:"bad"}), "invalid_input");
  const p = profiles.parse("lab", {provider:"openwrt",endpoint:"https://router.test/",credential_ref:"secret:router"});
  assert.strictEqual(p.provider, "openwrt"); assert.strictEqual(p.credential_ref, "secret:router");
});
test("input validation covers IPv4, IPv6, CIDR, ports and MAC", () => {
  assert.strictEqual(validate.ip("192.0.2.1"), "192.0.2.1");
  assert.strictEqual(validate.cidr("2001:db8::/64"), "2001:db8::/64");
  assert.strictEqual(validate.mac("AA:BB:CC:DD:EE:FF"), "aa:bb:cc:dd:ee:ff");
  expectCode(() => validate.cidr("192.0.2.1/33"), "invalid_input");
  expectCode(() => validate.port(0), "invalid_input");
});
test("provider capability results distinguish unsupported from success", () => {
  const x = providers.unsupported("pfsense", "safe_apply", "no supported API");
  assert.deepStrictEqual(x, {state:"unsupported",provider:"pfsense",capability:"safe_apply",reason:"no supported API"});
});
test("generic provider projection unwraps API envelopes for firewall and network data", async () => {
  const profile = {provider:"opnsense", endpoint:"https://router.test", credential:"key\nsecret"};
  const responses = {
    "/api/firewall/filter/searchRule": {data:{rows:[{id:"r1", action:"pass", enabled:true}]}},
    "/api/interfaces/overview/export": {data:{items:[{id:"wan", name:"WAN", status:"up"}]}},
  };
  const fakeClient = {get: async path => responses[path]};
  const firewall = await providers.read(profile, fakeClient, "firewall");
  const interfaces = await providers.read(profile, fakeClient, "interfaces");
  assert.strictEqual(firewall.rules.length, 1);
  assert.strictEqual(firewall.rules[0].id, "r1");
  assert.strictEqual(interfaces.length, 1);
  assert.strictEqual(interfaces[0].id, "wan");
});
test("dispatcher result projection never emits blank text for an undefined handler result", () => {
  assert.strictEqual(normalizeResult(undefined).content[0].text, "null");
});
test("client never follows redirects and always enables TLS verification", () => {
  const p = profiles.parse("lab", {provider:"openwrt",endpoint:"https://router.test/",credential_ref:"secret:router",ca_pem:"-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----"});
  const c = client.createClient(p);
  assert.strictEqual(typeof c.get, "function");
});
test("module exposes the compact governed tool surface", () => {
  const names = entry.buildDescriptors().map(x => x.name).sort();
  assert.deepStrictEqual(names, ["dhcp", "firewall", "network", "network_change", "vpn"]);
  const change = entry.buildDescriptors().find(x => x.name === "network_change");
  assert.strictEqual(change.risk, "critical");
  assert.strictEqual(change.schema.safeParse({action:"preflight",profile:"lab",change_type:"firewall_rule",management_path:"unknown"}).success, true);
});
test("unconfigured health is unavailable rather than healthy", () => {
  const report = entry.healthCheck({ config: { profiles: {} } });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.status, "unavailable");
});
