const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.SIDEKICK_API_KEY = "mcp-v2-runtime-test-key";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-mcp-v2-"));
process.env.SIDEKICK_DATA_DIR = dataDir;

console.log("MCP v2 test: loading Sidekick");
const { app } = require("../src/index");
console.log("MCP v2 test: Sidekick loaded");

function modernRequest(port, id, method, params, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      authorization: "Bearer mcp-v2-runtime-test-key",
      ...(headers.name ? { "Mcp-Name": headers.name } : {})
    },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {
      ...(params || {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "sidekick-v2-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    } })
  });
}

(async () => {
  const server = app.listen(0, "127.0.0.1");
  let passed = false;
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const port = server.address().port;

    console.log("MCP v2 test: discovery");
    const discoverResponse = await modernRequest(port, 1, "server/discover", {});
    assert.strictEqual(discoverResponse.status, 200);
    const discover = await discoverResponse.json();
    assert.ok(discover.result.supportedVersions.includes("2026-07-28"));
    assert.strictEqual(discover.result.capabilities.tools.listChanged, true);

    console.log("MCP v2 test: tools/list");
    const listResponse = await modernRequest(port, 2, "tools/list", {});
    assert.strictEqual(listResponse.status, 200);
    const list = await listResponse.json();
    const tools = list.result.tools;
    assert.ok(tools.length > 0);
    const readTool = tools.find(tool => tool.name === "read");
    const destructiveTool = tools.find(tool => tool.name === "delete");
    assert.ok(readTool && destructiveTool);
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.strictEqual(typeof readTool.annotations[key], "boolean", `read annotations.${key}`);
      assert.strictEqual(typeof destructiveTool.annotations[key], "boolean", `delete annotations.${key}`);
    }
    assert.strictEqual(readTool.annotations.readOnlyHint, true);
    assert.strictEqual(destructiveTool.annotations.destructiveHint, true);

    console.log("MCP v2 test: tools/call");
    const callResponse = await modernRequest(port, 3, "tools/call", { name: "tools", arguments: { action: "get", name: "read" } }, { name: "tools" });
    assert.strictEqual(callResponse.status, 200);
    const call = await callResponse.json();
    assert.ok(!call.error, JSON.stringify(call));
    assert.ok(Array.isArray(call.result.content));
    console.log("MCP v2 runtime: discovery, tool listing, annotations, and governed invocation passed");
    passed = true;
  } finally {
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
  if (passed) process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
