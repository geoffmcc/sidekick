"use strict";

// Connector authority (B7 keystone) tests: the GitHub integration is registered
// as a managed connector in the platform connector authority and the github
// tool routes its endpoint + credential through that connector (secret_ref
// resolved via the encrypted secret store), with env override + secret-store
// fallback preserved for backwards compatibility. The read-only `connector`
// tool never exposes the secret reference. No network required.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-connector-authority");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
process.env.SIDEKICK_SECRET_KEY = "test-master-key";
delete process.env.GITHUB_TOKEN;
delete process.env.SIDEKICK_GITHUB_TOKEN;
delete process.env.SIDEKICK_DISABLE_CONNECTOR_BOOTSTRAP;

delete require.cache[require.resolve("../src/db")];
const kernel = require("../src/platform/kernel");
const { loadSecrets, saveSecrets } = require("../src/core/secrets-store");
const { encryptSecret } = require("../src/core/secret-cipher");
const { bootstrapConnectors } = require("../src/connectors/bootstrap");
const resolve = require("../src/connectors/resolve");
const github = require("../src/tools/families/github");
const { sidekick_connector } = require("../src/tools/families/connectors");

console.log("Running connector authority tests...\n");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

function storeGithubSecret(value) {
  const secrets = loadSecrets();
  secrets["github_token"] = { ...encryptSecret(value), created: "t", updated: "t" };
  saveSecrets(secrets);
}

function resetConnectors() {
  kernel.ensurePlatformKernelSchema();
  const db = require("../src/db").getDb();
  db.exec("DELETE FROM platform_connectors;");
  fs.rmSync(path.join(TEST_DATA_DIR, "secrets.enc"), { force: true });
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// ---- bootstrap --------------------------------------------------------------

test("bootstrap registers an enabled GitHub connector when a token secret exists", () => {
  resetConnectors();
  storeGithubSecret("ghp_secretvalue_1");
  const { seeded } = bootstrapConnectors();
  assert.strictEqual(seeded.length, 1, "one connector seeded");
  const list = kernel.listConnectors({ type: "github" });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].state, "enabled", "connector is live");
  assert.strictEqual(list[0].secret_ref, "secret:github_token");
  assert.ok(String(list[0].endpoint).startsWith("https://api.github.com"));
});

test("bootstrap is idempotent (no duplicate connector)", () => {
  resetConnectors();
  storeGithubSecret("ghp_secretvalue_1");
  bootstrapConnectors();
  bootstrapConnectors();
  bootstrapConnectors();
  assert.strictEqual(kernel.listConnectors({ type: "github" }).length, 1);
});

test("bootstrap seeds nothing when no github credential is present", () => {
  resetConnectors(); // removes secrets.enc
  const { seeded } = bootstrapConnectors();
  assert.strictEqual(seeded.length, 0);
  assert.strictEqual(kernel.listConnectors({ type: "github" }).length, 0);
});

test("SIDEKICK_DISABLE_CONNECTOR_BOOTSTRAP=1 seeds nothing", () => {
  resetConnectors();
  storeGithubSecret("ghp_secretvalue_1");
  process.env.SIDEKICK_DISABLE_CONNECTOR_BOOTSTRAP = "1";
  try {
    assert.strictEqual(bootstrapConnectors().seeded.length, 0);
    assert.strictEqual(kernel.listConnectors({ type: "github" }).length, 0);
  } finally {
    delete process.env.SIDEKICK_DISABLE_CONNECTOR_BOOTSTRAP;
  }
});

// ---- resolution -------------------------------------------------------------

test("resolve finds the active connector and decrypts its secret_ref", () => {
  resetConnectors();
  storeGithubSecret("ghp_resolveme_2");
  bootstrapConnectors();
  const active = resolve.getActiveConnector("github");
  assert.ok(active, "active github connector found");
  assert.strictEqual(resolve.resolveConnectorCredential(active), "ghp_resolveme_2");
});

// ---- github tool routing ----------------------------------------------------

test("github tool routes token + endpoint through the connector", () => {
  resetConnectors();
  storeGithubSecret("ghp_viaconnector_3");
  // Register at a GitHub Enterprise endpoint to prove the tool uses the
  // connector's endpoint, not a hardcoded api.github.com.
  const conn = kernel.registerConnector({
    name: "GHE", type: "github", endpoint: "https://ghe.example.com/api/v3",
    secret_ref: "secret:github_token", metadata: { managed: "connector-bootstrap" },
  });
  kernel.transitionConnector(conn.connector_id, "enabled");
  assert.strictEqual(github.resolveGithubApiBase(), "https://ghe.example.com/api/v3");
  assert.strictEqual(github.resolveGithubToken(), "ghp_viaconnector_3");
});

test("the active connector's secret_ref outranks env GITHUB_TOKEN (connector is the authority)", () => {
  resetConnectors();
  storeGithubSecret("ghp_fromsecret_4");
  bootstrapConnectors();
  process.env.GITHUB_TOKEN = "ghp_fromenv_fallback";
  try {
    assert.strictEqual(github.resolveGithubToken(), "ghp_fromsecret_4");
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("env GITHUB_TOKEN is the fallback when no connector is active", () => {
  resetConnectors(); // removes secrets.enc, no connector registered
  process.env.GITHUB_TOKEN = "ghp_fromenv_fallback2";
  try {
    assert.strictEqual(github.resolveGithubToken(), "ghp_fromenv_fallback2");
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("env GITHUB_TOKEN is used when the active connector's secret_ref cannot resolve", () => {
  resetConnectors(); // no secrets.enc: the connector's secret_ref resolves to null
  const conn = kernel.registerConnector({
    name: "GH-noref", type: "github", endpoint: "https://api.github.com",
    secret_ref: "secret:github_token", metadata: { managed: "connector-bootstrap" },
  });
  kernel.transitionConnector(conn.connector_id, "enabled");
  process.env.GITHUB_TOKEN = "ghp_fromenv_fallback3";
  try {
    assert.strictEqual(github.resolveGithubToken(), "ghp_fromenv_fallback3");
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

// ---- per-call health observability -------------------------------------------

test("githubHealthDecision records only state changes", () => {
  // Auth failure while live -> record degradation.
  assert.deepStrictEqual(github.githubHealthDecision("enabled", 401), { record: true, ok: false, error: "github auth failure (HTTP 401)" });
  assert.deepStrictEqual(github.githubHealthDecision("healthy", 403), { record: true, ok: false, error: "github auth failure (HTTP 403)" });
  // Success promotes enabled -> healthy (a state change) ...
  assert.deepStrictEqual(github.githubHealthDecision("enabled", 200), { record: true, ok: true });
  // ... but steady-state healthy success must NOT write per call.
  assert.deepStrictEqual(github.githubHealthDecision("healthy", 200), { record: false });
  // Non-auth failures and transport errors are not connector-credential evidence.
  assert.deepStrictEqual(github.githubHealthDecision("healthy", 500), { record: false });
  assert.deepStrictEqual(github.githubHealthDecision("healthy", 404), { record: false });
  assert.deepStrictEqual(github.githubHealthDecision("enabled", 0), { record: false });
  // Once errored, repeats record nothing (and the connector is no longer active anyway).
  assert.deepStrictEqual(github.githubHealthDecision("error", 401), { record: false });
});

test("noteGithubResponse degrades the connector on 401 and heals enabled->healthy on success", () => {
  resetConnectors();
  storeGithubSecret("ghp_health_7");
  bootstrapConnectors();
  const before = kernel.listConnectors({ type: "github" })[0];
  assert.strictEqual(before.state, "enabled");

  // Success while enabled -> promoted to healthy (one recorded observation).
  github.noteGithubResponse(200);
  const healthy = kernel.getConnector(before.connector_id);
  assert.strictEqual(healthy.state, "healthy");
  assert.ok(healthy.last_health_check_at, "health check timestamp recorded");

  // Steady-state healthy success records nothing further.
  const stamp = healthy.last_health_check_at;
  github.noteGithubResponse(200);
  assert.strictEqual(kernel.getConnector(before.connector_id).last_health_check_at, stamp);

  // Auth failure while healthy -> degraded to error with the failure recorded.
  github.noteGithubResponse(401);
  const degraded = kernel.getConnector(before.connector_id);
  assert.strictEqual(degraded.state, "error");
  assert.strictEqual(degraded.health.ok, false);
  assert.match(String(degraded.health.error), /auth failure/);

  // Errored connector is no longer active: further responses are no-ops.
  github.noteGithubResponse(401);
  assert.strictEqual(kernel.getConnector(before.connector_id).state, "error");
});

test("with no connector, github falls back to the legacy secret-store key and public API", () => {
  resetConnectors();
  storeGithubSecret("ghp_legacyfallback_5");
  // No bootstrap: no connector registered.
  assert.strictEqual(kernel.listConnectors({ type: "github" }).length, 0);
  assert.strictEqual(github.resolveGithubToken(), "ghp_legacyfallback_5");
  assert.strictEqual(github.resolveGithubApiBase(), "https://api.github.com");
});

// ---- connector tool (read-only, redacted) -----------------------------------

test("connector tool lists connectors without exposing the secret reference", async () => {
  resetConnectors();
  storeGithubSecret("ghp_toolview_6");
  bootstrapConnectors();
  const listed = parse(await sidekick_connector({ action: "list" }));
  assert.ok(Array.isArray(listed.connectors) && listed.connectors.length === 1);
  const c = listed.connectors[0];
  assert.strictEqual(c.type, "github");
  assert.strictEqual(c.has_secret_ref, true, "reports credential is configured");
  assert.ok(!("secret_ref" in c), "raw secret_ref is not exposed");

  const got = parse(await sidekick_connector({ action: "get", connector_id: c.connector_id }));
  assert.strictEqual(got.connector_id, c.connector_id);
  assert.ok(!("secret_ref" in got));

  const events = parse(await sidekick_connector({ action: "events", connector_id: c.connector_id }));
  assert.ok(Array.isArray(events.events) && events.events.some(e => e.event_type === "connector.registered"));
});

test("connector tool rejects get/events without a connector_id and unknown actions", async () => {
  const noId = await sidekick_connector({ action: "get" });
  assert.ok(noId.isError);
  const bad = await sidekick_connector({ action: "frobnicate" });
  assert.ok(bad.isError);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
