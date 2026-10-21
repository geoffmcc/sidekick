const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-sandbox-isolation-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const owner = identity.bootstrapOwner({ username: "sandbox_isolation_owner", password: "a sufficiently long owner password" });
const dispatcher = require("../src/tools/dispatcher");
const toolContext = require("../src/tools/context");
const { sidekick_sandbox } = require("../src/tools/families/security");
const sandboxDir = path.join(dataDir, "sandboxes");

test("sandbox exec fails closed before command, backup, or persistence side effects", async () => {
  const target = path.join(dataDir, "must-not-be-backed-up.txt");
  const marker = path.join(dataDir, "command-must-not-run.txt");
  fs.writeFileSync(target, "keep this content");
  const command = process.platform === "win32"
    ? `echo ran > "${marker}"`
    : `echo ran > '${marker}'`;

  const direct = await toolContext.runWithContext(
    toolContext.createAgentExecutionContext({ authIdentity: { principal_id: owner.principal_id, principal_type: "human" } }),
    () => sidekick_sandbox({ action: "rollback", sandbox_name: "direct-call-must-not-run" }),
  );
  assert.equal(direct.isError, true);
  assert.equal(direct.code, "canonical_dispatch_required", "direct rollback must fail before loading or mutating sandbox state");

  const result = await dispatcher.callAgentTool("sandbox", {
    action: "exec",
    sandbox_name: "blocked-execution-test",
    command,
    files: [target],
    auto_backup: true,
  }, { authIdentity: { principal_id: owner.principal_id, principal_type: "human" } });

  assert.equal(result.isError, true);
  assert.equal(result.code, "isolation_unavailable");
  assert.equal(result.status, "unavailable");
  assert.match(result.content[0].text, /no OS-enforced isolation backend is configured/);
  assert.equal(fs.readFileSync(target, "utf8"), "keep this content");
  assert.equal(fs.existsSync(marker), false, "the host command did not run");
  assert.equal(fs.existsSync(path.join(dataDir, "sandbox.json")), false, "sandbox metadata was not written");
  assert.deepEqual(fs.readdirSync(sandboxDir), [], "no file backup was created");

  const source = fs.readFileSync(path.join(__dirname, "../src/tools/families/security.js"), "utf8");
  assert.doesNotMatch(source, /runBoundedShell/, "the sandbox family contains no latent host-shell execution path");
});

test.after(() => {
  try { db.closeDatabase(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});
