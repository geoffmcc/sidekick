"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CLI = process.env.SIDEKICK_CLI || path.join(ROOT, "src", "cli.js");

function frame(message) {
  return Buffer.from(JSON.stringify(message) + "\n", "utf8");
}

function launch(home) {
  const child = spawn(process.execPath, [CLI], {
    cwd: os.tmpdir(),
    env: { ...process.env, SIDEKICK_HOME: home, SIDEKICK_DATA_DIR: "", NODE_ENV: "production" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = Buffer.alloc(0);
  let diagnostics = "";
  const messages = [];
  child.stdout.on("data", chunk => {
    output = Buffer.concat([output, chunk]);
    while (true) {
      const newline = output.indexOf(10);
      if (newline < 0) break;
      const body = output.subarray(0, newline).toString("utf8");
      output = output.subarray(newline + 1);
      messages.push(JSON.parse(body));
    }
  });
  child.stderr.on("data", chunk => { diagnostics += chunk.toString(); });
  return { child, messages, getOutput: () => output, getDiagnostics: () => diagnostics };
}

function waitForMessage(runtime, id, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = runtime.messages.find(message => message.id === id);
      if (found) return resolve(found);
      if (runtime.child.exitCode !== null) return reject(new Error(`Sidekick exited (${runtime.child.exitCode}): ${runtime.getDiagnostics()}`));
      if (Date.now() - started > timeoutMs) {
        runtime.child.kill();
        return reject(new Error(`Timed out waiting for MCP response ${id}: ${runtime.getDiagnostics()}`));
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function request(runtime, id, method, params) {
  runtime.child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
  return waitForMessage(runtime, id);
}

async function stop(runtime) {
  if (runtime.child.exitCode === null) runtime.child.kill("SIGTERM");
  await new Promise(resolve => runtime.child.once("close", resolve));
  assert.strictEqual(runtime.getOutput().length, 0, "stdout had an incomplete/non-MCP trailing frame");
}

function setupProcess(home) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, "setup"], {
      cwd: os.tmpdir(),
      env: { ...process.env, SIDEKICK_HOME: home, SIDEKICK_DATA_DIR: "", NODE_ENV: "production" }
    }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve({ stdout, stderr }));
  });
}

let activeRuntime;
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-stdio-"));
  let runtime = launch(home);
  activeRuntime = runtime;
  const init = await request(runtime, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sidekick-local-test", version: "1" }
  });
  assert.strictEqual(init.result.serverInfo.name, "sidekick-mcp-server");
  assert.ok(init.result.capabilities.tools, "MCP tools capability missing");
  const listed = await request(runtime, 2, "tools/list", {});
  const names = listed.result.tools.map(tool => tool.name);
  assert.ok(names.includes("store"), "canonical store tool is not exposed over stdio");
  assert.ok(names.includes("handoff"), "canonical handoff tool is not exposed over stdio");
  const storeSchema = listed.result.tools.find(tool => tool.name === "store").inputSchema;
  assert.ok(storeSchema.properties.key && storeSchema.properties.value, "tool schema was not exposed");
  const stored = await request(runtime, 3, "tools/call", { name: "store", arguments: { key: "stdio-persistence", value: "survives-restart", project: "local_test" } });
  assert.ok(!stored.error && !stored.result?.isError, `governed store call failed: ${JSON.stringify(stored)}`);
  const handoff = await request(runtime, 4, "tools/call", { name: "handoff", arguments: { action: "create", project: "local_test", title: "stdio test", content: "durable handoff" } });
  assert.ok(!handoff.error && !handoff.result?.isError, `governed handoff call failed: ${JSON.stringify(handoff)}`);
  await stop(runtime);

  runtime = launch(home);
  activeRuntime = runtime;
  const get = await request(runtime, 5, "tools/call", { name: "get", arguments: { key: "stdio-persistence" } });
  assert.ok(!get.error && !get.result?.isError, "persisted value could not be retrieved after restart");
  assert.match(JSON.stringify(get), /survives-restart/);
  const denied = await request(runtime, 6, "tools/call", { name: "bash", arguments: { command: "echo should-not-run" } });
  assert.ok(denied.result?.isError || denied.error, "approval/policy-gated local call unexpectedly succeeded");
  await stop(runtime);
  assert.ok(fs.existsSync(path.join(home, "data", "sidekick.db")), "persistent database was not outside the package/cache");
  await Promise.all([setupProcess(home), setupProcess(home)]);
  assert.ok(fs.existsSync(path.join(home, "data")), "concurrent bootstrap removed the local data directory");
  fs.rmSync(home, { recursive: true, force: true });
  console.log("local stdio tests passed");
})().catch(error => {
  if (activeRuntime?.child?.exitCode === null) activeRuntime.child.kill();
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
