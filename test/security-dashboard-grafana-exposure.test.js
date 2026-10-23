"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

test("Grafana uses private Basic Auth instead of trusting caller identity headers", () => {
  const composePath = path.join(__dirname, "..", "docker", "docker-compose.yml");
  const compose = YAML.parse(fs.readFileSync(composePath, "utf8"));
  const grafana = compose.services.grafana;
  assert.deepEqual(grafana.ports, ["127.0.0.1:3000:3000"]);
  assert.equal(grafana.environment.GF_AUTH_BASIC_ENABLED, "true");
  assert.equal(grafana.environment.GF_SECURITY_ADMIN_USER, "${SIDEKICK_GRAFANA_ADMIN_USER:-sidekick}");
  assert.equal(grafana.environment.GF_SECURITY_ADMIN_PASSWORD__FILE, "/run/secrets/sidekick_grafana_admin_password");
  assert.notEqual(grafana.environment.GF_AUTH_PROXY_ENABLED, "true");
});
