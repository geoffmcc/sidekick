"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-project-context-"));
process.env.SIDEKICK_DATA_DIR = dataDir;

const db = require("../src/db");
const { TOOLS } = require("../src/tools");
const { createTestExecutionContext, runWithContext } = require("../src/tools/context");

async function main() {
  try {
    db.runPendingMigrations();
    db.appendToolLog({ n: "project", project: "Other-Project", ok: true, s: "foreign activity" });
    db.appendToolLog({ n: "project", project: "Target_Project", ok: true, s: "target activity" });

    const result = await TOOLS.project({ name: "target-project", include: "logs" });
    assert.strictEqual(result.isError, undefined);
    const output = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(output.logs.map(log => log.summary), ["target activity"]);

    const denied = await runWithContext(
      createTestExecutionContext({ project: "target_project" }),
      () => TOOLS.project({ name: "other-project", include: "logs" }),
    );
    assert.strictEqual(denied.isError, true);
    assert.strictEqual(denied.content[0].text, "memory project scope denied");
    console.log("Project context isolation tests passed");
  } finally {
    try { db.closeDatabase(); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
