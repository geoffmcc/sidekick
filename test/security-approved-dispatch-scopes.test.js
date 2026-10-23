"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-approved-scope-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "strict";
process.env.SIDEKICK_APPROVAL_REQUIRED_TOOLS = "secret";
process.env.SIDEKICK_APPROVAL_EXEMPT_TOOLS = "";
process.env.SIDEKICK_SECRET_KEY = "synthetic-approved-scope-test-key";
delete process.env.SIDEKICK_SECRET_DIR;

const dbStore = require("../src/db");
dbStore.runPendingMigrations();
const identity = require("../src/core/identity");
const tools = require("../src/tools");

test("standalone approved dispatch keeps the reviewer's credential scope at canonical authorization", async t => {
  t.after(() => {
    dbStore.getDb().close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const owner = identity.bootstrapOwner({
    username: "scope_reviewer",
    password: "synthetic scope reviewer test password",
  });

  const queued = await tools.callDashboardTool("secret", { action: "list" }, {
    authIdentity: {
      principal_id: owner.principal_id,
      principal_type: "human",
      scopes: ["secrets.read_metadata"],
    },
  });
  assert.equal(queued.code, "approval_required");
  assert.ok(queued.approvalId);

  const approved = await tools.resolveApproval(queued.approvalId, "approve", owner.principal_id, {
    reviewerPrincipalId: owner.principal_id,
    reviewerAuthIdentity: {
      principal_id: owner.principal_id,
      principal_type: "human",
      scopes: ["approvals.grant"],
    },
  });
  assert.equal(approved.isError, true);
  assert.equal(approved.code, "authorization_denied");
  assert.match(approved.content?.[0]?.text || "", /Authorization denied/);
});
