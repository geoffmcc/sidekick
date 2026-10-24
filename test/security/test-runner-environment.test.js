"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { executeSuite } = require("../../test/suite-runner");
const { ownedTempRoot, withEnv } = require("../../test/helpers/isolated");

test("test suite subprocesses receive fixture scope but not ambient credentials or loader hooks", async () => {
  await withEnv({
    GITHUB_TOKEN: "synthetic-github-token",
    SIDEKICK_TEST_INHERITED_API_KEY: "synthetic-api-key",
    LD_AUDIT: "synthetic-loader-audit",
    NODE_PATH: path.join(os.tmpdir(), "synthetic-module-path"),
  }, async () => {
    const directory = await ownedTempRoot("sidekick-child-env-");
    try {
      const testFile = path.join(directory.path, "child.test.js");
      fs.writeFileSync(testFile, `
    const test = require("node:test");
    test("inspect inherited environment", () => {
      console.log("RESULT:" + JSON.stringify({
        token: process.env.GITHUB_TOKEN,
        apiKey: process.env.SIDEKICK_TEST_INHERITED_API_KEY,
        audit: process.env.LD_AUDIT,
        nodePath: process.env.NODE_PATH,
        fixture: process.env.SIDEKICK_TEST_SUITE_ID,
      }));
    });
  `);

      const suite = {
        file: "child.test.js",
        id: "security:child-env-fixture",
        resources: ["environment"],
        contracts: {
          environment: {
            kind: "isolated", provisioner: "environment-scope", fixture: "process-environment",
            cleanup: "no-op", cleanup_owner: "suite", lock_identity: "child-env-fixture",
            supported_platforms: ["linux", "win32", "darwin"],
          },
        },
        suite_contract: { supported_platforms: ["linux", "win32", "darwin"] },
        timeout_ms: 10000,
      };

      const result = await executeSuite(suite, { cwd: directory.path, maxOutputChars: 2000 });
      assert.equal(result.status, "passed", result.error || result.stderr);
      const observed = JSON.parse(result.stdout.match(/RESULT:(\{.*\})/)?.[1]);
      assert.equal(observed.token, undefined);
      assert.equal(observed.apiKey, undefined);
      assert.equal(observed.audit, undefined);
      assert.equal(observed.nodePath, undefined);
      assert.equal(observed.fixture, suite.id);
    } finally {
      await directory.cleanup();
    }
  });
});
