"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const path = require("node:path");
const compose = require("../packs/container-operations/modules/container-operations-tools/lib/compose");
const { ownedTempRoot, withEnv } = require("./helpers/isolated");

test("Compose validation launches with a filtered service environment", async () => {
  const owned = await ownedTempRoot("sidekick-compose-env-");
  try {
    const file = path.join(owned.path, "compose.yml");
    let invocation;
    const fakeSpawn = (binary, args, options) => {
      invocation = { binary, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
      });
      return child;
    };
    await withEnv({
      SIDEKICK_API_KEY: "SYNTHETIC_COMPOSE_SERVICE_SECRET",
      NODE_OPTIONS: "--require synthetic-hook",
      GIT_DIR: "C:\\synthetic\\foreign-repository",
    }, async () => {
      const result = await compose.run({ provider: "docker" }, file, "validate", 1000, fakeSpawn);
      assert.equal(result.ok, true);
    });
    assert.equal(invocation.binary, "docker");
    assert.deepEqual(invocation.args, ["compose", "-f", file, "config", "--quiet"]);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.SIDEKICK_API_KEY, undefined);
    assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
    assert.equal(invocation.options.env.GIT_DIR, undefined);
    assert.ok(invocation.options.env.PATH, "the filtered environment retains tool discovery for legitimate Docker/Podman operations");
  } finally {
    await owned.cleanup();
  }
});

test("real Compose launcher does not pass service secrets to its child", {
  skip: process.platform === "win32" ? "POSIX executable fixture is unavailable on Windows" : false,
}, async () => {
  const owned = await ownedTempRoot("sidekick-compose-child-");
  try {
    const marker = path.join(owned.path, "leaked.txt");
    const file = path.join(owned.path, "compose.yml");
    const binary = path.join(owned.path, "docker");
    await fs.writeFile(binary, [
      "#!/bin/sh",
      '[ -n "${SIDEKICK_API_KEY:-}" ] && printf secret >> "$COMPOSE_TEST_MARKER"',
      '[ -n "${NODE_OPTIONS:-}" ] && printf loader >> "$COMPOSE_TEST_MARKER"',
      "exit 0",
      "",
    ].join("\n"), { mode: 0o700 });
    const originalPath = process.env.PATH || "";
    await withEnv({
      PATH: `${owned.path}${path.delimiter}${originalPath}`,
      COMPOSE_TEST_MARKER: marker,
      SIDEKICK_API_KEY: "SYNTHETIC_COMPOSE_SERVICE_SECRET",
      NODE_OPTIONS: "--require synthetic-hook",
    }, async () => {
      const result = await compose.run({ provider: "docker" }, file, "validate", 1000);
      assert.equal(result.ok, true);
    });
    await assert.rejects(() => fs.access(marker), { code: "ENOENT" });
  } finally {
    await owned.cleanup();
  }
});
