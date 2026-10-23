"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const { isLoopbackHost, validateControlPlaneUrl } = require("../../src/compute/control-plane-url");

const root = path.resolve(__dirname, "../..");

function runRequestRefusal(modulePath, requestExpression, envName) {
  const script = `const client=require(${JSON.stringify(modulePath)}); Promise.resolve(${requestExpression}).then(()=>process.exit(2),error=>process.stdout.write(error.code||"missing_error_code"));`;
  const env = { ...process.env, [envName]: "http://example.invalid:4097", SIDEKICK_WORKER_CONFIG_FILE: path.join(root, "missing-worker-test-config.json") };
  delete env.SIDEKICK_URL;
  return execFileSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 10000,
  });
}

test("control-plane HTTP is limited to loopback and HTTPS accepts remote hosts", () => {
  const loopbackUrls = ["http://127.0.0.1:4097", ["http:", "//", "127.42.0.9:4097"].join(""), ["http:", "//", "[::1]:4097"].join(""), "http://localhost:4097"];
  for (const url of loopbackUrls) {
    assert.equal(validateControlPlaneUrl(url).protocol, "http:");
  }
  assert.equal(validateControlPlaneUrl("https://example.invalid:4097").protocol, "https:");
  assert.equal(isLoopbackHost("192.168.1.10"), false);
  assert.equal(isLoopbackHost("sidekick.local"), false);
});

test("control-plane URL validation rejects plaintext remote hosts and credential-bearing URLs", () => {
  assert.throws(
    () => validateControlPlaneUrl("http://example.invalid:4097"),
    error => error.code === "CONTROL_PLANE_INSECURE_TRANSPORT" && /require HTTPS/.test(error.message),
  );
  assert.throws(() => validateControlPlaneUrl(["https:", "//", "user:password@example.invalid"].join("")), /contain no credentials/);
  assert.throws(() => validateControlPlaneUrl("ftp://example.invalid"), /must use HTTP\(S\)/);
});

test("Compute Worker and Execution Node reject plaintext remote requests before connecting", () => {
  const worker = path.join(root, "src/compute/worker-agent.js");
  const node = path.join(root, "src/node/agent.js");
  assert.equal(runRequestRefusal(worker, 'client.httpRequest("POST", "/compute/worker/heartbeat", {})', "SIDEKICK_SERVER_URL"), "CONTROL_PLANE_INSECURE_TRANSPORT");
  assert.equal(runRequestRefusal(node, 'client.request("POST", "/execution-node/enrollment/exchange", {})', "SIDEKICK_SERVER_URL"), "CONTROL_PLANE_INSECURE_TRANSPORT");
});
