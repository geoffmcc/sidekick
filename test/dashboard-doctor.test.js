"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-dashboard-doctor-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DASHBOARD_PORT = "4102";
process.env.SIDEKICK_DASHBOARD_USER = "test-user";
process.env.SIDEKICK_DASHBOARD_PASS = "test-pass";
process.env.SIDEKICK_API_KEY = "test-sidekick-api-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

process.on("exit", () => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});

function request(urlPath, authenticated = true) {
  return new Promise((resolve, reject) => {
    const headers = authenticated ? {
      Authorization: "Basic " + Buffer.from("test-user:test-pass").toString("base64"),
    } : {};
    const req = http.request({ hostname: "127.0.0.1", port: 4102, path: urlPath, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

require("../src/dashboard");

(async () => {
  await new Promise(resolve => setTimeout(resolve, 250));

  const unauthenticated = await request("/api/doctor", false);
  assert.strictEqual(unauthenticated.status, 401, "Doctor must require dashboard authentication");

  const json = await request("/api/doctor?format=json");
  assert.strictEqual(json.status, 200);
  const bundle = JSON.parse(json.body);
  assert.strictEqual(bundle.format, "sidekick-support-v1");
  assert.ok(bundle.doctor && typeof bundle.doctor.ok === "boolean");
  assert.ok(bundle.doctor.checks.length <= 100, "Doctor checks must remain bounded");
  assert.match(bundle.note, /credentials.*excluded/i);
  assert.ok(!json.body.includes("test-sidekick-api-key"), "Doctor response must not expose credentials");
  assert.strictEqual(json.headers["cache-control"], "no-store");

  const text = await request("/api/doctor?format=text");
  assert.strictEqual(text.status, 200);
  assert.match(text.headers["content-type"], /^text\/plain/);
  assert.match(text.body, /^Sidekick Doctor: /);
  assert.ok(text.body.length <= 4000, "Text diagnostics must remain bounded");

  const invalid = await request("/api/doctor?format=xml");
  assert.strictEqual(invalid.status, 400);
  assert.match(invalid.body, /invalid_format/);

  const post = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: 4102, path: "/api/doctor", method: "POST",
      headers: { Authorization: "Basic " + Buffer.from("test-user:test-pass").toString("base64") },
    }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end();
  });
  assert.strictEqual(post, 404, "Doctor must not expose a POST mutation surface");

  console.log("Dashboard Doctor API tests passed");
  process.exit(0);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
