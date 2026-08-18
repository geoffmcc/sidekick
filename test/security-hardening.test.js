"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { validateInfluxUrl } = require("../src/influx-endpoint-policy");

console.log("Running focused security-hardening tests...");

assert.strictEqual(validateInfluxUrl("http://localhost:8086").hostname, "localhost");
assert.strictEqual(validateInfluxUrl("http://sidekick-influxdb:8086").hostname, "sidekick-influxdb");
assert.throws(
  () => validateInfluxUrl("https://example.invalid:8086"),
  /not in SIDEKICK_INFLUX_ALLOWED_HOSTS/
);
assert.strictEqual(
  validateInfluxUrl("https://metrics.example.test:8086", { allowedHosts: "metrics.example.test" }).hostname,
  "metrics.example.test"
);
assert.throws(() => validateInfluxUrl("file:///tmp/influx"), /must use http or https/);

const collector = fs.readFileSync(path.join(__dirname, "..", "scripts", "collect-metrics.js"), "utf8");
assert.doesNotMatch(collector, /execSync\s*\(/, "metrics collection must not execute shell pipelines");
assert.match(collector, /execFileSync\(\s*['"]df['"]/, "disk collection should use an argument-bounded execFile call");

const ci = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
assert.match(ci, /npm audit --omit=dev --audit-level=moderate/);

console.log("Focused security-hardening tests passed.");
