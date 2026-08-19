"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-phase-09-dashboard-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DASHBOARD_PORT = "4112";
process.env.SIDEKICK_DASHBOARD_USER = "phase9-user";
process.env.SIDEKICK_DASHBOARD_PASS = "phase9-pass";
process.env.SIDEKICK_API_KEY = "phase9-api-key";
process.env.SIDEKICK_DASHBOARD_TRUST_PROXY = "false";
process.env.SIDEKICK_TOOL_POLICY = "restricted";
process.env.SIDEKICK_APPROVAL_MODE = "strict";

process.on("exit", () => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: 4112,
      path: pathname,
      method: "GET",
      headers,
    }, res => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end();
  });
}

require("../src/dashboard");

(async () => {
  const auth = "Basic " + Buffer.from("phase9-user:phase9-pass").toString("base64");
  const response = await request("/api/services", {
    Authorization: auth,
    // Must not be trusted unless SIDEKICK_DASHBOARD_TRUST_PROXY is enabled.
    "X-Forwarded-Proto": "https",
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers["x-powered-by"], undefined);
  assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
  assert.strictEqual(response.headers["referrer-policy"], "no-referrer");
  assert.match(response.headers["permissions-policy"], /camera=\(\)/);
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
  assert.strictEqual(response.headers["cache-control"], "no-store");
  assert.ok(!String(response.headers["set-cookie"] || "").includes("; Secure"), "untrusted forwarded proto must not mark an HTTP cookie Secure");

  console.log("Phase 9 dashboard and web security tests passed");
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
