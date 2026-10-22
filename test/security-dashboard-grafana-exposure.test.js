"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Grafana auth proxy is published only on host loopback", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "docker", "docker-compose.yml"), "utf8");
  const grafana = (compose.match(/^  grafana:\n(?:^(?:    .*|)\n)*/m) || [""])[0];
  assert.ok(grafana, "Grafana Compose service exists");
  assert.match(grafana, /^\s*- "127\.0\.0\.1:3000:3000"\s*$/m);
  assert.doesNotMatch(grafana, /^\s*- "0\.0\.0\.0:3000:3000"\s*$/m);
  assert.match(grafana, /GF_AUTH_PROXY_ENABLED:\s*"true"/);
  assert.match(grafana, /GF_AUTH_PROXY_HEADER_NAME:\s*"X-WEBAUTH-USER"/);
});
