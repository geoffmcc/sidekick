"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveOutboundUrl } = require("../src/security/outbound-url");
const { sidekick_network_scopes } = require("../src/tools/families/network-scopes");
const { connectionFailure } = require("../src/tools/families/net-fetch");
const { githubCredentialMissing } = require("../src/tools/families/github");

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test("operator identity is distinguished from user consent for network-scope mutation", async () => {
  const result = await sidekick_network_scopes({ action: "create", name: "fixture" }, { context: { source: "agent", authIdentity: null } });
  assert.equal(result.code, "operator_authentication_required");
  assert.equal(payload(result).code, "operator_authentication_required");
  assert.match(payload(result).error, /authenticated operator principal/);
  assert.match(payload(result).error, /consent or approval alone/);
});

test("private outbound access reports the missing named scope without implying user consent grants it", async () => {
  const result = await resolveOutboundUrl("http://127.0.0.1/fixture", "url");
  assert.equal(result.code, "network_scope_required");
  assert.match(result.refusal, /network scope/i);
});

test("credential absence and service reachability produce distinct actionable error codes", () => {
  const credential = githubCredentialMissing();
  assert.equal(credential.code, "github_credential_missing");
  assert.match(payload(credential).guidance, /protected/);
  assert.ok(!JSON.stringify(credential).includes("secret:"));

  const refused = connectionFailure({ code: "ECONNREFUSED" });
  assert.equal(refused.code, "service_unreachable");
  assert.match(refused.guidance, /does not establish.*firewall/i);
  assert.equal(connectionFailure({ code: "ENOTFOUND" }).code, "dns_resolution_failed");
});
