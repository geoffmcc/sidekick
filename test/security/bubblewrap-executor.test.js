"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { after, test } = require("node:test");
const executor = require("../../src/core/bubblewrap-executor");

const envNames = ["SIDEKICK_ALLOWED_PATHS", "SIDEKICK_DENIED_PATHS", "SIDEKICK_MCP_ALLOWED_PATHS", "SIDEKICK_MCP_DENIED_PATHS", "BWRAP_SYNTHETIC_SECRET"];
const originalEnv = new Map(envNames.map(name => [name, process.env[name]]));
let fixtureRoot = null;

function removeOwnedTree(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    const target = path.join(root, entry);
    if (fs.lstatSync(target).isDirectory()) removeOwnedTree(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(root);
}

function restoreEnvironment() {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

after(() => {
  restoreEnvironment();
  if (fixtureRoot) removeOwnedTree(fixtureRoot);
});

test("unsupported platforms fail closed without starting a host shell", () => {
  if (process.platform === "linux") return;
  assert.throws(() => executor.buildBubblewrapArgs({ command: "echo must-not-run" }), error => error.code === "isolation_unavailable");
});

test("missing Linux isolation backend fails closed", () => {
  if (process.platform !== "linux") return;
  assert.throws(
    () => executor.resolveBubblewrap("/sidekick-test-missing/bwrap"),
    error => error.code === "isolation_unavailable"
  );
});

test("bubblewrap starts only after namespace setup and clears inherited environment", { skip: process.platform !== "linux" || !fs.existsSync(executor.DEFAULT_BWRAP) }, async () => {
  process.env.BWRAP_SYNTHETIC_SECRET = "never-visible-to-child";
  const result = await executor.runBubblewrap({
    command: 'test -z "$BWRAP_SYNTHETIC_SECRET" && printf isolated-command-ok',
    source: "mcp",
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "isolated-command-ok");
});

test("workspace binding permits scoped writes and hides unrelated host files and network", { skip: process.platform !== "linux" || !fs.existsSync(executor.DEFAULT_BWRAP) }, async () => {
  fixtureRoot = fs.mkdtempSync(path.join("/var/tmp", "sidekick-bwrap-test-"));
  const workspace = path.join(fixtureRoot, "workspace");
  const outside = path.join(fixtureRoot, "outside.txt");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "input.txt"), "authorized-workspace\n");
  fs.writeFileSync(outside, "outside-sentinel\n");
  process.env.SIDEKICK_ALLOWED_PATHS = workspace;
  process.env.SIDEKICK_DENIED_PATHS = outside;

  const command = `grep -qx authorized-workspace input.txt && printf workspace-write > output.txt && test ! -e ${shellQuote(outside)}`;
  const result = await executor.runBubblewrap({ command, workspace, source: "mcp" });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(workspace, "output.txt"), "utf8"), "workspace-write");

  const server = http.createServer((_req, res) => res.end("host-network-visible"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = `const net=require("node:net");const s=net.connect(${port},"127.0.0.1");s.setTimeout(500);s.on("connect",()=>{console.error("HOST_NETWORK_VISIBLE");process.exit(9)});s.on("error",()=>{console.log("NETWORK_ISOLATED")});s.on("timeout",()=>{console.error("NETWORK_TIMEOUT");process.exit(8)})`;
  try {
    const network = await executor.runBubblewrap({ command: `/usr/bin/node -e ${shellQuote(client)}`, source: "mcp" });
    assert.equal(network.exitCode, 0, network.stderr);
    assert.equal(network.stdout.trim(), "NETWORK_ISOLATED");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("nested isolated commands remain inside the parent namespace", { skip: process.platform !== "linux" || !fs.existsSync(executor.DEFAULT_BWRAP) }, async () => {
  const repository = fs.realpathSync(path.resolve(__dirname, "../.."));
  process.env.SIDEKICK_ALLOWED_PATHS = repository;
  process.env.SIDEKICK_DENIED_PATHS = "";
  const nested = 'const executor=require("/workspace/src/core/bubblewrap-executor.js");executor.runBubblewrap({command:"printf nested-namespace-ok"}).then(result=>{if(result.exitCode!==0){console.error(result.stderr);process.exit(9)}process.stdout.write(result.stdout)}).catch(error=>{console.error(error.code);process.exit(10)})';
  const result = await executor.runBubblewrap({
    command: `/usr/bin/node -e ${shellQuote(nested)}`,
    workspace: repository,
    source: "mcp",
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "nested-namespace-ok");
});

test("workspace binding refuses a directory that contains a denied subtree", () => {
  if (process.platform !== "linux") return;
  fixtureRoot ||= fs.mkdtempSync(path.join("/var/tmp", "sidekick-bwrap-deny-"));
  const workspace = path.join(fixtureRoot, "tree");
  const denied = path.join(workspace, "private");
  fs.mkdirSync(denied, { recursive: true });
  process.env.SIDEKICK_ALLOWED_PATHS = workspace;
  process.env.SIDEKICK_DENIED_PATHS = denied;
  assert.throws(() => executor.buildBubblewrapArgs({ command: "true", workspace, source: "mcp" }), error => error.code === "workspace_denied");
});
