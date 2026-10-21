"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const priorEnv = Object.fromEntries([
  "NODE_ENV", "SIDEKICK_DATA_DIR", "SIDEKICK_DB_FILE", "SIDEKICK_TOOL_POLICY",
  "SIDEKICK_APPROVAL_MODE", "SIDEKICK_SECRET_KEY",
].map(name => [name, process.env[name]]));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-pack-approval-binding-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_SECRET_KEY = "synthetic-pack-approval-binding-key";

const db = require("../src/db");
const packs = require("../src/packs/lifecycle");
const repository = require("../src/packs/repository");
const identity = require("../src/core/identity");
const dispatcher = require("../src/tools/dispatcher");
const toolContext = require("../src/tools/context");
const { sidekick_capability } = require("../src/tools/families/capability-packs");
const { registerCapabilityRoutes } = require("../src/dashboard/capability-routes");
const { argsDigest } = require("../src/approvals/keys");

db.runPendingMigrations();
const owner = identity.bootstrapOwner({ username: "pack_approval_owner", password: "a sufficiently long owner password" });
const source = path.join(dataDir, "source-pack");
fs.cpSync(path.join(__dirname, "fixtures", "third-party-pack"), source, { recursive: true });

function dispatchCapability(args) {
  return dispatcher.callAgentTool("capability", args, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human" },
  });
}

after(() => {
  try { db.closeDatabase(); } catch {}
  for (const [name, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test("third-party pack install requires and checks the inspected hash before writing", async () => {
  const reviewed = packs.inspect(source);
  assert.equal(reviewed.installable, true, reviewed.problems.join("; "));

  const direct = await toolContext.runWithContext(
    toolContext.createAgentExecutionContext({ authIdentity: { principal_id: owner.principal_id, principal_type: "human" } }),
    () => sidekick_capability({ action: "install", path: source }),
  );
  assert.equal(direct.isError, true);
  assert.equal(direct.code, "canonical_dispatch_required", "direct lifecycle calls must not bypass dispatch authorization");

  const missing = await dispatchCapability({ action: "install", path: source });
  assert.equal(missing.isError, true);
  assert.equal(payload(missing).code, "package_hash_required");
  assert.equal(repository.getPack(reviewed.name), null, "missing approval binding must have no install side effect");

  const entry = path.join(source, "modules", "observatory-tools", "entry.js");
  fs.appendFileSync(entry, "\n// synthetic package changed after inspection\n");
  const changed = packs.inspect(source);
  assert.notEqual(changed.package_hash, reviewed.package_hash);
  assert.notEqual(
    argsDigest({ action: "install", path: source, expected_package_hash: reviewed.package_hash }),
    argsDigest({ action: "install", path: source, expected_package_hash: changed.package_hash }),
    "the approved arguments must identify package contents, not only the mutable path"
  );

  const staleApproval = await dispatchCapability({
    action: "install", path: source, expected_package_hash: reviewed.package_hash,
  });
  assert.equal(staleApproval.isError, true);
  assert.equal(payload(staleApproval).code, "package_hash_mismatch");
  assert.equal(repository.getPack(reviewed.name), null, "changed package must be refused before install side effects");

  const accepted = await dispatchCapability({
    action: "install", path: source, expected_package_hash: changed.package_hash,
  });
  assert.equal(accepted.isError, undefined, accepted.content?.[0]?.text);
  assert.equal(repository.getPack(reviewed.name).package_hash, changed.package_hash);

  const candidate = path.join(dataDir, "upgrade-candidate");
  fs.cpSync(source, candidate, { recursive: true });
  const manifestPath = path.join(candidate, "sidekick.pack.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = "2.0.0";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const reviewedUpgrade = packs.inspect(candidate, { replacingPack: reviewed.name });
  fs.appendFileSync(path.join(candidate, "modules", "observatory-tools", "entry.js"), "\n// changed after upgrade review\n");
  const staleUpgrade = await dispatchCapability({
    action: "upgrade", name: reviewed.name, path: candidate,
    expected_package_hash: reviewedUpgrade.package_hash,
  });
  assert.equal(staleUpgrade.isError, true);
  assert.equal(payload(staleUpgrade).code, "package_hash_mismatch");
  assert.equal(repository.getPack(reviewed.name).version, "1.0.0", "changed upgrade candidate must not replace the installed pack");
});

test("server-local pack upgrades expose the same content-bound approval argument", () => {
  const descriptor = require("../src/tools/families/capability-packs").descriptors[0];
  const expected = descriptor.schema.shape.expected_package_hash;
  assert.ok(expected, "capability schema must carry the package hash through dispatcher approval");
  assert.equal(expected.safeParse("a".repeat(64)).success, true);
  assert.equal(expected.safeParse("mutable-path-only").success, false);
});

test("Dashboard install and upgrade adapters preserve the inspected package hash", async () => {
  const handlers = new Map();
  const forwarded = [];
  registerCapabilityRoutes({
    app: {
      get: (route, handler) => handlers.set(`GET ${route}`, handler),
      post: (route, handler) => handlers.set(`POST ${route}`, handler),
    },
    capabilityAction: async (_req, res, args) => {
      forwarded.push(args);
      res.status(200).json({ ok: true });
    },
    capabilityResult() {},
    callDashboardTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
    dashboardExecutionMetadata: () => ({}),
    authenticatedUser: () => "synthetic-operator",
    logError() {},
    errorResponse() {},
  });

  const expectedPackageHash = "b".repeat(64);
  const response = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  await handlers.get("POST /api/capabilities/install")(
    { body: { path: source, expected_package_hash: expectedPackageHash } }, response()
  );
  await handlers.get("POST /api/capabilities/:name/upgrade")(
    { params: { name: "fixture-observatory" }, body: { path: source, expected_package_hash: expectedPackageHash } }, response()
  );

  assert.equal(forwarded[0].expected_package_hash, expectedPackageHash);
  assert.equal(forwarded[1].expected_package_hash, expectedPackageHash);
});
