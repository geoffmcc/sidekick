"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { assertWindowsSecretAcl } = require("../../src/core/windows-secret-acl");

const fixtureRoot = process.env.SIDEKICK_TEST_FILESYSTEM_ROOT;
assert.ok(fixtureRoot, "test runner must provide an owned filesystem fixture");

test("Windows secret ACL validation rejects untrusted file reads and directory replacement", t => {
  if (process.platform !== "win32") {
    t.skip("requires NTFS access control lists");
    return;
  }

  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  const whoami = path.join(system32, "whoami.exe");
  const icacls = path.join(system32, "icacls.exe");
  const whoamiEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: system32 };
  const identity = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8", windowsHide: true, env: whoamiEnv,
  }).trim();
  const currentSid = identity.match(/,\s*"(S-1-[0-9-]+)"\s*$/)?.[1];
  assert.ok(currentSid, "whoami must identify the test process token SID");

  const root = path.join(fixtureRoot, "windows-secret-acl");
  const secrets = path.join(root, "secrets");
  const secretPath = path.join(secrets, "sidekick_api_key");
  fs.mkdirSync(secrets, { recursive: true });
  fs.writeFileSync(secretPath, "synthetic-windows-secret\n");

  const icaclsRun = (target, ...args) => execFileSync(icacls, [target, ...args], {
    encoding: "utf8", windowsHide: true, env: whoamiEnv,
  });
  const protect = (target, directory = false) => {
    const inheritance = directory ? "(OI)(CI)" : "";
    icaclsRun(target, "/inheritance:r", "/grant:r",
      `*${currentSid}:${inheritance}F`, `*S-1-5-18:${inheritance}F`, `*S-1-5-32-544:${inheritance}F`);
  };

  protect(root, true);
  protect(secrets, true);
  protect(secretPath);

  assert.doesNotThrow(() => assertWindowsSecretAcl({
    directories: [root, secrets],
    secretDirectory: secrets,
    secretFile: secretPath,
    name: "SIDEKICK_API_KEY",
    force: true,
  }));

  icaclsRun(secretPath, "/grant", "*S-1-5-32-545:R");
  assert.throws(() => assertWindowsSecretAcl({
    directories: [], secretDirectory: null, secretFile: secretPath, name: "SIDEKICK_API_KEY",
    force: true,
  }), /permissions could not be verified against Windows ACLs/);

  protect(secretPath);
  icaclsRun(root, "/grant", "*S-1-5-32-545:(OI)(CI)M");
  assert.throws(() => assertWindowsSecretAcl({
    directories: [root, secrets], secretDirectory: secrets, secretFile: secretPath, name: "SIDEKICK_API_KEY",
    force: true,
  }), /permissions could not be verified against Windows ACLs/);
});
