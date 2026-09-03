"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const http = require("node:http");

async function ownedTempRoot(prefix = "sidekick-test-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  let released = false;
  return {
    path: root,
    async cleanup() {
      if (released) return;
      released = true;
      const tmp = path.resolve(os.tmpdir());
      const target = path.resolve(root);
      assert.equal(path.dirname(target), tmp, "cleanup target must be a direct test temp child");
      await fs.rm(target, { recursive: true, force: true });
    }
  };
}

async function withEnv(values, fn) {
  const before = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = String(value);
    }
    return await fn();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function ephemeralHttpServer(handler = (_req, res) => res.end("ok")) {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}`, async close() { await new Promise(resolve => server.close(resolve)); } };
}

function captureOutput() {
  const stdout = [], stderr = [];
  return { stdout, stderr, out: value => stdout.push(String(value)), err: value => stderr.push(String(value)), text() { return [...stdout, ...stderr].join("\n"); } };
}

module.exports = { ownedTempRoot, withEnv, ephemeralHttpServer, captureOutput };
