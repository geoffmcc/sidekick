"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-capability-config-scope-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "synthetic-capability-config-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";

const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const bundled = require("../src/packs/bundled");
const lifecycle = require("../src/packs/lifecycle");
const tools = require("../src/tools");

test("detailed capability reads require scoped identity when they include runtime configuration", async t => {
  t.after(() => {
    db.closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const owner = identity.bootstrapOwner({
    username: "capability_reader",
    password: "synthetic capability reader password",
  });
  const pack = bundled.installBundledPack("proxmox").pack;
  lifecycle.configure(pack.name, {
    profiles: {
      main: {
        endpoint: "https://10.77.88.99:8006",
        token_ref: "secret:synthetic_internal_admin_token",
      },
    },
  });

  const anonymousShow = await tools.callMcpTool("capability", { action: "show", name: pack.name });
  assert.equal(anonymousShow.isError, true);
  assert.equal(anonymousShow.code, "unauthenticated");
  assert.doesNotMatch(anonymousShow.content?.[0]?.text || "", /10\.77\.88\.99|synthetic_internal_admin_token/);

  const anonymousHealth = await tools.callMcpTool("capability", { action: "health", name: pack.name });
  assert.equal(anonymousHealth.isError, true);
  assert.equal(anonymousHealth.code, "unauthenticated");

  const publicCatalog = await tools.callMcpTool("capability", { action: "catalog", limit: 1 });
  assert.equal(publicCatalog.isError, undefined, "non-sensitive catalog discovery remains public");

  const authorizedShow = await tools.callMcpTool("capability", { action: "show", name: pack.name }, {
    authIdentity: { principal_id: owner.principal_id, principal_type: "human", scopes: null },
  });
  assert.equal(authorizedShow.isError, undefined);
  assert.match(authorizedShow.content[0].text, /10\.77\.88\.99/);
  assert.doesNotMatch(authorizedShow.content[0].text, /synthetic_internal_admin_token/);
  assert.match(authorizedShow.content[0].text, /\[REDACTED\]/, "credential references remain redacted even for an authorized reader");
});
