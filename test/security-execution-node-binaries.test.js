"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { binaries, commandOnPath, shellIsolationStatus } = require("../src/node/agent");
const { resolveCommandOnPath } = require("../src/security/command-lookup");
const { ownedTempRoot, withEnv } = require("./helpers/isolated");

test("execution-node shell isolation capability is explicit and does not disclose host paths", () => {
  assert.deepEqual(shellIsolationStatus("win32"), {
    backend: "bubblewrap",
    configured: false,
    code: "unsupported_platform",
  });
  const status = shellIsolationStatus();
  assert.equal(status.backend, "bubblewrap");
  assert.equal(typeof status.configured, "boolean");
  assert.equal(status.configured ? status.code === null : typeof status.code === "string", true);
  assert.deepEqual(Object.keys(status).sort(), ["backend", "code", "configured"]);
  assert.doesNotMatch(JSON.stringify(status), /[A-Za-z]:\\|\/usr\/|\/home\//, "isolation diagnostics must not reveal binary or workspace paths");
});

test("execution-node binary discovery inspects PATH without launching helper processes", async () => {
  const owned = await ownedTempRoot("sidekick-node-binaries-");
  try {
    const ext = process.platform === "win32" ? ".EXE" : "";
    const executable = path.join(owned.path, `node${ext}`);
    const nonExecutable = path.join(owned.path, `git${ext}`);
    await fs.writeFile(executable, "synthetic executable");
    await fs.writeFile(nonExecutable, "synthetic non-executable");
    if (process.platform !== "win32") await fs.chmod(executable, 0o700);

    await withEnv({ PATH: owned.path, PATHEXT: ".EXE;.CMD" }, async () => {
      assert.equal(commandOnPath("node"), true);
      assert.equal(resolveCommandOnPath("node"), executable, "lookup returns the exact absolute executable used by callers");
      assert.equal(resolveCommandOnPath("../node"), null, "command names cannot include path traversal");
      assert.equal(commandOnPath("git"), process.platform === "win32");
      assert.deepEqual(binaries().includes("node"), true);
      assert.deepEqual(binaries().includes("npm"), false);
      assert.equal(commandOnPath("node", "."), false, "relative PATH components are ignored");
      if (process.platform === "win32") assert.equal(commandOnPath("node", owned.path, "..\\evil"), false, "untrusted PATHEXT entries cannot escape PATH directories");
    });
  } finally {
    await owned.cleanup();
  }
});
