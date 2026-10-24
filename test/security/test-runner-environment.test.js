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
    SIDEKICK_PROPERTY_SEED: "700001",
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
        propertySeed: process.env.SIDEKICK_PROPERTY_SEED,
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
      assert.equal(observed.propertySeed, "700001");
      assert.equal(observed.audit, undefined);
      assert.equal(observed.nodePath, undefined);
      assert.equal(observed.fixture, suite.id);
    } finally {
      await directory.cleanup();
    }
  });
});

test("browser suite subprocesses receive only the provisioned browser runtime path", async () => {
  const directory = await ownedTempRoot("sidekick-browser-runtime-env-");
  try {
    const runtimePath = path.join(directory.path, "managed-browser-runtime");
    fs.mkdirSync(runtimePath);
    const testFile = path.join(directory.path, "browser-child.test.js");
    fs.writeFileSync(testFile, `
    const test = require("node:test");
    test("inspect browser resource environment", () => {
      console.log("RESULT:" + JSON.stringify({
        runtime: process.env.SIDEKICK_BROWSER_BROWSERS_PATH,
        profile: process.env.SIDEKICK_TEST_BROWSER_ROOT,
        token: process.env.GITHUB_TOKEN,
      }));
    });
  `);
    await withEnv({
      SIDEKICK_BROWSER_BROWSERS_PATH: runtimePath,
      GITHUB_TOKEN: "synthetic-browser-test-token",
    }, async () => {
      const suite = {
        file: "browser-child.test.js",
        id: "security:browser-runtime-env-fixture",
        resources: ["browser"],
        contracts: {
          browser: {
            kind: "shared", provisioner: "browser-profile", fixture: "browser-profile",
            cleanup: "owned-temp-tree", cleanup_owner: "runner", lock_identity: "browser-env-fixture",
            supported_platforms: ["linux", "win32", "darwin"],
          },
        },
        suite_contract: { supported_platforms: ["linux", "win32", "darwin"] },
        timeout_ms: 10000,
      };
      const result = await executeSuite(suite, { cwd: directory.path, maxOutputChars: 2000 });
      assert.equal(result.status, "passed", result.error || result.stderr);
      const observed = JSON.parse(result.stdout.match(/RESULT:(\{.*\})/)?.[1]);
      assert.equal(observed.runtime, path.resolve(runtimePath));
      assert.notEqual(observed.profile, runtimePath, "the disposable browser profile must remain separate from installed binaries");
      assert.equal(observed.token, undefined, "ambient credentials remain scrubbed");
    });
  } finally {
    await directory.cleanup();
  }
});
